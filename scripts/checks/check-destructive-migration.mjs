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
 * Detection is LEXICAL, not a regex over raw text. `tokenize()` walks the SQL in
 * a single left-to-right pass tracking string/comment state, so:
 *   - `SELECT '-- harmless'; DROP TABLE users;` IS caught — the `--` sits inside
 *     a string literal and does not start a comment. (Stripping comments before
 *     parsing strings, the obvious shortcut, deletes the DROP and misses it.)
 *   - destructive keywords inside a real comment or string are NOT flagged;
 *   - dollar-quoted bodies ($$ … $$, $tag$ … $tag$) are skipped correctly.
 * Matching then runs over the token stream, so optional-keyword forms such as
 * `ALTER TABLE t RENAME col TO col2` (PostgreSQL makes `COLUMN` optional) cannot
 * slip past a `RENAME\s+COLUMN`-shaped regex.
 *
 * Existing migrations predate the rule and are baselined in the allowlist file;
 * the gate binds NEW migrations. An allowlist entry needs a reason (>=10 chars)
 * stating why it is safe or how it was deployed.
 *
 * Fail-closed:
 *   DESTRUCTIVE_MIGRATION: <name> (<kind>)  — destructive DDL, not allowlisted
 *   ALLOWLIST_ENTRY_WITHOUT_REASON: <line>  — entry missing a real reason
 *   STALE_ALLOWLIST_ENTRY: <entry>          — entry names a migration that no
 *                                             longer exists or is no longer
 *                                             destructive (anti-drift)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
// Env-overridable so the self-test can run against an isolated fixture tree
// (mirrors check-raw-sql-usage.mjs's RAW_SQL_CHECK_ROOT convention).
const ROOT = process.env.DESTRUCTIVE_MIGRATION_CHECK_ROOT ?? REPO_ROOT;
const MIGRATIONS_DIR = join(ROOT, "prisma/migrations");
const ALLOWLIST_FILE =
  process.env.DESTRUCTIVE_MIGRATION_CHECK_ALLOWLIST ??
  join(ROOT, "scripts/checks/destructive-migration-baseline.txt");

const MIN_REASON_LENGTH = 10;

/**
 * Lexical scan: return the SQL's significant tokens (bare words upper-cased,
 * `;` as an explicit separator, quoted identifiers as one opaque token), with
 * comments and string literals removed.
 *
 * @param {string} sql
 * @param {{expandDollarQuoted?: boolean}} [options]
 *   expandDollarQuoted (default true) — recurse into `$$ … $$` bodies and emit
 *   their tokens. Destructive-DDL detection needs this, because these migrations
 *   put their real DDL inside `DO $$ … $$` blocks. Statement COUNTING must set
 *   it to false: a DO block is ONE statement no matter how much DDL it contains,
 *   and expanding it would inflate the count.
 */
export function tokenize(sql, options = {}) {
  const { expandDollarQuoted = true } = options;
  const tokens = [];
  let word = "";
  const flush = () => {
    if (word.length > 0) {
      tokens.push(word.toUpperCase());
      word = "";
    }
  };

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      flush();
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      // Block comments nest in PostgreSQL.
      flush();
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      i -= 1;
      continue;
    }
    if (c === "'") {
      flush();
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      // Quoted identifier → opaque, so a column literally named "drop" cannot
      // contribute a keyword.
      flush();
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') break;
        i += 1;
      }
      tokens.push("<IDENT>");
      continue;
    }
    if (c === "$") {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        flush();
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const body = sql.slice(i + tag.length, end === -1 ? sql.length : end);
        // A dollar-quoted body is a string to the PARSER, but in these
        // migrations it is where the DDL actually lives (`DO $$ BEGIN ...
        // EXECUTE 'ALTER TABLE ... RENAME ...' ... END $$`). Skipping it
        // wholesale would miss most real renames, so recurse: tokenize the body
        // as SQL. Nested single-quoted EXECUTE payloads would be swallowed as
        // strings by that recursion, so also tokenize the body with quotes
        // neutralised to reach the DDL inside them.
        if (expandDollarQuoted) {
          tokens.push(...tokenize(body), ...tokenize(body.replace(/'/g, " ")));
        }
        i = end === -1 ? sql.length : end + tag.length - 1;
        continue;
      }
    }
    if (c === ";") {
      flush();
      tokens.push(";");
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      word += c;
      continue;
    }
    flush();
  }
  flush();
  return tokens;
}

const at = (t, i, ...expected) => expected.every((e, n) => t[i + n] === e);

