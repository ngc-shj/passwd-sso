#!/usr/bin/env node
/**
 * CI guard: the emergency-access auto-promotion writes its activation audit
 * atomically.
 *
 * `EMERGENCY_ACCESS_ACTIVATE` records that a vault owner's escrowed key
 * material was released to a grantee, and on the auto-promotion path it is the
 * ONLY record — that route emits no `EMERGENCY_VAULT_ACCESS`. It is written via
 * `logAuditInTx` on the promotion's own transaction, so the row and the state
 * change commit together or not at all.
 *
 * Why this gate exists SEPARATELY from `check-critical-audit-atomic.mjs`, which
 * already lists the action: that gate is ACTION-scoped. It requires the action
 * to appear as the `action:` of at least one `logAuditInTx` call anywhere in the
 * tree, and there are two emitters — the auto-promotion and the owner's early
 * approval. Reverting either one alone leaves it green (measured). This gate
 * covers the site.
 *
 * The pattern matches the CALL, not the word: the file's own comments explain
 * what it used to do, and a word-shaped pattern flags its own documentation.
 *
 * A missing subject is a FAILURE, not a pass. "The file moved" and "the file is
 * clean" must not share an exit status — the gate's whole value is that it
 * examines a specific file, so it has to refuse when it cannot.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.EMERGENCY_ACTIVATE_ATOMIC_ROOT ?? join(__dirname, "..", "..");

const SUBJECT = "src/lib/emergency-access/vault-auto-promote.ts";
const FORBIDDEN = /logAuditAsync\(/;

console.log(`check-emergency-activate-atomic: ROOT=${REPO_ROOT} SUBJECT=${SUBJECT}`);

const path = join(REPO_ROOT, SUBJECT);
if (!existsSync(path)) {
  console.error(
    `\nFAIL: ${SUBJECT} not found under ${REPO_ROOT}.\n` +
      `If the auto-promotion moved, move this gate's SUBJECT with it — a gate ` +
      `that cannot find its subject must not report clean.`,
  );
  process.exit(1);
}

const source = readFileSync(path, "utf8");
const hits = source
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => FORBIDDEN.test(line));

if (hits.length > 0) {
  console.error(
    `\nFAIL: the activation audit is written via logAuditAsync, which is ` +
      `post-commit and best-effort.\n` +
      `Use logAuditInTx on the promotion's transaction — this row is the only ` +
      `record that escrowed key material moved.\n`,
  );
  for (const { line, n } of hits) console.error(`  ${SUBJECT}:${n}: ${line.trim()}`);
  process.exit(1);
}

console.log("check-emergency-activate-atomic: OK (activation audit is written in-transaction)");
