#!/usr/bin/env node
/**
 * CI guard: destructive migrations must be reviewed for old-code compatibility.
 *
 * Why: `scripts/deploy.sh` is migration-FIRST — it runs `prisma migrate deploy`
 * BEFORE advancing any service to the new revision. That ordering protects new
 * code from an un-migrated schema, but the converse is NOT protected: while the
 * migration runs (and until every service has rolled), the OLD app + workers are
 * still live against the NEWLY migrated schema. A destructive DDL therefore
 * breaks the running deployment immediately, and a migration that fails partway
 * leaves a schema that is neither the old nor the new one.
 *
 * The rule this gate enforces: a steady-state migration must be
 * EXPAND-AND-CONTRACT — compatible with both the old and the new code. Anything
 * destructive (dropping/renaming/narrowing what old code still reads or writes)
 * needs either a compatible redesign or the maintenance-mode deploy path
 * (scale-to-zero), which is a deliberate operator decision, not a default.
 * See docs/operations/deployment.md "Migration Compatibility Rules".
 *
 * Member set — DDL that can break concurrently-running old code:
 *   DROP COLUMN / DROP TABLE   old code still SELECTs or INSERTs it
 *   RENAME (column/table)      same, under a new name
 *   SET NOT NULL               old code INSERTs rows without the column
 *   ALTER COLUMN ... TYPE      old code writes the previous representation
 *
 * Existing migrations predate the rule and are baselined in the allowlist file;
 * the gate binds NEW migrations. An allowlist entry needs a reason (>=10 chars)
 * stating why it is safe or how it was deployed.
 *
 * Fail-closed:
 *   DESTRUCTIVE_MIGRATION: <path> (<kind>)  — destructive DDL, not allowlisted
 *   ALLOWLIST_ENTRY_WITHOUT_REASON: <line>  — entry missing a real reason
 *   STALE_ALLOWLIST_ENTRY: <entry>          — entry names a migration that no
 *                                             longer exists or is no longer
 *                                             destructive (anti-drift)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
// Env-overridable so the self-test can run against an isolated fixture tree
// (mirrors check-raw-sql-usage.mjs's RAW_SQL_CHECK_ROOT convention).
const ROOT = process.env.DESTRUCTIVE_MIGRATION_CHECK_ROOT ?? REPO_ROOT;
const MIGRATIONS_DIR = join(ROOT, "prisma/migrations");
const ALLOWLIST_FILE =
  process.env.DESTRUCTIVE_MIGRATION_CHECK_ALLOWLIST ??
  join(ROOT, "scripts/checks/destructive-migration-baseline.txt");

const MIN_REASON_LENGTH = 10;

/** Each entry: [kind, regex]. Applied to SQL with comments/strings stripped. */
const DESTRUCTIVE_PATTERNS = [
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
  ["DROP TABLE", /\bDROP\s+TABLE\b/i],
  ["RENAME", /\bRENAME\s+(COLUMN|TO|CONSTRAINT)\b/i],
  ["SET NOT NULL", /\bSET\s+NOT\s+NULL\b/i],
  ["ALTER COLUMN TYPE", /\bALTER\s+(COLUMN\s+)?"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i],
];

/**
 * Strip line comments and single-quoted string literals so a pattern inside a
 * comment or a data value is not mistaken for real DDL.
 */
function stripNoise(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return { entries: new Map(), errors: [] };
  const entries = new Map();
  const errors = [];
  const lines = readFileSync(ALLOWLIST_FILE, "utf8").split("\n");
  for (const raw of lines) {
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

function findDestructiveMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const found = [];
  for (const dir of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sqlPath = join(MIGRATIONS_DIR, dir.name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const sql = stripNoise(readFileSync(sqlPath, "utf8"));
    const kinds = DESTRUCTIVE_PATTERNS.filter(([, re]) => re.test(sql)).map(([kind]) => kind);
    if (kinds.length > 0) found.push({ name: dir.name, kinds });
  }
  return found;
}

const { entries: allowlist, errors } = readAllowlist();
const destructive = findDestructiveMigrations();
const destructiveNames = new Set(destructive.map((d) => d.name));

for (const { name, kinds } of destructive) {
  if (!allowlist.has(name)) {
    errors.push(`DESTRUCTIVE_MIGRATION: ${name} (${kinds.join(", ")})`);
  }
}

// Anti-drift: an allowlisted migration that was deleted or made non-destructive
// must be removed from the baseline, so the file cannot rot into a blanket pass.
for (const name of allowlist.keys()) {
  if (!destructiveNames.has(name)) {
    errors.push(`STALE_ALLOWLIST_ENTRY: ${name}`);
  }
}

if (errors.length > 0) {
  console.error("Destructive-migration check FAILED:\n");
  for (const e of errors) console.error(`  ${e}`);
  console.error(
    `\nSteady-state deploys run the migration while the OLD code is still live,` +
      `\nso a migration must be expand-and-contract (compatible with old AND new` +
      `\ncode). See docs/operations/deployment.md "Migration Compatibility Rules".` +
      `\n\nIf this migration is genuinely safe (or ships via the maintenance-mode` +
      `\npath), add it to ${ALLOWLIST_FILE} with a reason of at least ` +
      `${MIN_REASON_LENGTH} characters:` +
      `\n  <migration_dir_name>  # why it is safe / how it is deployed\n`,
  );
  process.exit(1);
}

console.log(
  `destructive-migration: OK (${destructive.length} destructive migrations, all baselined)`,
);
