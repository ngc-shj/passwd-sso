#!/usr/bin/env node
/**
 * CI tripwire: a LIMIT that bounds a batch write must sit in a materialized
 * key set (plan: worker-batch-limit-overrun, C2; issue #870).
 *
 * Why: PostgreSQL may rescan an `IN (SELECT … LIMIT n FOR UPDATE …)` subquery
 * once per outer row. Each rescan's LockRows skips rows this statement already
 * updated, so LIMIT admits the next row and the write touches more than n.
 * Review kept finding spellings of that class (`= ANY (SELECT …)`, a correlated
 * `ARRAY(SELECT …)`, `IN ((…))`, `IN (WITH …)`, `FETCH FIRST`, a derived table,
 * a materialized CTE nested in an expression), so this gate refuses the class
 * instead of listing its members.
 *
 * Rule. For every string literal, no-substitution template and template
 * literal (read generically — the tag, if any, is never consulted, and each
 * `${…}` substitution is one opaque token) under src/, scripts/ and prisma/:
 * if the literal holds a write statement, then every `LIMIT` and every
 * `FETCH FIRST|NEXT` token in it must sit
 *   (a) at the top level of a CTE body,
 *   (b) of a CTE declared `AS MATERIALIZED (` (token-exact: `AS NOT
 *       MATERIALIZED` does not count),
 *   (c) in a WITH list at the literal's parenthesis depth 0 (the write
 *       statement's own list; a materialized CTE nested inside an expression
 *       is re-evaluated per row when correlated, so it does not count).
 * Any other position denies, naming the file and line and giving the C1 shape.
 *
 * A write statement is one of these in statement position — the start of the
 * literal, after `;`, the start of a CTE body, or the main statement after a
 * WITH list (including a recursive CTE's SEARCH / CYCLE clauses), with any
 * `${…}` substitutions before it treated as transparent:
 *   - `DELETE FROM <target>`;
 *   - `UPDATE <target> … SET`;
 *   - `MERGE INTO <target> … USING … WHEN [NOT] MATCHED … THEN UPDATE|DELETE`;
 *   - `INSERT INTO <target> … ON CONFLICT … DO UPDATE SET` (an upsert).
 *
 * Fail closed on the rest (UNRECOGNISED_WRITE). An UPDATE, DELETE or MERGE
 * word token that none of those statements accounts for — not a write head,
 * a MERGE's WHEN … THEN action, an upsert's DO UPDATE, or a MERGE whose
 * actions are only INSERT / DO NOTHING — and that is not `FOR UPDATE`,
 * `FOR NO KEY UPDATE`, or a referential action / rule event `ON UPDATE` /
 * `ON DELETE`, is an unrecognised write when the literal holds at least one
 * parenthesis. Then every `LIMIT` and `FETCH FIRST|NEXT` in that literal
 * denies, wherever it sits. The parenthesis condition is what keeps prose
 * out ("Update your profile before the limit is reached", or `UPDATE <t> SET`
 * embedded mid-sentence): UPDATE, DELETE and MERGE have no LIMIT clause, so a
 * LIMIT can bound one only through a subquery or a CTE body, and both are
 * parenthesised. When this rule landed, the literals in the tree holding such
 * a word were HTTP method names, GRANT lists and log prose, and none of them
 * held a LIMIT or FETCH.
 *
 * Scope: every non-test `.ts .tsx .mts .cts .js .mjs .cjs` file under src/,
 * scripts/ and prisma/, walked by scripts/checks/lib/ast-project.mjs (test
 * files, `__tests__` directories and `.spec.` excluded; a symlink under a scan
 * root fails the gate). Fails closed when 0 files are analysed or a file fails
 * to parse. The SQL scanner is scripts/checks/lib/sql-scan.mjs, shared with the
 * sweepBounds (INV4) guard in src/__tests__/workers/worker-policy-manifest.test.ts.
 *
 * Control class: best-effort tripwire. Adjudication is a lexical reading of
 * literal text, not the SQL parser. Every LIMIT position this gate allows is
 * one the INV4 guard's LIMIT-location clause also accepts (INV4 additionally
 * reports every MERGE and upsert as unbounded). It says nothing about writes
 * without a LIMIT; those are INV4's concern.
 *
 * Declared bypasses (each pinned by an allow row in the self-test):
 *   - SQL split across several literals or built by concatenation: each
 *     literal is judged alone, so a write in one and its LIMIT in another
 *     is not seen together;
 *   - the bounding subquery placed in a separate raw-SQL fragment that is
 *     interpolated into the write (the substitution is opaque);
 *   - SQL in prisma/migrations/*.sql (not a scanned extension) and plpgsql
 *     bodies (a dollar-quoted body is a string constant to this scanner);
 *   - an unrecognised write in a literal with no parenthesis at all: only
 *     an opaque `${…}` fragment could then carry the bounding subquery, which
 *     is the interpolated-fragment bypass above;
 *   - a write whose UPDATE / DELETE / MERGE keyword itself comes from a
 *     `${…}` substitution (the keyword is inside the opaque token).
 * Recovery path: review, plus the integration cap tests for known members.
 *
 * This file never spells the raw-SQL helper names as string literals
 * (check-raw-sql-usage.mjs RAW_SQL_NAMES); that gate's exemptions are
 * unchanged by it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "ts-morph";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";
import { analyzeSql, sqlInputFromNode } from "./lib/sql-scan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Env-overridable so the self-test runs the gate against an isolated fixture tree.
const ROOT = process.env.LIMITED_SUBQUERY_WRITE_CHECK_ROOT ?? REPO_ROOT;
const SCAN_ROOTS = ["src", "scripts", "prisma"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const LITERAL_KINDS = [
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression,
];

const LIMITED_SUBQUERY_WRITE = "LIMITED_SUBQUERY_WRITE";
const UNRECOGNISED_WRITE = "UNRECOGNISED_WRITE";

const C1_SHAPE =
  "WITH picked AS MATERIALIZED (SELECT <keys> FROM <table> WHERE … ORDER BY … LIMIT $n [FOR UPDATE SKIP LOCKED]) " +
  "<UPDATE|DELETE> … WHERE (<keys>) IN (SELECT <keys> FROM picked) …";

/**
 * The LIMIT/FETCH entries of `analysis.limits` that deny, each with its
 * reason: every one when the literal holds an unrecognised write, otherwise
 * those outside every allowed position of a literal holding a write.
 */
