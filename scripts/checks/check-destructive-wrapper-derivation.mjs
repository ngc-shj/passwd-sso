#!/usr/bin/env node
/**
 * CI guard: the destructive-wrapper set in route-class-patterns.json#deleteSignal
 * must be code-derived, not hand-curated (plan: security-control-verification, C4).
 *
 * Background: deleteSignal mixes raw Prisma primitives (passwordEntry.delete,
 * team.delete, ...) with hand-added wrapper function names (executeVaultReset,
 * deleteTeamPassword). Nothing enforced that a NEW wrapper introduced elsewhere
 * in the codebase gets added to deleteSignal — a service function wrapping
 * passwordEntry.deleteMany() that check-permanent-delete-stepup.sh does not
 * know about would let a route call it and evade step-up classification
 * entirely. This check derives the wrapper set from code instead.
 *
 * Scan scope: ALL production `src/**\/*.ts` EXCLUDING `route.ts` (the route
 * itself is governed directly by check-permanent-delete-stepup.sh) and test
 * files (`*.test.*`, `__tests__`). Widened to all of src/ (not just src/lib +
 * src/workers) so a wrapper defined in e.g. src/app/api/x/helpers.ts cannot
 * evade derivation.
 *
 * Raw destructive-delete primitives (subset of deleteSignal minus wrapper
 * names): passwordEntry.delete(Many)?(, teamPasswordEntry.delete(Many)?(,
 * team.delete(, user.delete(. The parent-cascade rationale for team.delete /
 * user.delete is documented in route-class-patterns.json's
 * $deleteSignal-parent-cascades key (derived from prisma/schema.prisma
 * onDelete: Cascade relations; tenant.delete is excluded — Restrict).
 *
 * For each hit, resolve the enclosing EXPORTED function via ts-morph (no
 * Program — same no-type-resolution precedent as
 * src/__tests__/proxy/ast-guards.ts / scripts/check-state-mutation-centralization.ts).
 * Pass criteria per resolved function:
 *   (a) its name is matched by deleteSignal (any route calling it already
 *       classifies as destructive), OR
 *   (b) it is listed in destructive-wrapper-exempt.txt as `path#functionName`
 *       (exact match) with a reason.
 * Fail: UNDECLARED_DESTRUCTIVE_WRAPPER: <file>#<function>
 *
 * Inverse: every identifier-like alternative in deleteSignal that is NOT one
 * of the raw Prisma primitives above (i.e. executeVaultReset, deleteTeamPassword
 * today) must resolve to an existing exported function somewhere in scope —
 * otherwise STALE_DELETE_SIGNAL_NAME: <name> (the wrapper was renamed/removed
 * but deleteSignal still names the old identifier, silently narrowing the
 * step-up guard's coverage).
 *
 * Stale exempt: an exempt `path#function` entry that no longer resolves to an
 * existing exported function → STALE_WRAPPER_EXEMPT: <entry>.
 *
 * Env overrides (mirrors STEPUP_GUARD_* / RAW_SQL_CHECK_* conventions):
 *   DESTRUCTIVE_WRAPPER_SCAN_ROOT     — default: <repo>/src
 *   DESTRUCTIVE_WRAPPER_PATH_ROOT     — default: <repo> (repo-relative key prefix)
 *   DESTRUCTIVE_WRAPPER_EXEMPT_FILE   — default: <repo>/scripts/checks/destructive-wrapper-exempt.txt
 *   DESTRUCTIVE_WRAPPER_PATTERNS_FILE — default: <repo>/scripts/checks/route-class-patterns.json
 *     (STEPUP_GUARD_PATTERNS_FILE precedent — needed so a self-test fixture
 *     tree can supply its own deleteSignal without the real repo's
 *     executeVaultReset/deleteTeamPassword wrapper names forcing
 *     STALE_DELETE_SIGNAL_NAME on every isolated fixture run.)
 *
 * sec-F6 env-pollution guard: when CI=true and any override is set, require
 * DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1 or exit 1.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Project, Node, SyntaxKind } from "ts-morph";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return REPO_ROOT;
  }
}

const ROOT = repoRoot();
const SCAN_ROOT = process.env.DESTRUCTIVE_WRAPPER_SCAN_ROOT ?? join(ROOT, "src");
const EXEMPT_FILE =
  process.env.DESTRUCTIVE_WRAPPER_EXEMPT_FILE ??
  join(ROOT, "scripts/checks/destructive-wrapper-exempt.txt");
// PATH_ROOT: keys (file#function) are reported/matched relative to this root,
// NOT SCAN_ROOT — mirrors check-permanent-delete-stepup.sh's PATH_ROOT vs
// API_DIR split, so a fixture SCAN_ROOT (e.g. <tmp>/src) still produces
// repo-relative keys like "src/lib/x.ts#fn" matching the exempt file's
// real-repo path convention. Defaults to ROOT so production keys are exactly
// "src/...".
const PATH_ROOT = process.env.DESTRUCTIVE_WRAPPER_PATH_ROOT ?? ROOT;
const PATTERNS_FILE =
  process.env.DESTRUCTIVE_WRAPPER_PATTERNS_FILE ??
  join(ROOT, "scripts/checks/route-class-patterns.json");

// CI-auditable: print effective paths on one line.
console.log(
  `check-destructive-wrapper-derivation: SCAN_ROOT=${SCAN_ROOT} EXEMPT_FILE=${EXEMPT_FILE} PATH_ROOT=${PATH_ROOT} PATTERNS_FILE=${PATTERNS_FILE}`,
);

// sec-F6: env-pollution guard.
if (process.env.CI === "true") {
  const overridden =
    process.env.DESTRUCTIVE_WRAPPER_SCAN_ROOT !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_EXEMPT_FILE !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_PATH_ROOT !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_PATTERNS_FILE !== undefined;
  if (overridden && process.env.DESTRUCTIVE_WRAPPER_FIXTURE_MODE !== "1") {
    console.error(
      "ENV_POLLUTION_GUARD: DESTRUCTIVE_WRAPPER_* override set under CI=true without DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path.",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared pattern source (route-class-patterns.json) — same fail-closed
// non-empty-string assertion as check-raw-sql-usage.mjs.
// ---------------------------------------------------------------------------
const patterns = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
if (typeof patterns.deleteSignal !== "string" || patterns.deleteSignal.length === 0) {
  console.error(
    `PATTERNS_FILE_INVALID: "deleteSignal" in ${PATTERNS_FILE} is missing or not a non-empty string.`,
  );
  process.exit(1);
}
const DELETE_SIGNAL_RE = new RegExp(patterns.deleteSignal);

// Raw Prisma/primitive alternatives within deleteSignal (the ones this check
// scans FOR), expressed as { receiver, methods } pairs: a call site matches
// iff its property-access base resolves to exactly `receiver` (e.g.
// `tx.passwordEntry`, `prisma.team`) and the called method is one of
// `methods`. Any deleteSignal alternative NOT represented here is a "wrapper
// name" subject to the inverse STALE_DELETE_SIGNAL_NAME check.
//
// Matching on the exact AST receiver property name (not text/endsWith
// heuristics) means the `[^A-Za-z0-9_]` boundary used in the grep-based
// deleteSignal regex (needed there to avoid a flat-text match on
// `teamMember.delete(`/`teamFolder.delete(`) is unnecessary here — an AST
// PropertyAccessExpression's name is exact, not a substring.
const RAW_PRIMITIVES = [
  { receiver: "passwordEntry", methods: ["delete", "deleteMany"] },
  { receiver: "teamPasswordEntry", methods: ["delete", "deleteMany"] },
  { receiver: "team", methods: ["delete"] },
  { receiver: "user", methods: ["delete"] },
];
// Coarse pre-filter regex (cheap `String.includes`-shaped scan) so files with
// no chance of a match skip the expensive ts-morph parse entirely. Kept
// permissive (no boundary/prefix requirements) — the AST check above is the
// source of truth for the actual match.
const SCAN_RE = new RegExp(
  RAW_PRIMITIVES.flatMap((p) => p.methods.map((m) => `${p.receiver}\\.${m}\\(`)).join("|"),
);

// Wrapper names named literally in deleteSignal: an alternative shaped as a
// bare call `<functionName>(` — no `.` property access, no `[^...]` boundary
// prefix — is a hand-added wrapper name, not one of the raw
// receiver.method(...) primitives in RAW_PRIMITIVES (all of which contain a
// literal `.`). Any alternative NOT matching this bare-call shape (i.e. every
// primitive alternative) is intentionally skipped here.
function extractDeleteSignalWrapperNames(deleteSignalSource) {
  const alternatives = deleteSignalSource.split("|");
  const names = [];
  for (const alt of alternatives) {
    // Bare wrapper: `deleteTeamPassword\(` -> "deleteTeamPassword".
    const bare = /^([A-Za-z0-9_]+)\\?\($/.exec(alt);
    if (bare) {
      names.push(bare[1]);
      continue;
    }
    // Qualified wrapper (object/class method): `vaultService\.purge\(` ->
    // "vaultService.purge". Matches the qualified key resolveEnclosingExported-
    // Function produces, so the inverse STALE check covers these too.
    const qualified = /^([A-Za-z0-9_]+)\\\.([A-Za-z0-9_]+)\\?\($/.exec(alt);
    if (qualified) names.push(`${qualified[1]}.${qualified[2]}`);
  }
  return names;
}
const WRAPPER_NAMES_IN_DELETE_SIGNAL = extractDeleteSignalWrapperNames(patterns.deleteSignal);

// ---------------------------------------------------------------------------
// Exempt file parsing — `path#functionName  # reason`. The key itself
// contains a literal `#` (path#function), so the REASON delimiter is
// specifically a `#` preceded by whitespace (a comment marker), not the
// first `#` on the line. Full-line comments (`#` as the first non-blank
// char) are skipped, mirroring check-permanent-delete-stepup.sh's exempt
// parser (MIN reason length 10).
// ---------------------------------------------------------------------------
const MIN_REASON_LENGTH = 10;
const REASON_DELIM_RE = /\s#(.*)$/;

function parseExemptFile(text) {
  const entries = []; // { key, reason, lineNo }
  const parseFailures = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;

    const reasonMatch = REASON_DELIM_RE.exec(raw);
    const key = (reasonMatch ? raw.slice(0, reasonMatch.index) : raw).trim();
    if (!key) continue;
    const reason = reasonMatch ? reasonMatch[1].trim() : "";
    if (reason.length < MIN_REASON_LENGTH) {
      parseFailures.push(`EXEMPT_NO_REASON: ${key} (line ${i + 1}) has no (or too short) reason.`);
    }
    entries.push({ key, reason, lineNo: i + 1 });
  }
  return { entries, parseFailures };
}

let exemptText = "";
if (existsSync(EXEMPT_FILE)) {
  exemptText = readFileSync(EXEMPT_FILE, "utf8");
}
const { entries: exemptEntries, parseFailures: exemptParseFailures } = parseExemptFile(exemptText);
const exemptKeys = new Set(exemptEntries.map((e) => e.key));

let failed = false;

if (exemptParseFailures.length > 0) {
  failed = true;
  console.error("destructive-wrapper-exempt.txt parse errors:");
  for (const f of exemptParseFailures) console.error(`  ${f}`);
}

// ---------------------------------------------------------------------------
// File discovery — production src/**/*.ts, excluding route.ts and tests.
// ---------------------------------------------------------------------------
const EXCLUDE_RE = /\.test\.|__tests__/;

