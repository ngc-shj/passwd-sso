#!/usr/bin/env node
/**
 * M1 CI guard (AST, ts-morph): the audit record for a security-critical,
 * single-mutation operation must be written INSIDE the mutation's transaction
 * (logAuditInTx), not post-commit best-effort (logAuditAsync). A crash in the
 * commit→enqueue window of logAuditAsync loses the audit trail on exactly the
 * operations most likely to be attacked or disputed.
 *
 * The gate is ACTION-based, not file-based: a route legitimately holds BOTH a
 * logAuditInTx success path and a logAuditAsync rejection path for the same
 * action, so what must hold is that each critical action appears as the `action:`
 * of at least one logAuditInTx(...) call.
 *
 * AST, not grep (per repo rule: classification gates are AST-first — grep over a
 * line window mis-attributes an action to a nearby logAuditInTx and can't tell a
 * success path from a rejection path). For every CallExpression `logAuditInTx(...)`,
 * read the `action:` property of its params object literal (the 3rd arg) and
 * collect the AUDIT_ACTION.<NAME> it references. A critical action absent from
 * that set means its atomic path was removed → FAIL.
 *
 * NOT covered (correctly stay logAuditAsync, so NOT listed here): multi-step
 * outcome audits that must run AFTER a post-CAS irreversible step to record its
 * result (MASTER_KEY_ROTATION_EXECUTE → share-revocation count; ADMIN_VAULT_RESET
 * _EXECUTE → deleted-entry / invalidated-session counts). Forcing those into the
 * CAS tx drops the outcome data. Rejection audits (no mutation) also stay async.
 *
 * `logAuditBulkInTx(tx, tenantId, params[])` (scim-team-admission-approval-plan.md
 * C4) is a second in-tx helper: one call enqueues several rows for one SCIM
 * sync, so its `action:` lives per-element, not on the call itself. Its last
 * argument is read as EITHER an array literal of object literals, OR a `.map`
 * call whose arrow callback returns an object literal (a parenthesised/concise
 * body only — a block body is unreadable). Each element's `action:` must be a
 * literal `AUDIT_ACTION.<NAME>`; a computed or conditional one (a ternary, a
 * ReferenceExpression, anything but `AUDIT_ACTION.X`) is REFUSED outright —
 * printed and FAILED — even when every critical action is otherwise present,
 * because the gate cannot tell which action such a call writes. A spread of a
 * `.map()` inside the array literal is refused the same way. `logAuditBulkAsync`
 * is a different helper (post-commit, best-effort) and does not count here.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CRITICAL_AUDIT_ATOMIC_ROOT
  ? process.env.CRITICAL_AUDIT_ATOMIC_ROOT
  : join(__dirname, "..", "..");
// Scan routes AND shared lib helpers — a destructive op may enqueue its atomic
// audit inside a shared helper (e.g. executeVaultReset in src/lib/vault), not
// the route file itself.
const SEARCH_DIRS = ["src/app/api", "src/lib"];

console.log(`check-critical-audit-atomic: SEARCH_DIRS=${SEARCH_DIRS.join(", ")}`);

// Actions whose success audit MUST be written via logAuditInTx. A destructive
// op whose audit records a multi-step OUTCOME (post-CAS counts) keeps a separate
// best-effort completion event, but the fact-of-commit event must be atomic.
const CRITICAL_ACTIONS = new Set([
  "MASTER_KEY_ROTATION_INITIATE",
  "MASTER_KEY_ROTATION_APPROVE",
  "MASTER_KEY_ROTATION_REVOKE",
  "MASTER_KEY_ROTATION_EXECUTE",
  "RECOVERY_PASSPHRASE_RESET",
  "VAULT_RESET_EXECUTED",
  "ADMIN_VAULT_RESET_EXECUTE",
  // Releases the vault owner's escrowed key material to a grantee. Two emitters
  // (auto-promotion and the owner's early approval); this gate is action-scoped
  // and is satisfied by EITHER, so it does not close the class on its own.
  // check-emergency-activate-atomic.mjs is the site-scoped companion that covers
  // both — verified by mutation: reverting one emitter leaves THIS gate green.
  "EMERGENCY_ACCESS_ACTIVATE",
  // scim-team-admission-approval-plan.md C3/C4: only the SCIM PUT/PATCH
  // per-member transitions are enqueued in bulk (logAuditBulkInTx), inside the
  // same SCIM transaction. Approve, reject, confirm-key's distribution and
  // mapping creation are each a single-mutation CAS/create site and use
  // logAuditInTx.
  "TEAM_MEMBER_SCIM_APPROVE",
  "TEAM_MEMBER_SCIM_REJECT",
  "TEAM_MEMBER_SCIM_PENDING",
  "TEAM_MEMBER_SCIM_PENDING_WITHDRAW",
  "TEAM_MEMBER_SCIM_REMOVE",
  "TEAM_MEMBER_SCIM_ROLE_UPDATE",
  "TEAM_MEMBER_KEY_DISTRIBUTE",
  "SCIM_GROUP_MAPPING_CREATE",
  // team-key-rotation-rekey D3: one row per entry a rotation carries
  // unchanged, enqueued (logAuditBulkInTx) in the rotation's transaction.
  "TEAM_KEY_ROTATION_CARRY",
  // team-key-rotation-rekey C4: a migrate rewrites an attachment's ciphertext
  // and key wrap; its audit row commits with the rewrite (logAuditInTx).
  "TEAM_ATTACHMENT_MIGRATE",
  // team-key-rotation-rekey C2 (D2): a re-key replaces an entry's ItemKey and
  // rewrites its history and CEK wraps; its audit row commits with the rewrite.
  "TEAM_ENTRY_REKEY",
]);

const project = createAstProject();

// Extract the AUDIT_ACTION.<NAME> referenced by the `action:` property of an
// object literal, or null. Accepts `AUDIT_ACTION.X` (PropertyAccess) — the sole
// shape used across the audit call sites.
function actionNameFromObject(objLiteral) {
  if (!objLiteral || objLiteral.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const prop = objLiteral.getProperty?.("action");
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = prop.getInitializer();
  if (!init || init.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  // `AUDIT_ACTION.MASTER_KEY_ROTATION_INITIATE` → getName() = the trailing member.
  const recv = init.getExpression();
  if (recv.getKind() === SyntaxKind.Identifier && recv.getText() === "AUDIT_ACTION") {
    return init.getName();
  }
  return null;
}

// An action counts as "written atomically" when it appears as the `action:` of:
//   (1) a direct logAuditInTx(tx, tenantId, params) call, OR
//   (2) an ATOMIC-AUDIT DESCRIPTOR — an object literal `{ params: { action: ... } }`
//       (the VaultResetAtomicAudit shape) passed to a shared helper that enqueues
//       it via logAuditInTx inside its own transaction (e.g. executeVaultReset).
// Case (2) is needed because a destructive op may delegate the atomic enqueue to
// a shared helper, so the `action:` literal lives at the CALLER, not the
// logAuditInTx call.
const seenInTxActions = new Set();

// Extract action from a `params:` property (nested descriptor) of an object literal.
function actionFromDescriptor(objLiteral) {
  if (!objLiteral || objLiteral.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const paramsProp = objLiteral.getProperty?.("params");
  if (!paramsProp || paramsProp.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = paramsProp.getInitializer();
  return actionNameFromObject(init);
}

// A readable per-element `action:` of a logAuditBulkInTx array element (or
// `.map` return value): `{ kind: "literal", name }` when it is
// `AUDIT_ACTION.<NAME>`, `{ kind: "refused", reason }` when present but not a
// literal we can attribute to one action, `null` when the element carries no
// `action:` property at all (not every element need name one here — only a
// present-but-unreadable one is refused).
function bulkElementAction(objLiteral) {
  if (!objLiteral || objLiteral.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    return { kind: "refused", reason: "not an object literal" };
  }
  const prop = objLiteral.getProperty?.("action");
  if (!prop) return null;
  if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
    return { kind: "refused", reason: "action is not a plain property" };
  }
  const init = prop.getInitializer();
  if (init && init.getKind() === SyntaxKind.PropertyAccessExpression) {
    const recv = init.getExpression();
    if (recv.getKind() === SyntaxKind.Identifier && recv.getText() === "AUDIT_ACTION") {
      return { kind: "literal", name: init.getName() };
    }
  }
  return { kind: "refused", reason: `action is ${init ? init.getKindName() : "absent"}, not a literal AUDIT_ACTION.<NAME>` };
}

/** A `.map` call whose last argument is an arrow function, else null. */
function mapArrowCallback(call) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression || callee.getName() !== "map") return null;
  const args = call.getArguments();
  const cb = args[args.length - 1];
  return cb && cb.getKind() === SyntaxKind.ArrowFunction ? cb : null;
}