function deniedLimits(analysis) {
  if (analysis.unrecognisedWrites.length > 0) {
    return analysis.limits.map((limit) => ({ limit, reason: UNRECOGNISED_WRITE }));
  }
  return misplacedLimits(analysis).map((limit) => ({ limit, reason: LIMITED_SUBQUERY_WRITE }));
}

/** Indexes into `analysis.limits` that sit outside every allowed position. */
function misplacedLimits(analysis) {
  if (analysis.writes.length === 0) return [];
  const allowed = new Set();
  for (const list of analysis.withLists) {
    if (list.depth !== 0) continue; // (c)
    for (const cte of list.ctes) {
      if (!cte.materialized) continue; // (b)
      for (const idx of cte.limits) allowed.add(idx); // (a): cte.limits holds top-level body tokens only
    }
  }
  return analysis.limits.filter((_, idx) => !allowed.has(idx));
}

const violations = [];
const parseErrors = [];
let scanned = 0;

let files;
try {
  files = [...sourceFilesFrom(createAstProject(), SCAN_ROOTS, ROOT, EXTENSIONS)];
} catch (err) {
  console.error(`check-limited-subquery-write: ${err.message}`);
  process.exit(1);
}

// Per scan root, so a root that silently drops out (renamed, emptied) fails
// the gate instead of shrinking the scanned set unnoticed.
const scannedPerRoot = new Map(SCAN_ROOTS.map((root) => [root, 0]));

for (const { rel, sf } of files) {
  scanned++;
  const root = SCAN_ROOTS.find((r) => rel.startsWith(`${r}/`));
  if (root !== undefined) scannedPerRoot.set(root, scannedPerRoot.get(root) + 1);
  const diagnostics = sf.compilerNode.parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length > 0) {
    parseErrors.push(rel);
    continue;
  }
  for (const kind of LITERAL_KINDS) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const input = sqlInputFromNode(node);
      if (input === null) continue;
      let analysis;
      try {
        analysis = analyzeSql(input);
      } catch (err) {
        parseErrors.push(`${rel}:${node.getStartLineNumber()} (${err.message})`);
        continue;
      }
      for (const { limit, reason } of deniedLimits(analysis)) {
        violations.push({ rel, line: node.getStartLineNumber() + limit.line, kind: limit.kind, reason });
      }
    }
  }
}

let failed = false;
const emptyRoots = SCAN_ROOTS.filter((root) => scannedPerRoot.get(root) === 0);
if (emptyRoots.length > 0) {
  failed = true;
  console.error(
    `ZERO_FILES_SCANNED: check-limited-subquery-write found no source files under ${emptyRoots.join(", ")} (root ${ROOT}).`,
  );
}
if (parseErrors.length > 0) {
  failed = true;
  console.error("PARSE_ERROR: these files could not be analysed:");
  for (const p of parseErrors) console.error(`  ${p}`);
}
const keywordOf = (v) => (v.kind === "FETCH" ? "FETCH FIRST|NEXT" : "LIMIT");
const byLocation = (a, b) => a.rel.localeCompare(b.rel) || a.line - b.line;
const unrecognised = violations.filter((v) => v.reason === UNRECOGNISED_WRITE).sort(byLocation);
const misplaced = violations.filter((v) => v.reason === LIMITED_SUBQUERY_WRITE).sort(byLocation);
if (unrecognised.length > 0) {
  failed = true;
  console.error(
    "UNRECOGNISED_WRITE: a LIMIT/FETCH shares a literal with an UPDATE/DELETE/MERGE this gate cannot read as a statement, so it cannot tell what the LIMIT bounds:",
  );
  for (const v of unrecognised) console.error(`  ${v.rel}:${v.line}  ${keywordOf(v)} next to an unrecognised write`);
  console.error(
    "\nWrite the statement in a form the gate reads (DELETE FROM <t>, UPDATE <t> … SET, MERGE INTO <t> … THEN UPDATE|DELETE, " +
      "INSERT INTO <t> … ON CONFLICT … DO UPDATE) at statement position, bounded by the C1 shape:\n  " +
      C1_SHAPE,
  );
}
if (misplaced.length > 0) {
  failed = true;
  console.error("LIMITED_SUBQUERY_WRITE: a LIMIT/FETCH bounds a write from a position PostgreSQL may rescan per row:");
  for (const v of misplaced) {
    console.error(`  ${v.rel}:${v.line}  ${keywordOf(v)} in a write statement outside a depth-0 MATERIALIZED CTE body`);
  }
  console.error(`\nSelect the key set once in a materialized CTE instead (plan: worker-batch-limit-overrun, C1):\n  ${C1_SHAPE}`);
}
if (failed) process.exit(1);

console.log(`check-limited-subquery-write: OK (${scanned} files)`);