function getSourceFiles(root, pathRoot) {
  const files = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return files;
    throw err;
  }
  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== ".ts") continue; // .tsx routes/components are not delete-primitive sites in this codebase
    if (entry.name === "route.ts") continue;
    const abs = join(entry.parentPath ?? entry.path, entry.name);
    // rel is PATH_ROOT-relative (repo-relative in production), not
    // SCAN_ROOT-relative — see PATH_ROOT comment above.
    const rel = abs.slice(pathRoot.length).replace(/^\/+/, "");
    if (EXCLUDE_RE.test(rel)) continue;
    files.push({ abs, rel });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

const sourceFiles = getSourceFiles(SCAN_ROOT, PATH_ROOT);

// ---------------------------------------------------------------------------
// ts-morph — resolve the enclosing EXPORTED function for a given source
// offset. No Program / type resolution needed (matches ast-guards.ts
// precedent): walk ancestors looking for a node that is itself an exported
// function-like declaration (FunctionDeclaration, or a VariableStatement
// `export const f = (...) => {}` / `export const f = async function () {}`).
// A delete call nested inside an object-literal method (e.g. an Auth.js
// adapter callback) resolves to the enclosing EXPORTED function that
// contains it, not the inner method itself (methods aren't independently
// exported/callable).
// ---------------------------------------------------------------------------
const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });

