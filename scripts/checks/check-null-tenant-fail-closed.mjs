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
    if (!selectNamesEnforcementField(call.getArguments()[0])) continue;
    // The variable this tenant row is bound to: `const <v> = await <...>.findUnique(...)`
    // (or `= <...>.findUnique(...)`). The null guard must key on <v>.tenant.
    reads.push({ node: call, guardVar: bindingVarName(call), joinField: null });
  }
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (pa.getName() !== "tenant") continue;
    const init = pa.getInitializerIfKind?.(SyntaxKind.ObjectLiteralExpression);
    if (!init || !selectNamesEnforcementField(init)) continue;
    // Relation join `tenant: { select: {...} }` nested in a parent findUnique
    // select: the row is bound to the parent's variable and the enforcement
    // fields live under `<v>.tenant`. Guard must be `if (!<v>) | if (!<v>.tenant)`.
    const parentCall = pa.getFirstAncestorByKind(SyntaxKind.CallExpression);
    reads.push({ node: pa, guardVar: parentCall ? bindingVarName(parentCall) : null, joinField: "tenant" });
  }
  return reads;
}

// The identifier a tenant read is ultimately bound to. Handles two real shapes:
//   (1) direct / RLS-wrapped: `const t = await withBypassRls(prisma, (tx) =>
//       tx.tenant.findUnique(...))` — climb through await/arrow/wrapper layers to
//       the enclosing VariableDeclaration and take its name.
//   (2) Promise.all array-destructuring: `const [c, t] = await Promise.all([
//       count(...), tx.tenant.findUnique(...)])` — the read is the Nth array
//       element, bound to the Nth name of the ArrayBindingPattern.
// Returns null when not bound to a simple identifier (the caller treats a null
// guardVar as UNGUARDED — fail closed on the guard check).
function bindingVarName(call) {
  const viaPromiseAll = promiseAllDestructuredName(call);
  if (viaPromiseAll !== undefined) return viaPromiseAll;

  // Same climb shape as promiseAllDestructuredName: terminates via an inner
  // return, `cur` is only reassigned to a non-null parent, so `for (;;)`.
  let cur = call;
  for (;;) {
    const parent = cur.getParent?.();
    if (!parent) return null;
    const pk = parent.getKind();
    if (pk === SyntaxKind.VariableDeclaration) {
      const nameNode = parent.getNameNode?.();
      if (nameNode && nameNode.getKind() === SyntaxKind.Identifier) return nameNode.getText();
      return null; // destructuring binding handled above; otherwise unguardable
    }
    if (
      pk === SyntaxKind.AwaitExpression ||
      pk === SyntaxKind.ParenthesizedExpression ||
      pk === SyntaxKind.CallExpression ||
      pk === SyntaxKind.ArrowFunction ||
      pk === SyntaxKind.PropertyAccessExpression ||
      pk === SyntaxKind.ReturnStatement ||
      pk === SyntaxKind.Block ||
      pk === SyntaxKind.SyntaxList
    ) {
      cur = parent;
      continue;
    }
    return null;
  }
}

// If `call` is the Nth element of an array literal passed to `Promise.all(...)`
// whose result is destructured (`const [a, b] = await Promise.all([...])`),
// return the Nth binding name. Returns undefined when this shape does not apply
// (so the caller falls through to the generic climb), or null when the shape
// applies but the Nth binding is not a simple identifier.
function promiseAllDestructuredName(call) {
  // The array literal directly containing `call` as an element.
  const arrayLit = call.getParentIfKind?.(SyntaxKind.ArrayLiteralExpression);
  if (!arrayLit) return undefined;
  const elemIndex = arrayLit.getElements().findIndex((e) => e === call);
  if (elemIndex < 0) return undefined;
  // The array must be the sole arg to a `Promise.all(...)` call.
  const paCall = arrayLit.getParentIfKind?.(SyntaxKind.CallExpression);
  if (!paCall) return undefined;
  const callee = paCall.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined;
  if (callee.getName?.() !== "all") return undefined;
  if (callee.getExpression?.().getText?.() !== "Promise") return undefined;
  // Walk out to the VariableDeclaration with an array-binding pattern. The
  // climb always terminates via an inner return: `cur` is reassigned only to a
  // non-null parent, so a `while (cur)` guard would never fire — use `for (;;)`.
  let cur = paCall;
  for (;;) {
    const parent = cur.getParent?.();
    if (!parent) return null;
    const pk = parent.getKind();
    if (pk === SyntaxKind.VariableDeclaration) {
      const nameNode = parent.getNameNode?.();
      if (!nameNode || nameNode.getKind() !== SyntaxKind.ArrayBindingPattern) return null;
      const el = nameNode.getElements()[elemIndex];
      const nn = el?.getNameNode?.();
      if (nn && nn.getKind() === SyntaxKind.Identifier) return nn.getText();
      return null;
    }
    if (
      pk === SyntaxKind.AwaitExpression ||
      pk === SyntaxKind.ParenthesizedExpression ||
      pk === SyntaxKind.CallExpression ||
      pk === SyntaxKind.ArrowFunction ||
      pk === SyntaxKind.ConditionalExpression ||
      pk === SyntaxKind.ReturnStatement ||
      pk === SyntaxKind.Block ||
      pk === SyntaxKind.SyntaxList
    ) {
      cur = parent;
      continue;
    }
    return null;
  }
}

// Does the enclosing function of `read.node` contain a null guard on the SAME
// variable the read is bound to, that throws / returns (fail closed)?
//   plain read `const t = ...findUnique(...)`  -> guard `if (!t) { throw|return }`
//   relation join bound to `const u = ...`      -> guard `if (!u) | if (!u.tenant)`
// A read with no bindable variable (guardVar null) is treated as UNGUARDED.
function hasNullTenantThrowGuard(read) {
  const v = read.guardVar;
  if (!v) return false; // inline / unbindable read cannot be proven guarded
  const fn =
    read.node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ??
    read.node.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
    read.node.getFirstAncestorByKind(SyntaxKind.FunctionExpression) ??
    read.node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ??
    read.node.getSourceFile();

  // Accepted guard operand texts for this read's variable.
  const wanted = new Set([v]);
  if (read.joinField) wanted.add(`${v}.${read.joinField}`);

  for (const ifStmt of fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const cond = ifStmt.getExpression();
    if (cond.getKind() !== SyntaxKind.PrefixUnaryExpression) continue;
    if (cond.getOperatorToken?.() !== SyntaxKind.ExclamationToken) continue;
    const operand = cond.getOperand?.();
    if (!operand) continue;
    // Strip optional-chaining/whitespace differences: compare the text.
    const opText = operand.getText().replace(/\s+/g, "");
    if (!wanted.has(opText) && !wanted.has(opText.replace(/\?\./g, "."))) continue;
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
    if (!reads.every((r) => hasNullTenantThrowGuard(r))) {
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
