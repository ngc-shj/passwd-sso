#!/usr/bin/env node
/**
 * CI guard: BOTH `EMERGENCY_ACCESS_ACTIVATE` emitters write their audit row
 * atomically, on the transaction that performed the state change.
 *
 * That action records that a vault owner's escrowed key material was released
 * to a grantee, and on the auto-promotion path it is the ONLY record — that
 * route emits no `EMERGENCY_VAULT_ACCESS`.
 *
 * Why this exists SEPARATELY from `check-critical-audit-atomic.mjs`, which also
 * lists the action: that gate is ACTION-scoped. It requires the action to appear
 * as the `action:` of at least one `logAuditInTx` call anywhere in the tree, and
 * there are two emitters — reverting either one alone leaves it green (measured).
 * This gate is SITE-scoped and covers both.
 *
 * ─── What it asserts, and why the negative half is not enough ───
 *
 * Per site: at least one `logAuditInTx` call carrying this action (POSITIVE),
 * and no `logAuditAsync` call carrying it (NEGATIVE).
 *
 * The first version of this gate had only the negative half and printed
 * "OK (written in-transaction)" on the strength of it. Deleting the emit
 * entirely passed. A gate whose success message is a positive claim has to make
 * a positive assertion, or it certifies the one state it cannot distinguish from
 * correct.
 *
 * ─── Decided on the parse tree, not on line text ───
 *
 * The predicate is "a call to this function carrying this action", which line
 * text answers badly: a call split across lines is invisible to it, and a
 * word-shaped pattern flags the subject's own comments explaining what it used
 * to do. Both were observed on the text version.
 *
 * KNOWN LIMIT: the callee is matched by NAME, so a call reached through an alias
 * (`const emit = logAuditAsync; emit({...})`) is not seen. Resolving that needs a
 * Program, which no gate in this tree carries; `check-bypass-rls.mjs`'s header
 * documents the same boundary. The runtime consequence of an aliased revert is
 * still caught by the route tests, which assert the emit reached `logAuditInTx`
 * with the transaction.
 *
 * A missing subject is a FAILURE. "The file moved" and "the file is clean" must
 * not share an exit status — this gate's whole value is that it examines two
 * specific files.
 */
import { SyntaxKind } from "ts-morph";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.EMERGENCY_ACTIVATE_ATOMIC_ROOT ?? join(__dirname, "..", "..");

const ACTION = "EMERGENCY_ACCESS_ACTIVATE";
/**
 * `banAsyncOutright` marks a subject whose ENTIRE body runs inside the caller's
 * RLS context. After C2 an async emit there is refused and writes no row
 * anywhere, whatever action it carries — so for that file the ban is on the
 * function, not on the action. The approve route is not such a file: an emit at
 * its handler's top level sits outside the `withTenantRls` callback and is
 * correct there, so only the activation action is constrained.
 */
const SUBJECTS = [
  { path: "src/lib/emergency-access/vault-auto-promote.ts", banAsyncOutright: true },
  { path: "src/app/api/emergency-access/[id]/approve/route.ts", banAsyncOutright: false },
];
const SUBJECT_PATHS = SUBJECTS.map((s) => s.path);

console.log(
  `check-emergency-activate-atomic: ROOT=${REPO_ROOT} ACTION=${ACTION} SUBJECTS=${SUBJECTS.length}`,
);

const missing = SUBJECT_PATHS.filter((s) => !existsSync(join(REPO_ROOT, s)));
if (missing.length > 0) {
  console.error(
    `\nFAIL: subject not found under ${REPO_ROOT}:\n` +
      missing.map((m) => `  ${m}`).join("\n") +
      `\nIf an emitter moved, move this gate's SUBJECTS with it — a gate that ` +
      `cannot find its subject must not report clean.`,
  );
  process.exit(1);
}

/** The `action:` property of a call's last object-literal argument, or null. */
function actionOf(call) {
  const args = call.getArguments();
  const last = args[args.length - 1];
  if (!last || last.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const prop = last.getProperty?.("action");
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = prop.getInitializer();
  if (!init || init.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const recv = init.getExpression();
  if (recv.getKind() === SyntaxKind.Identifier && recv.getText() === "AUDIT_ACTION") {
    return init.getName();
  }
  return null;
}

const project = createAstProject();
const failures = [];
let scanned = 0;

for (const { rel, sf } of sourceFilesFrom(project, SUBJECT_PATHS, REPO_ROOT)) {
  const subject = SUBJECTS.find((s) => rel.endsWith(s.path)) ?? { banAsyncOutright: false };
  scanned += 1;
  const inTx = [];
  const async = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) continue;
    const name = callee.getText();
    if (name !== "logAuditInTx" && name !== "logAuditAsync") continue;

    const line = call.getStartLineNumber();
    const action = actionOf(call);

    // Fail-CLOSED on an undecidable action. `actionOf` only reads an inline
    // object literal, so an ordinary "extract the params object" refactor would
    // otherwise make a `logAuditAsync` invisible here — the negative half would
    // be silently skipped while the banner still claimed the file was clean.
    if (action === null) {
      failures.push(
        `${rel}:${line}: cannot decide which action this ${name} call carries — ` +
          `pass the action in an inline object literal so this gate can read it.`,
      );
      continue;
    }

    if (name === "logAuditAsync" && subject.banAsyncOutright) {
      failures.push(
        `${rel}:${line}: logAuditAsync in a file whose whole body runs under the ` +
          `caller's RLS context. C2 refuses an in-context async emit, so this row ` +
          `is written nowhere — whatever action it carries. Use logAuditInTx.`,
      );
      continue;
    }

    if (action !== ACTION) continue;
    (name === "logAuditInTx" ? inTx : async).push(line);
  }

  if (inTx.length === 0) {
    failures.push(
      `${rel}: no logAuditInTx call carrying AUDIT_ACTION.${ACTION}. ` +
        `The activation audit must be written on the transaction that performed ` +
        `the state change — this row is the only record that escrowed key ` +
        `material moved.`,
    );
  }
  for (const line of async) {
    failures.push(
      `${rel}:${line}: AUDIT_ACTION.${ACTION} emitted via logAuditAsync, which is ` +
        `post-commit and best-effort. Use logAuditInTx.`,
    );
  }
}

// sourceFilesFrom skips anything that is not a scannable source file; the
// existsSync check above cannot tell that from a present-and-readable one.
if (scanned !== SUBJECT_PATHS.length) {
  console.error(
    `\nFAIL: expected to scan ${SUBJECT_PATHS.length} subjects, scanned ${scanned}.`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `check-emergency-activate-atomic: OK (${scanned} emitters write ${ACTION} via logAuditInTx)`,
);
