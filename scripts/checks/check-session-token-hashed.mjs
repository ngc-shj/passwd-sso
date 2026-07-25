#!/usr/bin/env node
/**
 * H4 CI guard (AST, ts-morph): the Session.sessionToken column stores an HMAC
 * digest, never the raw cookie token. Every Prisma `session` operation keyed on
 * `sessionToken` must therefore use the digest — a bare raw cookie token in a
 * `where: { sessionToken }` / `data: { sessionToken }` re-introduces the removed
 * plaintext lookup and silently breaks auth (raw ≠ stored digest). The
 * new-device-detection false-"new device" bug (a raw `{ not: currentSessionToken }`)
 * is the exact regression this catches.
 *
 * AST, not grep (per repo rule: classification gates are AST-first — grep misses
 * multi-line Prisma calls and false-positives on cookie-config / type nodes):
 * for every CallExpression whose callee is `<recv>.session.<op>` with op in
 * {findUnique, findFirst, findMany, update, updateMany, delete, deleteMany,
 *  create, upsert, count}, inspect the value node bound to a `sessionToken`
 * property inside the call's `where` / `data` object (including a nested
 * `{ not: <value> }`). A value is SAFE when it is:
 *   - a call to hashSessionToken(...)                        (explicit hash)
 *   - an identifier whose name ends in "Digest"             (getSessionTokenDigest output)
 *   - a property access ending in `.sessionToken`           (a value SELECTed from the DB → already a digest)
 *   - `true`                                                (a `select` projection, not a value)
 * Anything else FAILS and must be reviewed.
 *
 * Runs without a Program (in-memory project, per project_ast_guard_tsmorph_no_program).
 */
import { Project, SyntaxKind, ts } from "ts-morph";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SESSION_TOKEN_HASHED_ROOT
  ? process.env.SESSION_TOKEN_HASHED_ROOT
  : join(__dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

console.log(`check-session-token-hashed: SRC_DIR=${SRC_DIR}`);

const SESSION_OPS = new Set([
  "findUnique", "findFirst", "findMany", "update", "updateMany",
  "delete", "deleteMany", "create", "upsert", "count",
]);

// Files that are the SOURCE of the digest transform (define the hash / cookie
// boundary), not consumers of a raw token in a DB op.
const EXCLUDE = new Set([
  "src/lib/auth/session/session-cache.ts",
  "src/app/api/sessions/helpers.ts",
]);

const project = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX },
});

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(full)); continue; }
    if (!e.isFile()) continue;
    const ext = extname(e.name);
    if (ext !== ".ts" && ext !== ".tsx") continue;
    if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx")) continue;
    if (full.includes(`${join(dir, "__tests__")}`) || full.split(/[/\\]/).includes("__tests__")) continue;
    out.push(full);
  }
  return out;
}

// True when a `<recv>.session.<op>(...)` call node.
function isSessionOpCall(call) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const op = callee.getName();
  if (!SESSION_OPS.has(op)) return false;
  const recv = callee.getExpression();
  // recv must be `<something>.session`
  if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  return recv.getName() === "session";
}

// Functions whose return value is a session-token DIGEST (the digest boundary).
const DIGEST_PRODUCERS = new Set([
  "hashSessionToken",
  "getSessionTokenDigest",
  "getSessionTokenDigestFromCookieStore",
]);

// True when a CallExpression node produces a digest.
function isHashCall(node) {
  if (!node || node.getKind() !== SyntaxKind.CallExpression) return false;
  const expr = node.getExpression();
  const name = expr.getKind() === SyntaxKind.PropertyAccessExpression
    ? expr.getName()
    : expr.getText();
  return DIGEST_PRODUCERS.has(name);
}

// Resolve an identifier to its initializer within the same source file and check
// whether it is (transitively) a hashSessionToken(...) result. Handles the common
// `const digest = hashSessionToken(raw)` and
// `const d = cond ? null : hashSessionToken(raw)` shapes without a type Program.
function identifierResolvesToDigest(idNode, sf, seen = new Set()) {
  const name = idNode.getText();
  if (seen.has(name)) return false;
  seen.add(name);
  // Find a VariableDeclaration for this name in the file.
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = decl.getNameNode();
    if (!nameNode || nameNode.getText() !== name) continue;
    const init = decl.getInitializer();
    if (!init) return false;
    if (isHashCall(init)) return true;
    // ternary: `x == null ? null : hashSessionToken(raw)`
    if (init.getKind() === SyntaxKind.ConditionalExpression) {
      const whenT = init.getWhenTrue?.();
      const whenF = init.getWhenFalse?.();
      if (isHashCall(whenT) || isHashCall(whenF)) return true;
    }
    // alias: `const d = otherDigestVar`
    if (init.getKind() === SyntaxKind.Identifier) {
      return identifierResolvesToDigest(init, sf, seen);
    }
    return false;
  }
  return false;
}

// Is this value node a SAFE (digest) form?
function isSafeValue(node, sf) {
  if (!node) return false;
  const k = node.getKind();
  if (isHashCall(node)) return true;
  // identifier: resolve its binding to a hashSessionToken(...) result.
  if (k === SyntaxKind.Identifier) {
    return identifierResolvesToDigest(node, sf);
  }
  // `.sessionToken` property access → value SELECTed back from the DB (digest)
  if (k === SyntaxKind.PropertyAccessExpression) {
    return node.getName() === "sessionToken";
  }
  // `true` → a `select` projection, not a value
  if (k === SyntaxKind.TrueKeyword) return true;
  return false;
}

// Given the value node bound to a `sessionToken:` property, resolve to the node
// that must be safe. If it is `{ not: <value> }`, unwrap to <value>.
function resolveGuardedValue(valueNode) {
  if (valueNode && valueNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const notProp = valueNode.getProperty?.("not");
    if (notProp && notProp.getKind() === SyntaxKind.PropertyAssignment) {
      return notProp.getInitializer();
    }
  }
  return valueNode;
}

const violations = [];

for (const file of walk(SRC_DIR)) {
  const rel = relative(REPO_ROOT, file).split("\\").join("/");
  if (EXCLUDE.has(rel)) continue;
  const sf = project.createSourceFile(rel, readFileSync(file, "utf8"), { overwrite: true });

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isSessionOpCall(call)) continue;

    // Find `sessionToken:` property assignments inside this call's argument
    // object(s) (where / data), scoped to this call (skip nested session calls).
    for (const pa of call.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (pa.getName() !== "sessionToken") continue;
      // Ensure the nearest session-op CallExpression ancestor is THIS call
      // (so a nested tx.session.X inside the args is attributed to itself).
      const owner = pa.getFirstAncestor(
        (a) => a.getKind() === SyntaxKind.CallExpression && isSessionOpCall(a),
      );
      if (owner !== call) continue;

      const guarded = resolveGuardedValue(pa.getInitializer());
      if (isSafeValue(guarded, sf)) continue;

      violations.push({
        rel,
        line: pa.getStartLineNumber(),
        text: pa.getText().replace(/\s+/g, " ").slice(0, 100),
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Session DB op keyed on a possibly-RAW token (must be a digest — H4):");
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.text}`);
  }
  console.error("");
  console.error(`FAIL: ${violations.length} site(s). Use hashSessionToken(raw) /`);
  console.error("getSessionTokenDigest(req), or a value SELECTed from the DB (a *Digest).");
  process.exit(1);
}

console.log("OK (all session DB ops key on a digest)");