/** The object literal a `.map` arrow callback returns (parenthesised/concise body only), else null. */
function mapReturnedObject(cb) {
  const body = cb.getBody();
  const expr = body.getKind() === SyntaxKind.ParenthesizedExpression ? body.getExpression() : body;
  return expr.getKind() === SyntaxKind.ObjectLiteralExpression ? expr : null;
}

// `logAuditBulkInTx` call sites whose action cannot be attributed to one
// AUDIT_ACTION member. Reported and FAILED regardless of CRITICAL_ACTIONS
// coverage — the gate cannot tell which action such a call writes, so it
// cannot vouch for it being the critical one even when every critical name
// happens to appear elsewhere.
const refusedBulkSites = [];

function siteOf(sf, node) {
  return `${sf.getFilePath()}:${node.getStartLineNumber()}`;
}

function recordBulkAction(result, sf, node) {
  if (!result) return;
  if (result.kind === "literal") {
    seenInTxActions.add(result.name);
    return;
  }
  refusedBulkSites.push(`${siteOf(sf, node)}: ${result.reason}`);
}

// Classify the last argument of a `logAuditBulkInTx(tx, tenantId, params)`
// call: an array literal of object literals, or a `.map` call returning one.
// `call` is the logAuditBulkInTx CallExpression itself, used to report a
// missing params argument (there is no argument node to point at).
function classifyBulkParams(paramsArg, sf, call) {
  if (!paramsArg) {
    refusedBulkSites.push(`${siteOf(sf, call)}: logAuditBulkInTx called with no params argument`);
    return;
  }
  if (paramsArg.getKind() === SyntaxKind.ArrayLiteralExpression) {
    for (const el of paramsArg.getElements()) {
      if (el.getKind() === SyntaxKind.SpreadElement) {
        const inner = el.getExpression();
        if (inner.getKind() === SyntaxKind.CallExpression && mapArrowCallback(inner)) {
          refusedBulkSites.push(`${siteOf(sf, el)}: a spread of a .map() inside the bulk array literal is refused (cannot verify each action)`);
          continue;
        }
        refusedBulkSites.push(`${siteOf(sf, el)}: a spread element inside the bulk array literal is refused`);
        continue;
      }
      recordBulkAction(bulkElementAction(el), sf, el);
    }
    return;
  }
  if (paramsArg.getKind() === SyntaxKind.CallExpression) {
    const cb = mapArrowCallback(paramsArg);
    if (cb) {
      const returned = mapReturnedObject(cb);
      if (returned) {
        recordBulkAction(bulkElementAction(returned), sf, returned);
        return;
      }
      refusedBulkSites.push(`${siteOf(sf, paramsArg)}: .map callback does not return an object literal directly (a block body is refused)`);
      return;
    }
  }
  refusedBulkSites.push(`${siteOf(sf, paramsArg)}: logAuditBulkInTx params is not a readable array literal or .map call`);
}

