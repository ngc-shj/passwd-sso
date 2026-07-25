#!/usr/bin/env node
/**
 * CI guard: a migration with multiple DDL statements must be wrapped in an
 * explicit transaction.
 *
 * Why: Prisma does NOT wrap PostgreSQL migrations in a transaction. A migration
 * whose 3rd statement fails leaves the first two applied — a schema that is
 * neither the old nor the new one, while the OLD app/workers are still live
 * against it (deploy.sh is migration-first; services roll only afterwards). An
 * explicit `BEGIN; … COMMIT;` makes the migration all-or-nothing, so a failure
 * leaves the schema exactly as it was and `deploy.sh` can abort cleanly.
 * See docs/operations/deployment.md "Migration Compatibility Rules".
 *
 * Counting is LEXICAL, reusing check-destructive-migration.mjs's tokenizer, so
 * DDL keywords inside comments, string literals and dollar-quoted bodies are not
 * miscounted, and a `DO $$ BEGIN … END $$` block's BEGIN is not mistaken for a
 * transaction BEGIN (that BEGIN is a PL/pgSQL block opener, not `BEGIN;`).
 *
 * POSITION is checked, not mere presence: `ALTER …; BEGIN; ALTER …; COMMIT;`
 * contains both keywords yet runs its first statement outside the transaction.
 * analyze() is a state machine over top-level statements and flags any DDL that
 * is not between an open BEGIN and its COMMIT.
 *
 * Statements that CANNOT run inside a transaction (`CREATE INDEX CONCURRENTLY`,
 * `VACUUM`) must stand ALONE in their migration — mixing them with other DDL is
 * flagged, since the others would be unprotected regardless. (The first version
 * exempted the whole file whenever one such statement appeared, which let
 * arbitrary unwrapped DDL ride along.)
 *
 * Existing migrations predate the rule and are baselined; the gate binds NEW
 * migrations. An entry needs a reason (>=10 chars).
 *
 * Fail-closed:
 *   UNWRAPPED_MULTI_DDL: <name> (<what is wrong>)
 *   ALLOWLIST_ENTRY_WITHOUT_REASON: <line>
 *   STALE_ALLOWLIST_ENTRY: <entry>
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tokenize } from "./check-destructive-migration.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.MIGRATION_TX_CHECK_ROOT ?? REPO_ROOT;
const MIGRATIONS_DIR = join(ROOT, "prisma/migrations");
const ALLOWLIST_FILE =
  process.env.MIGRATION_TX_CHECK_ALLOWLIST ??
  join(ROOT, "scripts/checks/migration-transaction-baseline.txt");

const MIN_REASON_LENGTH = 10;

/**
 * Keywords that begin a schema-modifying statement. `DO` is included because
 * these migrations routinely perform their DDL inside `DO $$ … $$` blocks — the
 * block is ONE statement (its body is not expanded, see tokenize's
 * expandDollarQuoted:false below), but it is still a statement that can fail
 * halfway through the migration.
 */
const DDL_KEYWORDS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "DO"]);

/**
 * Walk top-level statements, tracking transaction state, and report:
 *   ddlCount            — total DDL statements
 *   unwrappedDdlCount   — DDL statements NOT inside an open BEGIN…COMMIT
 *   nonTransactionalDdl — DDL statements that cannot run inside a transaction
 *
 * POSITION matters, which is why this is a state machine and not a "does the
 * file contain BEGIN and COMMIT" test: `ALTER …; BEGIN; ALTER …; COMMIT;` and
 * `BEGIN; ALTER …; COMMIT; ALTER …;` both contain both keywords, yet in each
 * one statement runs outside the transaction and can leave the schema half
 * applied. Only DDL between an open BEGIN and its COMMIT is actually atomic.
 *
 * A DDL keyword counts only at a statement boundary (start of input or right
 * after `;`), so `ALTER` inside a longer statement is not double counted.
 * Dollar-quoted bodies are not expanded, so a DO block is the single statement
 * it is.
 */
