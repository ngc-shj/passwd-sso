#!/usr/bin/env node
/**
 * M2 CI guard (AST, ts-morph): every checkIpRateLimit call site must bound its
 * IP-less traffic — `boundUnknownIp: true` (shared budget) or an explicit
 * `unknownIpLimiter` — UNLESS its scope is on the documented exclusion manifest.
 *
 * Why (R42 completeness): the boundUnknownIp opt-in set was originally
 * hand-derived and MISSED the magic-link signin gate, which kept failing OPEN on
 * IP-less requests (per-IP SMTP-DoS cap bypassable). A hand-listed security class
 * accretes gaps after review. This gate derives the class MECHANICALLY from the
 * primitive (every checkIpRateLimit call) and fails when a new caller ships
 * unbound and unlisted — the next missed member cannot ship green.
 *
 * Completeness is enforced BOTH ways:
 *   - an unbound scope NOT in excluded_scopes  → FAIL (a real gap)
 *   - a manifest scope that no longer appears  → FAIL (stale entry)
 *   - a manifest scope that IS now bound        → FAIL (stale entry; drop it)
 *
 * AST, not grep (per repo rule): reads the scope string literal and the
 * boundUnknownIp / unknownIpLimiter properties of each call's argument object,
 * so a multi-line call or a scope on a different line is handled exactly.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFiles } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.BOUND_UNKNOWN_IP_ROOT
  ? process.env.BOUND_UNKNOWN_IP_ROOT
  : join(__dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const MANIFEST_PATH = process.env.BOUND_UNKNOWN_IP_MANIFEST
  ? process.env.BOUND_UNKNOWN_IP_MANIFEST
  : join(__dirname, "bound-unknown-ip-manifest.json");

console.log(`check-bound-unknown-ip: SRC_DIR=${SRC_DIR} MANIFEST=${MANIFEST_PATH}`);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const excludedScopes = new Set(Object.keys(manifest.excluded_scopes ?? {}));

const project = createAstProject();

// Read a string-literal property (e.g. scope:) from an object literal.
function stringProp(obj, name) {
  const p = obj.getProperty?.(name);
  if (!p || p.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = p.getInitializer();
  if (!init) return null;
  const k = init.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return init.getLiteralText?.() ?? init.getText().replace(/^["'`]|["'`]$/g, "");
  }
  return null;
}

// True when the object literal binds IP-less traffic: `boundUnknownIp: true`
// (any truthy literal) OR an explicit `unknownIpLimiter` property.
function isBound(obj) {
  if (obj.getProperty?.("unknownIpLimiter")) return true;
  const p = obj.getProperty?.("boundUnknownIp");
  if (!p || p.getKind() !== SyntaxKind.PropertyAssignment) return false;
  const init = p.getInitializer();
  return !!init && init.getKind() === SyntaxKind.TrueKeyword;
}

const foundScopes = new Set();      // every scope that appears in a checkIpRateLimit call
const boundScopes = new Set();      // scopes with the bound property
const violations = [];              // unbound + not excluded

for (const { rel, sf } of sourceFiles(project, SRC_DIR, REPO_ROOT)) {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.getKind() === SyntaxKind.PropertyAccessExpression
      ? callee.getName()
      : callee.getText();
    if (name !== "checkIpRateLimit") continue;

    const arg = call.getArguments()[0];
    if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
      violations.push({ rel, line: call.getStartLineNumber(), scope: "<non-literal args>" });
      continue;
    }
    const scope = stringProp(arg, "scope");
    if (!scope) {
      violations.push({ rel, line: call.getStartLineNumber(), scope: "<dynamic scope>" });
      continue;
    }
    foundScopes.add(scope);
    if (isBound(arg)) {
      boundScopes.add(scope);
      continue;
    }
    if (!excludedScopes.has(scope)) {
      violations.push({ rel, line: call.getStartLineNumber(), scope });
    }
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error("Unbound checkIpRateLimit site(s) — IP-less traffic fails OPEN (M2):");
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  scope="${v.scope}"`);
  }
  console.error("Add `boundUnknownIp: true`, or list the scope in bound-unknown-ip-manifest.json with a reason.");
}

// Stale-manifest completeness: every excluded scope must still appear AND still
// be unbound. A scope that vanished or is now bound is a stale exclusion.
for (const scope of excludedScopes) {
  if (!foundScopes.has(scope)) {
    failed = true;
    console.error(`Stale manifest entry: excluded scope "${scope}" no longer appears in any checkIpRateLimit call — remove it.`);
  } else if (boundScopes.has(scope)) {
    failed = true;
    console.error(`Stale manifest entry: excluded scope "${scope}" is now bound — remove it from the exclusion manifest.`);
  }
}

if (failed) {
  console.error("");
  console.error("FAIL: boundUnknownIp class incomplete or manifest stale.");
  process.exit(1);
}

console.log(
  `OK (${foundScopes.size} checkIpRateLimit scopes: ${boundScopes.size} bound, ${excludedScopes.size} documented-exclusion)`,
);