function isExportedFunctionDeclaration(node) {
  return Node.isFunctionDeclaration(node) && node.isExported() && node.getName() !== undefined;
}

function isExportedVariableWithFunctionInitializer(node) {
  if (!Node.isVariableDeclaration(node)) return false;
  const init = node.getInitializer();
  if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return false;
  const stmt = node.getVariableStatement();
  return stmt !== undefined && stmt.isExported();
}

function exportedFunctionName(node) {
  if (isExportedFunctionDeclaration(node)) return node.getName();
  if (isExportedVariableWithFunctionInitializer(node)) return node.getName();
  return undefined;
}

/**
 * A wrapper can be an exported top-level function OR a method reachable through
 * an exported object/class. The route-side call shape differs:
 *   - top-level function:      `purgeUserEntries(`      -> key `purgeUserEntries`
 *   - exported object method:  `vaultService.purge(`    -> key `vaultService.purge`
 *   - exported class method:   `new VaultService().purge(` or instance.purge(`
 *                                                       -> key `VaultService.purge`
 * The qualified `Receiver.method` key mirrors the actual route call token and
 * avoids same-name collisions across different services. deleteSignal / the
 * exempt file are matched against this same key. Anonymous default exports get
 * a file-scoped sentinel so they can never silently escape.
 */