export function analyze(sql) {
  const tokens = tokenize(sql, { expandDollarQuoted: false });
  let ddlCount = 0;
  let unwrappedDdlCount = 0;
  let nonTransactionalDdl = 0;
  let inTransaction = false;
  let atBoundary = true;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === ";") {
      atBoundary = true;
      continue;
    }
    if (atBoundary) {
      // `BEGIN;` / `START TRANSACTION` only open a transaction at a statement
      // boundary — that is what distinguishes them from a PL/pgSQL `DO $$ BEGIN`.
      if (t === "BEGIN" && (tokens[i + 1] === ";" || tokens[i + 1] === undefined)) {
        inTransaction = true;
      } else if (t === "START" && tokens[i + 1] === "TRANSACTION") {
        inTransaction = true;
      } else if (t === "COMMIT" || t === "ROLLBACK" || t === "END") {
        inTransaction = false;
      } else if (DDL_KEYWORDS.has(t)) {
        ddlCount += 1;
        // Scan just this statement for a non-transactional marker, so one
        // CONCURRENTLY index does not exempt every other statement in the file.
        let j = i;
        let nonTx = false;
        while (j < tokens.length && tokens[j] !== ";") {
          if (tokens[j] === "CONCURRENTLY" || tokens[j] === "VACUUM") nonTx = true;
          j += 1;
        }
        if (nonTx) nonTransactionalDdl += 1;
        else if (!inTransaction) unwrappedDdlCount += 1;
      }
    }
    atBoundary = false;
  }
  return { ddlCount, unwrappedDdlCount, nonTransactionalDdl };
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return { entries: new Map(), errors: [] };
  const entries = new Map();
  const errors = [];
  for (const raw of readFileSync(ALLOWLIST_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const hashIndex = line.indexOf("#");
    if (hashIndex === -1) {
      errors.push(`ALLOWLIST_ENTRY_WITHOUT_REASON: ${line}`);
      continue;
    }
    const name = line.slice(0, hashIndex).trim();
    const reason = line.slice(hashIndex + 1).trim();
    if (name.length === 0) continue;
    if (reason.length < MIN_REASON_LENGTH) {
      errors.push(`ALLOWLIST_ENTRY_WITHOUT_REASON: ${line}`);
      continue;
    }
    entries.set(name, reason);
  }
  return { entries, errors };
}

export function findUnwrapped() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const found = [];
  for (const dir of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sqlPath = join(MIGRATIONS_DIR, dir.name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const { ddlCount, unwrappedDdlCount, nonTransactionalDdl } = analyze(
      readFileSync(sqlPath, "utf8"),
    );

    // A statement that cannot run inside a transaction must be ALONE in its
    // migration — otherwise the other statements are unprotected anyway and the
    // migration is still partially-appliable. This is what the docs say; the
    // previous implementation exempted the whole file instead.
    if (nonTransactionalDdl > 0 && ddlCount > nonTransactionalDdl) {
      found.push({
        name: dir.name,
        ddlCount,
        reason: `${nonTransactionalDdl} non-transactional statement(s) mixed with ${ddlCount - nonTransactionalDdl} other DDL statement(s)`,
      });
      continue;
    }
    // Multiple DDL statements are fine only if EVERY one of them sits inside an
    // open transaction.
    if (ddlCount > 1 && unwrappedDdlCount > 0) {
      found.push({
        name: dir.name,
        ddlCount,
        reason: `${unwrappedDdlCount} of ${ddlCount} DDL statements outside BEGIN/COMMIT`,
      });
    }
  }
  return found;
}

function main() {
  const { entries: allowlist, errors } = readAllowlist();
  const unwrapped = findUnwrapped();
  const unwrappedNames = new Set(unwrapped.map((u) => u.name));

  for (const { name, reason } of unwrapped) {
    if (!allowlist.has(name)) {
      errors.push(`UNWRAPPED_MULTI_DDL: ${name} (${reason})`);
    }
  }
  for (const name of allowlist.keys()) {
    if (!unwrappedNames.has(name)) {
      errors.push(`STALE_ALLOWLIST_ENTRY: ${name}`);
    }
  }

  if (errors.length > 0) {
    console.error("Migration-transaction check FAILED:\n");
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      `\nPrisma does not wrap PostgreSQL migrations in a transaction, so a` +
        `\nmulti-statement migration that fails partway leaves a half-applied` +
        `\nschema while the OLD code is still live. Wrap the statements:` +
        `\n\n  BEGIN;\n  ...\n  COMMIT;\n` +
        `\nIf the migration contains a statement that cannot run inside a` +
        `\ntransaction (CREATE INDEX CONCURRENTLY, VACUUM), split it into its own` +
        `\nmigration. If it is genuinely safe unwrapped, add it to` +
        `\n${ALLOWLIST_FILE} with a reason of at least ${MIN_REASON_LENGTH} characters.\n`,
    );
    process.exit(1);
  }

  console.log(
    `migration-transaction: OK (${unwrapped.length} unwrapped multi-DDL migrations, all baselined)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