/**
 * Object keywords that can legitimately follow DROP. Anything else after DROP
 * inside an ALTER TABLE is the implicit-column form (`ALTER TABLE t DROP col`),
 * which is destructive.
 */
const DROP_OBJECT_KEYWORDS = new Set([
  "TABLE",
  "COLUMN",
  "VIEW",
  "MATERIALIZED",
  "CONSTRAINT",
  "TYPE",
  "SEQUENCE",
  "INDEX",
  "SCHEMA",
  "TRIGGER",
  "FUNCTION",
  "PROCEDURE",
  "POLICY",
  "EXTENSION",
  "OWNED",
  "ROLE",
  "DATABASE",
  "PUBLICATION",
  "SUBSCRIPTION",
  // Non-destructive column/table clauses: `DROP DEFAULT`, `DROP NOT NULL`,
  // `DROP IDENTITY`, `DROP EXPRESSION` relax rather than remove data.
  "DEFAULT",
  "NOT",
  "IDENTITY",
  "EXPRESSION",
  "IF",
]);

/**
 * Destructive DDL, matched over the token stream against PostgreSQL's real
 * grammar (including optional keywords).
 */
const DESTRUCTIVE_MATCHERS = [
  // Every ALTER … RENAME form is destructive: RENAME [COLUMN] a TO b,
  // RENAME TO t2, RENAME CONSTRAINT c TO c2, ALTER TYPE … RENAME VALUE 'a' TO 'b'.
  ["RENAME", (t, i) => t[i] === "RENAME"],
  ["TRUNCATE", (t, i) => t[i] === "TRUNCATE"],
  ["DROP TABLE", (t, i) => at(t, i, "DROP", "TABLE")],
  ["DROP COLUMN", (t, i) => at(t, i, "DROP", "COLUMN")],
  [
    "DROP VIEW",
    (t, i) => at(t, i, "DROP", "VIEW") || at(t, i, "DROP", "MATERIALIZED", "VIEW"),
  ],
  ["DROP CONSTRAINT", (t, i) => at(t, i, "DROP", "CONSTRAINT")],
  ["DROP TYPE", (t, i) => at(t, i, "DROP", "TYPE")],
  ["DROP SEQUENCE", (t, i) => at(t, i, "DROP", "SEQUENCE")],
  // `ALTER TABLE t DROP col` — the COLUMN keyword omitted.
  [
    "DROP COLUMN (implicit)",
    (t, i) =>
      t[i] === "DROP" && t[i + 1] !== undefined && !DROP_OBJECT_KEYWORDS.has(t[i + 1]),
  ],
  ["SET NOT NULL", (t, i) => at(t, i, "SET", "NOT", "NULL")],
  // ALTER [COLUMN] <name> [SET DATA] TYPE …
  [
    "ALTER COLUMN TYPE",
    (t, i) => {
      if (t[i] !== "ALTER") return false;
      let j = i + 1;
      if (t[j] === "COLUMN") j += 1;
      if (t[j] === undefined || t[j] === ";") return false;
      j += 1; // column name
      return at(t, j, "SET", "DATA", "TYPE") || t[j] === "TYPE";
    },
  ],
];

export function findDestructiveKinds(sql) {
  const tokens = tokenize(sql);
  const kinds = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    for (const [kind, matches] of DESTRUCTIVE_MATCHERS) {
      if (matches(tokens, i)) kinds.add(kind);
    }
  }
  // The implicit form is a catch-all; when an explicit DROP was also matched at
  // the same site, report only the precise kind.
  if (kinds.has("DROP COLUMN") || kinds.has("DROP TABLE")) {
    kinds.delete("DROP COLUMN (implicit)");
  }
  return [...kinds];
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

function findDestructiveMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const found = [];
  for (const dir of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sqlPath = join(MIGRATIONS_DIR, dir.name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const kinds = findDestructiveKinds(readFileSync(sqlPath, "utf8"));
    if (kinds.length > 0) found.push({ name: dir.name, kinds });
  }
  return found;
}

function main() {
  const { entries: allowlist, errors } = readAllowlist();
  const destructive = findDestructiveMigrations();
  const destructiveNames = new Set(destructive.map((d) => d.name));

  for (const { name, kinds } of destructive) {
    if (!allowlist.has(name)) {
      errors.push(`DESTRUCTIVE_MIGRATION: ${name} (${kinds.join(", ")})`);
    }
  }

  // Anti-drift: an allowlisted migration that was deleted or made
  // non-destructive must be removed from the baseline, so the file cannot rot
  // into a blanket pass.
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
}

// Run only as a CLI, so the self-test can import tokenize()/findDestructiveKinds()
// without executing the gate against the real repo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
