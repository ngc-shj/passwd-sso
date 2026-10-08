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
 * if the literal holds a write statement — an UPDATE or DELETE in statement
 * position (the start of the literal, after `;`, the start of a CTE body, or
 * the main statement after a WITH list) that parses as `DELETE FROM <target>`
 * or `UPDATE <target> … SET`, so `FOR UPDATE` / `FOR NO KEY UPDATE` never
 * counts — then every `LIMIT` and every `FETCH FIRST|NEXT` token in it must sit
 *   (a) at the top level of a CTE body,
 *   (b) of a CTE declared `AS MATERIALIZED (` (token-exact: `AS NOT
 *       MATERIALIZED` does not count),
 *   (c) in a WITH list at the literal's parenthesis depth 0 (the write
 *       statement's own list; a materialized CTE nested inside an expression
 *       is re-evaluated per row when correlated, so it does not count).
 * Any other position denies, naming the file and line and giving the C1 shape.
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
 * one the INV4 guard's LIMIT-location clause also accepts. It says nothing
 * about writes without a LIMIT; those are INV4's concern.
 *
 * Declared bypasses (each pinned by an allow row in the self-test):
 *   - SQL split across several literals or built by concatenation: each
 *     literal is judged alone, so a write in one and its LIMIT in another
 *     is not seen together;
 *   - the bounding subquery placed in a separate raw-SQL fragment that is
 *     interpolated into the write (the substitution is opaque);
 *   - SQL in prisma/migrations/*.sql (not a scanned extension) and plpgsql
 *     bodies (a dollar-quoted body is a string constant to this scanner).
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

const C1_SHAPE =
  "WITH picked AS MATERIALIZED (SELECT <keys> FROM <table> WHERE … ORDER BY … LIMIT $n [FOR UPDATE SKIP LOCKED]) " +
  "<UPDATE|DELETE> … WHERE (<keys>) IN (SELECT <keys> FROM picked) …";

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

for (const { rel, sf } of files) {
  scanned++;
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
      for (const limit of misplacedLimits(analysis)) {
        violations.push({ rel, line: node.getStartLineNumber() + limit.line, kind: limit.kind });
      }
    }
  }
}

let failed = false;
if (scanned === 0) {
  failed = true;
  console.error(
    `ZERO_FILES_SCANNED: check-limited-subquery-write found no source files under ${SCAN_ROOTS.join(", ")} (root ${ROOT}).`,
  );
}
if (parseErrors.length > 0) {
  failed = true;
  console.error("PARSE_ERROR: these files could not be analysed:");
  for (const p of parseErrors) console.error(`  ${p}`);
}
if (violations.length > 0) {
  failed = true;
  console.error("LIMITED_SUBQUERY_WRITE: a LIMIT/FETCH bounds a write from a position PostgreSQL may rescan per row:");
  violations.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  for (const v of violations) {
    const keyword = v.kind === "FETCH" ? "FETCH FIRST|NEXT" : "LIMIT";
    console.error(`  ${v.rel}:${v.line}  ${keyword} in a write statement outside a depth-0 MATERIALIZED CTE body`);
  }
  console.error(`\nSelect the key set once in a materialized CTE instead (plan: worker-batch-limit-overrun, C1):\n  ${C1_SHAPE}`);
}
if (failed) process.exit(1);

console.log(`check-limited-subquery-write: OK (${scanned} files)`);
