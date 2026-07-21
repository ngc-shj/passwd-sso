#!/usr/bin/env node
/**
 * CI guard: null-tenant fail-open enforcement class - AST, per-read-site.
 *
 * An enforcement decision that reads a tenant security policy via
 * `tenant.findUnique({ select: { <enforcement field> } })` (or a relation join
 * `tenant: { select: ... }`) and, on a null row, falls back to the LENIENT side
 * silently BYPASSES that control. tenantId always comes from a server-trusted,
 * FK-RESTRICT-backed source (session / token row / non-null `User.tenantId`),
 * so a null row on a SUCCESSFUL query is data corruption - NOT "no policy". The
 * safe responses are to THROW (fail closed) or return a RESTRICTIVE default.
 * See PR #685 (derivePasskeyState) and the null-tenant-fail-open plan.
 *
 * This class was enumerated by hand and grew 4 -> 5 -> 7 during review (the R42
 * accretion signature). A prior version of this guard tracked only the SET of
 * files containing an enforcement read, so intra-file mutations - adding a
 * fail-open read to a listed file, reverting a `throw` to a permissive
 * fallback, or adding an access decision to a `display-exempt` file - all passed
 * (external review Medium). This version parses each read site with ts-morph and
 * verifies its declared MANIFEST disposition against the implementation:
 *
 *   "throw"            - the read's enclosing function MUST contain a null-tenant
 *                        guard that throws / returns-invalid (`if (!<tenantVar>)
 *                        { throw ... | return ... }`). Reverting the throw to a
 *                        permissive coalesce removes the guard -> FAIL.
 *   "failsafe-default" - the file MUST NOT read an enforcement field through a
 *                        permissive null-coalesce (`tenant?.<field> ?? <lenient>`);
 *                        it returns a restrictive default some other way.
 *                        Introducing a permissive coalesce -> FAIL.
 *   "display-exempt"   - the file must NOT call an access-restriction / deny
 *                        primitive. Turning an echo into an access decision -> FAIL.
 *
 * Plus completeness: every enforcement read site MUST have a MANIFEST entry, and
 * every MANIFEST entry MUST still have a live read. Exit 0 = OK, 1 = divergence.
 *
 * Env: NTFC_CHECK_ROOT overrides the repo root (used by the guard self-test).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.NTFC_CHECK_ROOT ?? REPO_ROOT;
const SCAN_DIRS = ["src/app/api", "src/lib", "src/auth.ts"];

const MANIFEST = new Map([
  ["src/lib/auth/policy/access-restriction.ts", "throw"],
  ["src/lib/auth/policy/passkey-enforcement.ts", "throw"],
  ["src/lib/auth/session/auth-adapter.ts", "throw"],
  ["src/lib/auth/tokens/extension-token.ts", "throw"],
  ["src/app/api/extension/token/refresh/route.ts", "throw"],
  ["src/app/api/webauthn/register/verify/route.ts", "throw"],
  ["src/lib/team/team-policy.ts", "throw"],
  ["src/auth.ts", "throw"],
  ["src/lib/auth/policy/account-lockout.ts", "failsafe-default"],
  ["src/lib/auth/session/session-timeout.ts", "failsafe-default"],
  ["src/app/api/tenant/policy/route.ts", "display-exempt"],
  ["src/app/api/teams/[teamId]/policy/route.ts", "display-exempt"],
  ["src/app/api/vault/status/route.ts", "display-exempt"],
  ["src/app/api/vault/unlock/data/route.ts", "display-exempt"],
  ["src/app/api/user/passkey-status/route.ts", "display-exempt"],
  ["src/app/api/sessions/route.ts", "display-exempt"],
]);

const ENFORCEMENT_FIELDS = new Set([
  "allowedCidrs", "tailscaleEnabled", "tailscaleTailnet",
  "requirePasskey", "requirePasskeyEnabledAt", "passkeyGracePeriodDays",
  "requireMinPinLength",
  "lockoutThreshold1", "lockoutThreshold2", "lockoutThreshold3",
  "lockoutDuration1Minutes", "lockoutDuration2Minutes", "lockoutDuration3Minutes",
  "extensionTokenIdleTimeoutMinutes", "extensionTokenAbsoluteTimeoutMinutes",
  "maxConcurrentSessions", "sessionIdleTimeoutMinutes",
  "sessionAbsoluteTimeoutMinutes", "vaultAutoLockMinutes",
]);

const ACCESS_DECISION_NAMES = new Set([
  "checkAccessRestriction", "checkAccessRestrictionWithAudit",
  "enforceAccessRestriction", "checkTeamAccessRestriction",
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
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && (extname(e.name) === ".ts" || extname(e.name) === ".tsx")) out.push(full);
  }
  return out;
}

function selectNamesEnforcementField(objLiteral) {
  if (!objLiteral || objLiteral.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  const selectProp = objLiteral.getProperties()
    .find((p) => p.getKind() === SyntaxKind.PropertyAssignment && p.getName() === "select");
  if (!selectProp) return false;
  const selectObj = selectProp.getInitializerIfKind?.(SyntaxKind.ObjectLiteralExpression);
  if (!selectObj) return false;
  return selectObj.getProperties().some((p) => p.getName && ENFORCEMENT_FIELDS.has(p.getName()));
}

function findEnforcementReads(sf) {
  const reads = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (callee.getName?.() !== "findUnique") continue;
    const recvText = callee.getExpression?.()?.getText?.() ?? "";
    if (!/(^|\.)tenant$/.test(recvText)) continue;
    if (selectNamesEnforcementField(call.getArguments()[0])) reads.push({ node: call });
  }
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (pa.getName() !== "tenant") continue;
    const init = pa.getInitializerIfKind?.(SyntaxKind.ObjectLiteralExpression);
    if (init && selectNamesEnforcementField(init)) reads.push({ node: pa });
  }
  return reads;
}

function hasNullTenantThrowGuard(node) {
  const fn =
    node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ??
    node.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
    node.getFirstAncestorByKind(SyntaxKind.FunctionExpression) ??
    node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ??
    node.getSourceFile();
  for (const ifStmt of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const cond = ifStmt.getExpression();
    if (cond.getKind() !== SyntaxKind.PrefixUnaryExpression) continue;
    if (cond.getOperatorToken?.() !== SyntaxKind.ExclamationToken) continue;
    const operand = cond.getOperand?.();
    if (!operand || !/tenant/i.test(operand.getText())) continue;
    const body = ifStmt.getThenStatement();
    const bk = body.getKind();
    if (bk === SyntaxKind.ThrowStatement ||
        bk === SyntaxKind.ReturnStatement ||
        body.getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0 ||
        body.getDescendantsOfKind(SyntaxKind.ReturnStatement).length > 0) return true;
  }
  return false;
}

function hasPermissiveEnforcementCoalesce(sf) {
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.QuestionQuestionToken) continue;
    const left = bin.getLeft();
    const paList = left.getKind() === SyntaxKind.PropertyAccessExpression
      ? [left] : left.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    for (const pa of paList) {
      if (!ENFORCEMENT_FIELDS.has(pa.getName())) continue;
      if (/tenant/i.test(pa.getExpression().getText())) return true;
    }
  }
  return false;
}

function callsAccessDecision(sf) {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.getKind() === SyntaxKind.Identifier ? callee.getText()
      : callee.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getName?.() : null;
    if (name && ACCESS_DECISION_NAMES.has(name)) return true;
  }
  for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (nw.getExpression().getText() === "PolicyViolationError") return true;
  }
  return false;
}

const targets = SCAN_DIRS.flatMap((d) => {
  const full = join(ROOT, d);
  return d.endsWith(".ts") ? [full] : walk(full);
});

const liveReads = new Set();
const violations = [];

for (const file of targets) {
  if (file.includes(".test.") || file.includes("__tests__")) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const rel = relative(ROOT, file);
  const virtualName = `/v/${rel.replaceAll("/", "_")}${extname(file) === ".tsx" ? ".tsx" : ".ts"}`;
  const sf = project.createSourceFile(virtualName, text, { overwrite: true });

  const reads = findEnforcementReads(sf);
  if (reads.length === 0) continue;
  liveReads.add(rel);

  const disposition = MANIFEST.get(rel);
  if (!disposition) {
    violations.push(`${rel}: NEW enforcement tenant read with no MANIFEST disposition - classify it (throw | failsafe-default | display-exempt).`);
    continue;
  }

  if (disposition === "throw") {
    if (!reads.every((r) => hasNullTenantThrowGuard(r.node))) {
      violations.push(`${rel}: disposition "throw" but an enforcement read has no null-tenant guard (if (!tenant) { throw|return }). A reverted throw is a fail-open regression.`);
    }
  } else if (disposition === "failsafe-default") {
    if (hasPermissiveEnforcementCoalesce(sf)) {
      violations.push(`${rel}: disposition "failsafe-default" but an enforcement field is read through a permissive '?? <lenient>' coalesce - the fail-open shape. Return a RESTRICTIVE default instead.`);
    }
  } else if (disposition === "display-exempt") {
    if (callsAccessDecision(sf)) {
      violations.push(`${rel}: disposition "display-exempt" but the file calls an access-restriction / deny primitive - it is no longer a pure echo. Re-classify (throw | failsafe-default).`);
    }
  }
}

const stale = [...MANIFEST.keys()].filter((r) => !liveReads.has(r)).sort();

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error("null-tenant fail-open: enforcement-read violation(s):");
  console.error("");
  for (const v of violations.sort()) console.error(`  ${v}`);
}
if (stale.length > 0) {
  failed = true;
  if (violations.length > 0) console.error("");
  console.error("MANIFEST entries that no longer read an enforcement tenant field (stale - remove them):");
  console.error("");
  for (const s of stale) console.error(`  ${s}`);
}
if (failed) process.exit(1);
console.log(`check-null-tenant-fail-closed: OK (${liveReads.size} enforcement reads, all classified + disposition-verified)`);