function methodName(node) {
  // MethodDeclaration (class or object shorthand method) or a
  // PropertyAssignment whose initializer is an arrow/function expression
  // (object property arrow: `{ purge: async () => {} }`).
  if (Node.isMethodDeclaration(node)) {
    const name = node.getName();
    return name || undefined;
  }
  if (Node.isPropertyAssignment(node)) {
    const init = node.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const name = node.getName();
      return name || undefined;
    }
  }
  return undefined;
}

/** For a class-method node, the enclosing exported class name (or undefined). */
function enclosingExportedClassName(node) {
  let c = node;
  while (c) {
    if (Node.isClassDeclaration(c) && c.isExported()) return c.getName();
    c = c.getParent();
  }
  return undefined;
}

/**
 * For an object-method / object-property-arrow node, the name of the exported
 * `const <name> = { ... }` variable the object literal is bound to (or
 * undefined if the object literal is not directly bound to an exported const).
 */
function enclosingExportedObjectVarName(node) {
  let c = node;
  while (c) {
    if (Node.isVariableDeclaration(c)) {
      const init = c.getInitializer();
      if (init && Node.isObjectLiteralExpression(init)) {
        const stmt = c.getVariableStatement();
        if (stmt && stmt.isExported()) return c.getName();
      }
      return undefined; // bound to a non-exported / non-object decl — not reachable
    }
    c = c.getParent();
  }
  return undefined;
}

/** Walk up from `node` to the nearest ancestor that is an exported callable. */
function resolveEnclosingExportedFunction(node) {
  let current = node;
  while (current) {
    // 1. Top-level exported function / const-arrow.
    const fnName = exportedFunctionName(current);
    if (fnName !== undefined) return fnName;

    // 2. Class or object method reachable through an exported class/object.
    const mName = methodName(current);
    if (mName !== undefined) {
      const cls = enclosingExportedClassName(current);
      if (cls !== undefined) return `${cls}.${mName}`;
      const objVar = enclosingExportedObjectVarName(current);
      if (objVar !== undefined) return `${objVar}.${mName}`;
      // A method not reachable via an exported class/object is not
      // route-callable on its own — keep walking (it may sit inside an
      // exported outer function).
    }

    // 3. Anonymous default export: `export default async function () {…}` /
    //    `export default () => {…}`. Route-callable via the default import;
    //    give it a file-scoped sentinel so it can never silently escape.
    if (
      (Node.isFunctionDeclaration(current) ||
        Node.isArrowFunction(current) ||
        Node.isFunctionExpression(current)) &&
      isDefaultExported(current)
    ) {
      return "default";
    }

    current = current.getParent();
  }
  return undefined;
}

/** True when `node` is (or is the initializer of) an `export default`. */
function isDefaultExported(node) {
  // `export default function () {}` — the FunctionDeclaration has the modifier.
  if (
    Node.isFunctionDeclaration(node) &&
    node.getModifiers?.().some((m) => m.getKind() === SyntaxKind.DefaultKeyword)
  ) {
    return true;
  }
  // `export default () => {}` / `export default function(){}` as an expression:
  // the immediate parent is an ExportAssignment.
  const parent = node.getParent();
  return parent !== undefined && Node.isExportAssignment(parent);
}

