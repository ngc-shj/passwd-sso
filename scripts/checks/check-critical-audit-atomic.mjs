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
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFiles } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CRITICAL_AUDIT_ATOMIC_ROOT
  ? process.env.CRITICAL_AUDIT_ATOMIC_ROOT
  : join(__dirname, "..", "..");
const SEARCH_DIR = join(REPO_ROOT, "src", "app", "api");

console.log(`check-critical-audit-atomic: SEARCH_DIR=${SEARCH_DIR}`);

// Actions whose success audit MUST be written via logAuditInTx.
const CRITICAL_ACTIONS = new Set([
  "MASTER_KEY_ROTATION_INITIATE",
  "MASTER_KEY_ROTATION_APPROVE",
  "MASTER_KEY_ROTATION_REVOKE",
  "RECOVERY_PASSPHRASE_RESET",
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

// The params object of logAuditInTx(tx, tenantId, params) is the 3rd argument.
// Support spreads inside it (`...tenantAuditBase(...)`) — those never carry the
// action, so reading the direct `action:` property is sufficient.
const seenInTxActions = new Set();

for (const { sf } of sourceFiles(project, SEARCH_DIR, REPO_ROOT)) {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.getKind() === SyntaxKind.PropertyAccessExpression
      ? callee.getName()
      : callee.getText();
    if (name !== "logAuditInTx") continue;

    const args = call.getArguments();
    // params is the last arg; be lenient about arg count.
    const paramsArg = args[args.length - 1];
    const action = actionNameFromObject(paramsArg);
    if (action) seenInTxActions.add(action);
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
  process.exit(1);
}

console.log(
  `OK (all ${CRITICAL_ACTIONS.size} security-critical actions write their audit via logAuditInTx)`,
);