for (const { sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.getKind() === SyntaxKind.PropertyAccessExpression
      ? callee.getName()
      : callee.getText();

    if (name === "logAuditInTx") {
      // (1) direct call — params is the last arg.
      const args = call.getArguments();
      const action = actionNameFromObject(args[args.length - 1]);
      if (action) seenInTxActions.add(action);
      continue;
    }

    if (name === "logAuditBulkInTx") {
      const args = call.getArguments();
      classifyBulkParams(args[args.length - 1], sf, call);
      continue;
    }

    // (2) atomic-audit descriptor passed to any call: scan its object-literal
    // args for a `{ params: { action } }` shape.
    for (const arg of call.getArguments()) {
      const action = actionFromDescriptor(arg);
      if (action) seenInTxActions.add(action);
    }
  }
}

const missing = [...CRITICAL_ACTIONS].filter((a) => !seenInTxActions.has(a));

if (missing.length > 0) {
  for (const a of missing) {
    console.error(
      `ERROR: AUDIT_ACTION.${a} is not written via logAuditInTx (must be atomic with its mutation — M1).`,
    );
  }
  console.error("");
  console.error(`FAIL: ${missing.length} security-critical action(s) lost their atomic audit path.`);
  console.error("The success audit must live INSIDE the mutation transaction, not a post-commit logAuditAsync.");
}

if (refusedBulkSites.length > 0) {
  for (const site of refusedBulkSites) {
    console.error(`REFUSED: ${site} (logAuditBulkInTx action must be a literal AUDIT_ACTION.<NAME> the gate can verify).`);
  }
  console.error("");
  console.error(`FAIL: ${refusedBulkSites.length} logAuditBulkInTx call(s) have an unreadable, computed, or conditional action.`);
}

if (missing.length > 0 || refusedBulkSites.length > 0) {
  process.exit(1);
}

console.log(
  `OK (all ${CRITICAL_ACTIONS.size} security-critical actions write their audit via logAuditInTx)`,
);