const undeclaredWrappers = []; // { file, fn }
const resolvedWrapperKeys = new Set(); // "path#fn" for functions found matching deleteSignal by name

for (const { abs, rel } of sourceFiles) {
  const content = readFileSync(abs, "utf8");
  if (!SCAN_RE.test(content)) continue;

  let sf;
  try {
    sf = project.createSourceFile(rel, content, { overwrite: true });
  } catch {
    continue; // unparseable file — not this check's concern
  }

  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const seenFns = new Set();

  for (const call of callExprs) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const method = expr.getName(); // "delete" | "deleteMany" | ...

    // The receiver is the property/identifier immediately left of the method
    // (e.g. `tx.passwordEntry` -> "passwordEntry", `prisma.team` -> "team").
    // Using the AST's exact name (not text/endsWith) means `teamMember`,
    // `teamFolder`, `teamPasswordEntry` never collide with the bare `team`
    // receiver — no boundary-char heuristics needed (unlike the grep-based
    // deleteSignal regex, which needs `[^A-Za-z0-9_]` for exactly this
    // reason at the flat-text level).
    const receiverExpr = expr.getExpression();
    const receiverName = Node.isPropertyAccessExpression(receiverExpr)
      ? receiverExpr.getName()
      : Node.isIdentifier(receiverExpr)
        ? receiverExpr.getText()
        : undefined;
    if (receiverName === undefined) continue;

    const isPrimitiveCall = RAW_PRIMITIVES.some(
      (p) => p.receiver === receiverName && p.methods.includes(method),
    );
    if (!isPrimitiveCall) continue;

    const fnName = resolveEnclosingExportedFunction(call);
    if (fnName === undefined) continue; // not inside any exported function — not route-reachable, skip
    if (seenFns.has(fnName)) continue;
    seenFns.add(fnName);

    const key = `${rel}#${fnName}`;
    resolvedWrapperKeys.add(key);

    const matchesDeleteSignalByName = DELETE_SIGNAL_RE.test(`${fnName}(`);
    if (matchesDeleteSignalByName) continue; // declared — routes calling it classify correctly
    if (exemptKeys.has(key)) continue; // documented exemption

    undeclaredWrappers.push({ file: rel, fn: fnName });
  }
}

if (undeclaredWrappers.length > 0) {
  failed = true;
  console.error(
    "UNDECLARED_DESTRUCTIVE_WRAPPER: exported functions wrap a raw destructive-delete primitive but are neither matched by route-class-patterns.json#deleteSignal nor listed in destructive-wrapper-exempt.txt:",
  );
  for (const w of undeclaredWrappers) {
    console.error(`  UNDECLARED_DESTRUCTIVE_WRAPPER: ${w.file}#${w.fn}`);
  }
  console.error(
    "\nEither add the function name as a deleteSignal alternative in route-class-patterns.json" +
      " (so calling routes classify as destructive) OR add `<file>#<function>  # reason` to" +
      " scripts/checks/destructive-wrapper-exempt.txt.",
  );
}

// ---------------------------------------------------------------------------
// Inverse: every wrapper name literally present in deleteSignal must resolve
// to an existing exported function somewhere in the scanned scope.
// ---------------------------------------------------------------------------
const resolvedNames = new Set([...resolvedWrapperKeys].map((k) => k.split("#")[1]));
const staleSignalNames = WRAPPER_NAMES_IN_DELETE_SIGNAL.filter((name) => !resolvedNames.has(name));
if (staleSignalNames.length > 0) {
  failed = true;
  console.error(
    "STALE_DELETE_SIGNAL_NAME: deleteSignal names a wrapper function that no longer resolves to any exported function calling a raw destructive-delete primitive in scope:",
  );
  for (const name of staleSignalNames) {
    console.error(`  STALE_DELETE_SIGNAL_NAME: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Stale exempt entries — path#function no longer resolves.
// ---------------------------------------------------------------------------
const staleExempt = exemptEntries.filter((e) => !resolvedWrapperKeys.has(e.key));
if (staleExempt.length > 0) {
  failed = true;
  console.error(
    "STALE_WRAPPER_EXEMPT: destructive-wrapper-exempt.txt lists an entry that no longer resolves to an exported function wrapping a raw destructive-delete primitive:",
  );
  for (const e of staleExempt) {
    console.error(`  STALE_WRAPPER_EXEMPT: ${e.key}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-destructive-wrapper-derivation: OK");
