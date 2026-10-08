/**
 * Parity test for scripts/checks/worker-policy-manifest.json (security-review-followups
 * plan, C5 / F7 / P4).
 *
 * The manifest is a machine-readable security classification of every
 * non-request execution context that opens a DB connection or drives one
 * (audit-outbox-worker, retention-gc-worker, audit-anchor-publisher,
 * audit-chain-verify-worker). Two kinds of fields exist, mirroring
 * route-policy-manifest.test.ts:
 *   - Mechanically verified fields (`rawSql`, `destructive`, `emitsAudit`,
 *     `usesSecurityDefiner`) are re-derived here by grepping the entry's
 *     declared `modules` file contents against the SAME defining regexes the
 *     plan locks (see C5 in docs/archive/review/security-review-followups-plan.md).
 *   - Doc fields (`tenantScoped.reason`, `idempotent`, `retryPolicy`,
 *     `poisonMessageHandling`, `retentionPolicyTouched`) are only checked for
 *     presence/shape (>=10-char prose where applicable) — their prose accuracy
 *     is a human review concern (SC3), same trust level as route-policy-manifest
 *     .json's `handlerAuthReason`.
 *
 * Per the worker-runtime-invariants plan (C5, INV4/INV5), two further fields are
 * mechanized:
 *   - `sweepBounds` (every `rawSql: true` entry): every raw-SQL DELETE/UPDATE
 *     write statement the shared scanner (scripts/checks/lib/sql-scan.mjs)
 *     reads in the entry's modules must be capped by a materialized key set
 *     (worker-batch-limit-overrun plan, C4), single-row-by-id, or covered by
 *     exactly one tight, used `sweepBounds.exemptions[]` entry (INV4). A MERGE,
 *     an upsert and any UPDATE/DELETE/MERGE word the scanner cannot read as a
 *     statement are always unbounded.
 *   - `runtimeBounds` (audit-outbox-worker only): cross-checked against the
 *     literal constants in src/lib/constants/audit/audit.ts and the
 *     `@default(8)` maxAttempts lines in prisma/schema.prisma (INV5).
 *
 * Filesystem-only (readdirSync/readFileSync/JSON.parse) — no @prisma/client
 * import, so this stays safe to run even without a generated Prisma client
 * (though the plan notes this rides the normal vitest job, not the
 * Prisma-generate-free static-checks job).
 *
 * Member-set derivation (R42, code-derived; primitive-anchored per plan C5
 * round-2 S4 fix): candidate set = recursive walk of src/workers (*.ts, not
 * *.test.ts) UNION every file among scripts/*.ts (non-recursive) + prisma/seed.ts
 * whose CONTENT matches /new PrismaClient\(|new Pool\(|from "@\/lib\/prisma"/ —
 * the grep keys on the DB-connection-opening primitive itself, not filename
 * conventions, so a future script that opens a connection surfaces automatically.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseRouteSource } from "../proxy/ast-guards";
import { SyntaxKind } from "ts-morph";
// The SQL scanner shared with check-limited-subquery-write.mjs (C2), so the
// two tripwires read write statements, WITH lists and LIMITs the same way.
import {
  TOKEN,
  analyzeSql,
  keyListOf,
  matchKeySelect,
  nameOf,
  sqlInputFromNode,
  sqlInputFromSourceText,
} from "../../../scripts/checks/lib/sql-scan.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKERS_DIR = path.join(REPO_ROOT, "src/workers");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// SECURITY DEFINER function names, extracted from the migration that creates
// them (grep 'CREATE OR REPLACE FUNCTION' / 'CREATE FUNCTION' / 'SECURITY DEFINER'
// against prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql).
// The sibling migration 20260618000000_add_retention_gc_worker_role only GRANTs
// EXECUTE on the existing audit_log_purge function — it defines no new function.
const SECURITY_DEFINER_FUNCTION_NAMES = ["audit_log_purge", "audit_log_tenant_migrate"] as const;

interface SweepBounds {
  value: boolean;
  exemptions: SweepExemption[];
}

interface RuntimeBounds {
  batchSizeEnv: string;
  batchSizeDefault: number;
  maxAttemptsDefault: number;
  reapBatchSize: number;
  purgeBatchSize: number;
}

interface WorkerEntry {
  entrypoint: string;
  modules: string[];
  "$modules-note"?: string;
  dbRole: string;
  tenantScoped: { value: boolean; reason: string };
  usesSecurityDefiner: boolean;
  rawSql: boolean;
  destructive: boolean;
  emitsAudit: boolean;
  idempotent: string;
  retryPolicy: string;
  poisonMessageHandling: string;
  retentionPolicyTouched: string[];
  sweepBounds?: SweepBounds;
  runtimeBounds?: RuntimeBounds;
}

interface Manifest {
  "$schema-note": string;
  "$documented-exclusions": Record<string, string>;
  workers: Record<string, WorkerEntry>;
}

const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "scripts/checks/worker-policy-manifest.json"), "utf8"),
) as Manifest;

const RAW_SQL_RE = /\$queryRaw|\$executeRaw/;
const DESTRUCTIVE_RE = /deleteMany|DELETE FROM/i;
const EMITS_AUDIT_RE = /logAudit|enqueueAudit|AUDIT_ACTION/;

// Recursively walk src/workers, collecting *.ts files (excluding *.test.ts),
// repo-relative.
function walkWorkerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkWorkerFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  return out;
}

// Non-recursive scripts/*.ts whose content opens a DB connection (directly or
// via the app singleton), plus prisma/seed.ts if it matches.
const DB_OPEN_RE = /new PrismaClient\(|new Pool\(|from "@\/lib\/prisma"/;

function findDbOpeningScripts(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const full = path.join(SCRIPTS_DIR, entry.name);
    const content = readFileSync(full, "utf8");
    if (DB_OPEN_RE.test(content)) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  const seedPath = path.join(REPO_ROOT, "prisma/seed.ts");
  if (DB_OPEN_RE.test(readFileSync(seedPath, "utf8"))) {
    out.push("prisma/seed.ts");
  }
  return out;
}

const workerCandidates = walkWorkerFiles(WORKERS_DIR).sort();
const scriptCandidates = findDbOpeningScripts().sort();
const allCandidates = [...new Set([...workerCandidates, ...scriptCandidates])].sort();

const entries = Object.values(manifest.workers);
const claimedModules = new Set(entries.flatMap((e) => e.modules));
const exclusionKeys = Object.keys(manifest["$documented-exclusions"]);

// ---------------------------------------------------------------------------
// C5 sweep-boundedness classifier (INV4).
// ---------------------------------------------------------------------------

export interface SweepExemption {
  module: string;
  match: string;
  reason: string;
}

export interface SweepViolation {
  statement: string;
  kind: "unbounded" | "unused-exemption" | "ambiguous-exemption" | "loose-exemption";
  detail: string;
}

/**
 * One raw-SQL literal: its source text (what an exemption's `match` and a
 * violation message read) and the scanner input (the literal's cooked text
 * split around its `${…}` substitutions, each an opaque token).
 */
type SqlInput = ReturnType<typeof sqlInputFromSourceText>;

export interface SweepStatement {
  text: string;
  input: SqlInput;
}

type SqlAnalysis = ReturnType<typeof analyzeSql>;
type SqlWrite = SqlAnalysis["writes"][number];
type SqlUnrecognisedWrite = SqlAnalysis["unrecognisedWrites"][number];

/** A test-side statement built from template source text (`…${expr}…`). */
function sqlStatement(text: string): SweepStatement {
  return { text, input: sqlInputFromSourceText(text) };
}

// Per-table primary/unique-key registry (S6): a single-row pass or an exemption
// may only bind a column that is actually a PK/unique key for THAT table — a
// bare `WHERE tenant_id =` is single-row on audit_chain_anchors (tenant_id is
// its PK) but multi-row on audit_outbox. Anchor the check to (table, key-column)
// pairs derived from prisma/schema.prisma, never a blanket "tenant_id is unique".
const PK_BY_TABLE: Record<string, readonly string[]> = {
  audit_chain_anchors: ["tenant_id"], // @@map, PK is tenant_id (one row per tenant)
};
// Every table has `id` as its primary key unless overridden above.
const DEFAULT_PK_COLUMNS = ["id"] as const;

/**
 * Key columns of the write's target table. The target comes from the
 * scanner's reading of the write's own grammar (`DELETE FROM <t>` /
 * `UPDATE <t> … SET`), so `FOR UPDATE SKIP LOCKED` in a CTE body is never
 * read as a table. An opaque `${…}` target has no name and resolves to the
 * default key (declared residual).
 */
function pkColumnsOf(write: SqlWrite): readonly string[] {
  const table = write.target.name;
  if (table !== null && Object.hasOwn(PK_BY_TABLE, table)) return PK_BY_TABLE[table];
  return DEFAULT_PK_COLUMNS;
}

// A right-hand side that names one value: `$1`, `42`, `'x'`, `${v}`.
const SCALAR_TOKEN_TYPES: ReadonlySet<string> = new Set([
  TOKEN.PARAM,
  TOKEN.NUMBER,
  TOKEN.STRING,
  TOKEN.OPAQUE,
]);

/** True when tokens [from, end) are only `::type` casts. */
function isCastsOnly(analysis: SqlAnalysis, from: number, end: number): boolean {
  const { tokens } = analysis;
  for (let j = from; j < end; j += 3) {
    if (tokens[j]?.text !== ":" || tokens[j + 1]?.text !== ":" || tokens[j + 2]?.type !== TOKEN.WORD) {
      return false;
    }
    if (j + 3 > end) return false;
  }
  return true;
}

/**
 * True when every key column of the write's table is pinned by a top-level
 * AND conjunct `<key> = <one value>[::type]` — e.g.
 * `UPDATE audit_chain_anchors ... WHERE tenant_id = $3::uuid` (tenant_id is
 * that table's PK) or any `... WHERE id = $1`. An equality under OR or NOT,
 * inside a subselect, against `ANY(…)` or a column, or on a column that is not
 * the table's key does not count.
 */
function isTopLevelSingleRowByKey(analysis: SqlAnalysis, write: SqlWrite): boolean {
  const { tokens } = analysis;
  const pinned = new Set<string>();
  // A conjunct under a top-level OR or a leading NOT is never exactly
  // `<key> = <value>`, so the shape check below excludes it too.
  for (const c of write.conjuncts) {
    const key = tokens[c.start];
    const op = tokens[c.start + 1];
    const value = tokens[c.start + 2];
    if (key.type !== TOKEN.WORD && key.type !== TOKEN.QIDENT) continue;
    if (op?.type !== TOKEN.OP || op.text !== "=") continue;
    if (value === undefined || !SCALAR_TOKEN_TYPES.has(value.type)) continue;
    if (!isCastsOnly(analysis, c.start + 3, c.end)) continue;
    const name = nameOf(key);
    if (name !== null) pinned.add(name);
  }
  return pkColumnsOf(write).every((key) => pinned.has(key));
}

/** Tokens of type OPAQUE in [start, end). */
function opaqueCount(analysis: SqlAnalysis, start: number, end: number): number {
  return analysis.tokens.slice(start, end).filter((t) => t.type === TOKEN.OPAQUE).length;
}

/**
 * The IN group's key list names exactly the write's mutated keys: the table's
 * key columns, or one identical `${…}` substitution in both positions (M11,
 * M12 — C4 cannot resolve it to a key; declared residual).
 */
function isWriteKeyList(
  analysis: SqlAnalysis,
  write: SqlWrite,
  group: NonNullable<SqlWrite["conjuncts"][number]["inGroup"]>,
  keys: readonly string[],
): boolean {
  if (
    keys.length === 1 &&
    opaqueCount(analysis, group.lhs.start, group.lhs.end) === 1 &&
    opaqueCount(analysis, group.open + 1, group.close ?? group.open + 1) === 1
  ) {
    return true;
  }
  const pk = pkColumnsOf(write);
  return keys.length === pk.length && pk.every((key) => keys.includes(key));
}

// A LIMIT argument that is one bounded value. `LIMIT ALL` and `LIMIT NULL`
// (or any expression the scanner cannot read as one value) do not bound.
const BOUNDING_LIMIT_ARG_TYPES: ReadonlySet<string> = new Set([TOKEN.PARAM, TOKEN.NUMBER, TOKEN.OPAQUE]);

function isBoundingLimit(analysis: SqlAnalysis, limitIndex: number): boolean {
  const limit = analysis.limits[limitIndex];
  if (limit.kind !== "LIMIT") return false;
  const arg = analysis.tokens[limit.token + 1];
  return arg !== undefined && BOUNDING_LIMIT_ARG_TYPES.has(arg.type);
}

/**
 * True when the write caps its mutated key set with the C1 shape
 * (worker-batch-limit-overrun plan, C4):
 *
 *   WITH <cte> AS MATERIALIZED (SELECT <keys> … LIMIT n)
 *   <UPDATE|DELETE> … WHERE … AND (<keys>) IN (SELECT <keys> FROM <cte>) AND …
 *
 * Every clause is required:
 *   - the IN is a top-level AND conjunct of the write's own WHERE (not under
 *     OR or NOT — the scanner links `inGroup` only then);
 *   - the IN body is exactly `SELECT <keys> FROM <name>`: no WHERE, set
 *     operation, join or second FROM item;
 *   - the IN list and the projection are the same keys, and they are the
 *     table's key columns (or one identical `${…}`);
 *   - <name> is a CTE of the write's own WITH list, which sits at the
 *     literal's depth 0, declared before the write when the write is itself a
 *     CTE body (a non-recursive WITH sees only earlier CTEs);
 *   - that CTE is `AS MATERIALIZED` (token-exact) — an inlined CTE is the
 *     rescannable pre-fix shape again;
 *   - its body has a top-level `LIMIT` with one bounded value.
 * A materialized CTE is evaluated once per statement, so the LIMIT caps the
 * keys the write can touch. Anything else is "unbounded".
 */
function isKeySetLimited(analysis: SqlAnalysis, write: SqlWrite): boolean {
  if (write.withList === null) return false;
  const list = analysis.withLists[write.withList];
  if (list.depth !== 0) return false;
  return write.conjuncts.some((conjunct) => {
    const group = conjunct.inGroup;
    if (group === null) return false;
    const select = matchKeySelect(analysis, group.open, group.close);
    if (select === null) return false;
    const keys = keyListOf(analysis, group.lhs.start, group.lhs.end);
    if (keys === null || keys.length !== select.keys.length) return false;
    if (!keys.every((key, i) => key === select.keys[i])) return false;
    if (!isWriteKeyList(analysis, write, group, keys)) return false;
    const cteIndex = list.ctes.findIndex((cte) => cte.name === select.from);
    if (cteIndex === -1) return false;
    if (write.cte !== null && (list.recursive ? cteIndex === write.cte : cteIndex >= write.cte)) return false;
    const cte = list.ctes[cteIndex];
    return cte.materialized && cte.limits.some((idx) => isBoundingLimit(analysis, idx));
  });
}

/**
 * A write is bounded iff it mutates a single row by its table's PK, or caps
 * its mutated key set with the C1 shape. Postgres has no `LIMIT` on
 * DELETE/UPDATE, so a LIMIT anywhere else (an EXISTS probe, a subselect
 * inside IN) does not bound it. A MERGE's rows come from its join and an
 * upsert's from its INSERT source; the scanner gives both no WHERE and no
 * conjuncts, so each matches neither shape and is unbounded (no current
 * member uses either).
 */
function isBounded(analysis: SqlAnalysis, write: SqlWrite): boolean {
  return isTopLevelSingleRowByKey(analysis, write) || isKeySetLimited(analysis, write);
}

function describeWrite(write: SqlWrite): string {
  const target = write.target.name ?? (write.target.opaque !== null ? `\${${write.target.opaque}}` : "?");
  return `${write.kind} ${target} (literal line ${write.line + 1})`;
}

function describeUnrecognisedWrite(word: SqlUnrecognisedWrite): string {
  return `unrecognised ${word.word} (literal line ${word.line + 1})`;
}

/**
 * Pure classifier: given the raw-SQL literals holding a write for one worker
 * module plus the exemptions scoped to that module, returns the list of
 * sweep-boundedness violations. Every write statement in a literal is judged
 * on its own, so a bounded write does not carry a second write in the same
 * literal. An empty array means every write passes.
 */
export function classifySweeps(
  statements: SweepStatement[],
  exemptions: SweepExemption[],
): SweepViolation[] {
  const violations: SweepViolation[] = [];
  const analysed = statements.map((statement) => ({ statement, analysis: analyzeSql(statement.input) }));
  const isSingleRowLiteral = ({ analysis }: (typeof analysed)[number]): boolean =>
    analysis.unrecognisedWrites.length === 0 &&
    analysis.writes.length > 0 &&
    analysis.writes.every((write) => isTopLevelSingleRowByKey(analysis, write));

  // Pre-compute, for every exemption, which literals its `match` hits and
  // whether the literal it identifies is itself already single-row (an
  // exemption may only DOCUMENT an already-single-row statement, never GRANT
  // boundedness to an unbounded sweep — S5/S6).
  const exemptionMatches = exemptions.map((exemption) => ({
    exemption,
    matching: analysed.filter(({ statement }) => statement.text.includes(exemption.match)),
  }));

  for (const { exemption, matching } of exemptionMatches) {
    if (matching.length === 0) {
      violations.push({
        statement: exemption.match,
        kind: "unused-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) does not appear in any extracted statement`,
      });
      continue;
    }
    if (matching.length >= 2) {
      violations.push({
        statement: exemption.match,
        kind: "ambiguous-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) matches ${matching.length} statements — must match exactly 1`,
      });
      continue;
    }
    // Tightness gate: every write in the target literal must be a top-level
    // single-row equality on its table's PK (subselects do not count). A
    // key-set-bounded write needs no exemption (it passes on its own).
    if (!isSingleRowLiteral(matching[0])) {
      violations.push({
        statement: matching[0].statement.text,
        kind: "loose-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) identifies a statement that is not a top-level single-row equality on the table's primary key (subselect-internal equality or a non-PK column does not count): ${matching[0].statement.text}`,
      });
    }
  }

  const tightlyExempted = new Set(
    exemptionMatches
      .filter(({ matching }) => matching.length === 1 && isSingleRowLiteral(matching[0]))
      .map(({ matching }) => matching[0]),
  );

  for (const entry of analysed) {
    // An unrecognised write is never exempted: an exemption on its literal
    // is loose (isSingleRowLiteral), so the literal is never tightly exempted.
    for (const word of entry.analysis.unrecognisedWrites) {
      violations.push({
        statement: entry.statement.text,
        kind: "unbounded",
        detail: `${describeUnrecognisedWrite(word)}: the scanner cannot read this write as a statement, so its bound cannot be judged: ${entry.statement.text}`,
      });
    }
    if (tightlyExempted.has(entry)) continue;
    for (const write of entry.analysis.writes) {
      if (isBounded(entry.analysis, write)) continue;
      violations.push({
        statement: entry.statement.text,
        kind: "unbounded",
        detail: `${describeWrite(write)}: not a top-level single-row PK equality, not \`(<keys>) IN (SELECT <keys> FROM <materialized CTE with LIMIT>)\` as a top-level AND conjunct, and no valid exemption covers it: ${entry.statement.text}`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// C5 extraction (assertion 1): every string/template literal in a module's AST
// that the shared scanner reads as holding a write statement (statement-
// position UPDATE/DELETE/MERGE/upsert with its own grammar, any case) or an
// unrecognised UPDATE/DELETE/MERGE word.
// ---------------------------------------------------------------------------

const LITERAL_KINDS = [
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression,
] as const;

function extractSweepStatementsFromSource(source: string, modulePath: string): SweepStatement[] {
  const sf = parseRouteSource(source, modulePath);
  const statements: SweepStatement[] = [];
  for (const kind of LITERAL_KINDS) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const input = sqlInputFromNode(node);
      if (input === null) continue;
      const analysis = analyzeSql(input);
      if (analysis.writes.length > 0 || analysis.unrecognisedWrites.length > 0) {
        statements.push({ text: node.getText(), input });
      }
    }
  }
  return statements;
}

function extractSweepStatements(modulePath: string): SweepStatement[] {
  return extractSweepStatementsFromSource(
    readFileSync(path.join(REPO_ROOT, modulePath), "utf8"),
    modulePath,
  );
}

describe("worker-policy-manifest.json parity", () => {
  it("assertion 1: every candidate module is claimed by exactly one entry OR documented-excluded", () => {
    const unclaimed: string[] = [];
    for (const candidate of allCandidates) {
      const claimCount = entries.filter((e) => e.modules.includes(candidate)).length;
      const isExcluded = exclusionKeys.includes(candidate);
      if (claimCount === 0 && !isExcluded) {
        unclaimed.push(candidate);
      }
      if (claimCount > 1) {
        unclaimed.push(`${candidate} (claimed by ${claimCount} entries — must be exactly 1)`);
      }
      if (claimCount >= 1 && isExcluded) {
        unclaimed.push(`${candidate} (both claimed by an entry AND documented-excluded)`);
      }
    }
    expect(unclaimed, `unclaimed/misclaimed candidates: ${unclaimed.join(", ")}`).toEqual([]);
  });

  it("assertion 2: every manifest modules/entrypoint path exists on disk", () => {
    const missing: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      if (!allCandidates.includes(entry.entrypoint)) {
        // entrypoint is a thin launcher, not a DB-opening candidate — check
        // file existence directly instead.
        try {
          readFileSync(path.join(REPO_ROOT, entry.entrypoint), "utf8");
        } catch {
          missing.push(`${name}: entrypoint ${entry.entrypoint} does not exist`);
        }
      }
      for (const mod of entry.modules) {
        try {
          readFileSync(path.join(REPO_ROOT, mod), "utf8");
        } catch {
          missing.push(`${name}: module ${mod} does not exist`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("assertion 3: every $documented-exclusions key exists on disk, is not claimed by an entry, and has a >=10-char reason", () => {
    const violations: string[] = [];
    for (const [key, reason] of Object.entries(manifest["$documented-exclusions"])) {
      try {
        readFileSync(path.join(REPO_ROOT, key), "utf8");
      } catch {
        violations.push(`${key}: excluded path does not exist on disk`);
      }
      if (claimedModules.has(key)) {
        violations.push(`${key}: is both documented-excluded AND claimed by a manifest entry`);
      }
      if (typeof reason !== "string" || reason.length < 10) {
        violations.push(`${key}: exclusion reason missing or <10 chars`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 4: rawSql <=> RAW_SQL_RE hit in at least one module, both directions", () => {
    const mismatches: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      const anyMatch = entry.modules.some((mod) =>
        RAW_SQL_RE.test(readFileSync(path.join(REPO_ROOT, mod), "utf8")),
      );
      if (entry.rawSql !== anyMatch) {
        mismatches.push(`${name}: declared rawSql=${entry.rawSql} actual=${anyMatch}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 5: destructive <=> DESTRUCTIVE_RE hit in at least one module, both directions", () => {
    const mismatches: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      const anyMatch = entry.modules.some((mod) =>
        DESTRUCTIVE_RE.test(readFileSync(path.join(REPO_ROOT, mod), "utf8")),
      );
      if (entry.destructive !== anyMatch) {
        mismatches.push(`${name}: declared destructive=${entry.destructive} actual=${anyMatch}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 6: emitsAudit <=> EMITS_AUDIT_RE hit in at least one module, both directions", () => {
    const mismatches: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      const anyMatch = entry.modules.some((mod) =>
        EMITS_AUDIT_RE.test(readFileSync(path.join(REPO_ROOT, mod), "utf8")),
      );
      if (entry.emitsAudit !== anyMatch) {
        mismatches.push(`${name}: declared emitsAudit=${entry.emitsAudit} actual=${anyMatch}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 7: usesSecurityDefiner <=> a SECURITY DEFINER function name appears in at least one module, both directions", () => {
    const definerRe = new RegExp(SECURITY_DEFINER_FUNCTION_NAMES.join("|"));
    const mismatches: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      const anyMatch = entry.modules.some((mod) =>
        definerRe.test(readFileSync(path.join(REPO_ROOT, mod), "utf8")),
      );
      if (entry.usesSecurityDefiner !== anyMatch) {
        mismatches.push(`${name}: declared usesSecurityDefiner=${entry.usesSecurityDefiner} actual=${anyMatch}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("assertion 8: doc-field presence — idempotent/retryPolicy/poisonMessageHandling are prose >=10 chars, no bare booleans", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      for (const field of ["idempotent", "retryPolicy", "poisonMessageHandling"] as const) {
        const value = entry[field];
        if (typeof value !== "string" || value.length < 10) {
          violations.push(`${name}.${field}: missing, not a string, or <10 chars`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 9: tenantScoped is {value: boolean, reason: string >=10 chars}", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      const ts = entry.tenantScoped;
      if (!ts || typeof ts.value !== "boolean") {
        violations.push(`${name}.tenantScoped.value: missing or not boolean`);
      }
      if (!ts || typeof ts.reason !== "string" || ts.reason.length < 10) {
        violations.push(`${name}.tenantScoped.reason: missing or <10 chars`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 10: retentionPolicyTouched is an array for every entry", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      if (!Array.isArray(entry.retentionPolicyTouched)) {
        violations.push(`${name}.retentionPolicyTouched: not an array`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 11: dbRole is a non-empty string for every entry", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      if (typeof entry.dbRole !== "string" || entry.dbRole.length === 0) {
        violations.push(`${name}.dbRole: missing or empty`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("assertion 12 (sweepBounds, INV4): every rawSql=true worker's extracted sweep statements are LIMIT-bounded, single-row-by-id, or tightly exempted", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(manifest.workers)) {
      if (!entry.rawSql) continue;

      if (!entry.sweepBounds || typeof entry.sweepBounds.value !== "boolean" || !Array.isArray(entry.sweepBounds.exemptions)) {
        violations.push(`${name}: sweepBounds missing or malformed (expected {value:true, exemptions:[]})`);
        continue;
      }

      const exemptionsByModule = new Map<string, SweepExemption[]>();
      for (const exemption of entry.sweepBounds.exemptions) {
        const list = exemptionsByModule.get(exemption.module) ?? [];
        list.push(exemption);
        exemptionsByModule.set(exemption.module, list);
      }

      for (const mod of entry.modules) {
        const moduleStatements = extractSweepStatements(mod);
        const moduleExemptions = exemptionsByModule.get(mod) ?? [];
        const moduleViolations = classifySweeps(moduleStatements, moduleExemptions);
        for (const violation of moduleViolations) {
          violations.push(`${name} (${mod}) [${violation.kind}]: ${violation.detail}`);
        }
      }

    }
    expect(violations, `sweepBounds violations:\n${violations.join("\n")}`).toEqual([]);
  });

  it("assertion 13 (runtimeBounds, INV5, audit-outbox-worker only): manifest runtimeBounds cross-checks constants + schema defaults", () => {
    const entry = manifest.workers["audit-outbox-worker"];
    expect(entry.runtimeBounds, "audit-outbox-worker.runtimeBounds is required").toBeDefined();
    const bounds = entry.runtimeBounds as RuntimeBounds;

    const constantsSource = readFileSync(
      path.join(REPO_ROOT, "src/lib/constants/audit/audit.ts"),
      "utf8",
    );
    const violations: string[] = [];

    const expectedBatchSize = `envInt("${bounds.batchSizeEnv}", ${bounds.batchSizeDefault})`;
    if (!constantsSource.includes(expectedBatchSize)) {
      violations.push(`audit.ts missing expected batch-size constant: ${expectedBatchSize}`);
    }

    const expectedMaxAttempts = `MAX_ATTEMPTS: envInt("OUTBOX_MAX_ATTEMPTS", ${bounds.maxAttemptsDefault})`;
    if (!constantsSource.includes(expectedMaxAttempts)) {
      violations.push(`audit.ts missing expected max-attempts constant: ${expectedMaxAttempts}`);
    }

    const expectedReapBatchSize = `REAP_BATCH_SIZE: ${bounds.reapBatchSize}`;
    if (!constantsSource.includes(expectedReapBatchSize)) {
      violations.push(`audit.ts missing expected REAP_BATCH_SIZE: ${expectedReapBatchSize}`);
    }

    const expectedPurgeBatchSize = `PURGE_BATCH_SIZE: ${bounds.purgeBatchSize}`;
    if (!constantsSource.includes(expectedPurgeBatchSize)) {
      violations.push(`audit.ts missing expected PURGE_BATCH_SIZE: ${expectedPurgeBatchSize}`);
    }

    const schemaSource = readFileSync(path.join(REPO_ROOT, "prisma/schema.prisma"), "utf8");
    const maxAttemptsLines = schemaSource
      .split("\n")
      .filter((line) => line.includes("maxAttempts") && line.includes("@map(\"max_attempts\")"));

    if (maxAttemptsLines.length !== 3) {
      violations.push(
        `prisma/schema.prisma: expected exactly 3 maxAttempts lines (AuditOutbox, AuditDelivery, WebhookDelivery), found ${maxAttemptsLines.length}`,
      );
    }
    for (const line of maxAttemptsLines) {
      if (!line.includes(`@default(${bounds.maxAttemptsDefault})`)) {
        violations.push(`prisma/schema.prisma: maxAttempts line missing @default(${bounds.maxAttemptsDefault}): ${line.trim()}`);
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("classifySweeps self-test (RT7 proof — the guard must be able to fail)", () => {
  const classify = (texts: string[], exemptions: SweepExemption[] = []): SweepViolation[] =>
    classifySweeps(texts.map(sqlStatement), exemptions);

  it("(a) an unbounded DELETE with no LIMIT, no WHERE id=, no exemption is flagged", () => {
    const violations = classify(["DELETE FROM x WHERE status = 'SENT'"]);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unbounded");
  });

  it("(b) a DELETE capped by a materialized key-set CTE (C1 shape) passes", () => {
    const violations = classify([
      "WITH picked AS MATERIALIZED (SELECT id FROM x WHERE status = 'SENT' LIMIT 5) DELETE FROM x WHERE id IN (SELECT id FROM picked)",
    ]);
    expect(violations).toEqual([]);
  });

  it("(b2) the pre-fix shape — LIMIT inside the IN subselect, which a rescan re-evaluates — is flagged", () => {
    const violations = classify(["DELETE FROM x WHERE id IN (SELECT id FROM x WHERE status = 'SENT' LIMIT 5)"]);
    expect(violations.map((v) => v.kind)).toEqual(["unbounded"]);
  });

  it("(c) a single-row top-level WHERE id = statement passes", () => {
    const violations = classify(["DELETE FROM x WHERE id = $1"]);
    expect(violations).toEqual([]);
  });

  it("(d) an exemption whose match no longer appears in any statement is flagged as unused", () => {
    // audit_chain_anchors' PK is tenant_id (PK_BY_TABLE), so this UPDATE is a
    // bona-fide single-row statement and is NOT itself unbounded. The stale
    // exemption (its match never appears) is still flagged unused.
    const violations = classify(
      ["UPDATE audit_chain_anchors SET a=1 WHERE tenant_id = $1"],
      [{ module: "m", match: "UPDATE nonexistent", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "unused-exemption")).toBe(true);
    expect(violations.some((v) => v.kind === "unbounded")).toBe(false);
  });

  it("(e) an over-broad exemption targeting an unbounded, non-PK-WHERE statement is rejected as loose-exemption", () => {
    const violations = classify(
      ["DELETE FROM x WHERE status='SENT'"],
      [{ module: "m", match: "DELETE FROM x", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "loose-exemption")).toBe(true);
  });

  it("(f) an exemption targeting a statement whose only equality is inside a subselect is rejected as loose-exemption, not silently passed", () => {
    const violations = classify(
      ["DELETE FROM x WHERE id IN (SELECT id FROM x WHERE status = 'PROCESSING')"],
      [{ module: "m", match: "DELETE FROM x", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "loose-exemption")).toBe(true);
  });

  it("(g) flags an unbounded DELETE whose only WHERE id= is inside a subselect", () => {
    // The outer DELETE's only `WHERE id =` is buried in a subselect, so it is
    // NOT top-level single-row-shaped: an unbounded multi-row sweep.
    const violations = classify(["DELETE FROM x WHERE owner_id IN (SELECT owner_id FROM y WHERE id = $1)"]);
    expect(violations.some((v) => v.kind === "unbounded")).toBe(true);
  });

  it("(h) flags an unbounded DELETE whose only LIMIT is inside an EXISTS probe", () => {
    // The LIMIT bounds the EXISTS probe, not the number of x rows deleted.
    const violations = classify(["DELETE FROM x WHERE EXISTS (SELECT 1 FROM y LIMIT 1)"]);
    expect(violations.some((v) => v.kind === "unbounded")).toBe(true);
  });

  it("(i) rejects an exemption on `WHERE tenant_id =` for a table whose PK is id (tenant_id is not that table's unique key)", () => {
    // audit_outbox's PK is id; `WHERE tenant_id = $1` selects MANY rows per
    // tenant. An exemption must not be able to declare it single-row just
    // because the column happens to be named tenant_id (which IS the PK on a
    // different table, audit_chain_anchors).
    const violations = classify(
      ["DELETE FROM audit_outbox WHERE tenant_id = $1"],
      [{ module: "m", match: "DELETE FROM audit_outbox", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "loose-exemption")).toBe(true);
  });

  it("(j) accepts the genuine anchor exemption: WHERE tenant_id = on audit_chain_anchors (its PK)", () => {
    // The one real exemption in the manifest. tenant_id IS audit_chain_anchors'
    // primary key, so this is a legitimate single-row UPDATE.
    const violations = classify([
      "UPDATE audit_chain_anchors SET chain_seq=$1, prev_hash=$2 WHERE tenant_id = $3::uuid",
    ]);
    expect(violations).toEqual([]);
  });

  it("(k) a single-row equality against ANY(…) or a column is not single-row", () => {
    expect(classify(["DELETE FROM x WHERE id = ANY($1)"]).map((v) => v.kind)).toEqual(["unbounded"]);
    expect(classify(["DELETE FROM x WHERE id = id"]).map((v) => v.kind)).toEqual(["unbounded"]);
  });

  it("(k2) a key equality under a top-level OR or a leading NOT is not single-row", () => {
    expect(classify(["DELETE FROM x WHERE id = $1 OR status = 'SENT'"]).map((v) => v.kind)).toEqual(["unbounded"]);
    expect(classify(["DELETE FROM x WHERE NOT id = $1"]).map((v) => v.kind)).toEqual(["unbounded"]);
  });

  it("(l) an exemption cannot carry a second, unbounded write in its literal", () => {
    const violations = classify(
      ["UPDATE audit_chain_anchors SET a = 1 WHERE tenant_id = $1; DELETE FROM audit_outbox WHERE status = 'SENT'"],
      [{ module: "m", match: "UPDATE audit_chain_anchors", reason: "x".repeat(10) }],
    );
    expect(violations.map((v) => v.kind).sort()).toEqual(["loose-exemption", "unbounded"]);
  });
});

// C4 pairs (worker-batch-limit-overrun plan): each deny row breaks exactly one
// clause of the C1 shape that the allow rows satisfy.
const C1_CLAIM =
  "WITH picked AS MATERIALIZED (SELECT id FROM t WHERE status = 'PENDING' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) " +
  "UPDATE t SET status = 'PROCESSING' WHERE id IN (SELECT id FROM picked) AND status = 'PENDING' RETURNING *";

const C4_DENY: ReadonlyArray<readonly [string, string]> = [
  [
    "a CTE body without LIMIT, plus a NOT EXISTS (… LIMIT 1) probe",
    "WITH picked AS MATERIALIZED (SELECT id FROM t WHERE status = 'SENT') DELETE FROM t WHERE id IN (SELECT id FROM picked) AND NOT EXISTS (SELECT 1 FROM u WHERE u.t_id = t.id LIMIT 1)",
  ],
  [
    "the IN under a top-level OR",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked) OR status = 'SENT'",
  ],
  [
    "the IN under NOT",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE NOT (id IN (SELECT id FROM picked))",
  ],
  [
    "an IN body with UNION",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked UNION SELECT id FROM t)",
  ],
  [
    "an IN body with a JOIN",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked JOIN t USING (id))",
  ],
  [
    "an IN body with a second FROM item",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked, t)",
  ],
  [
    "a non-key IN column",
    "WITH picked AS MATERIALIZED (SELECT tenant_id FROM t LIMIT $1) DELETE FROM t WHERE tenant_id IN (SELECT tenant_id FROM picked)",
  ],
  [
    "an IN list that differs from the projection",
    "WITH picked AS MATERIALIZED (SELECT owner_id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT owner_id FROM picked)",
  ],
  ["LIMIT ALL", "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT ALL) DELETE FROM t WHERE id IN (SELECT id FROM picked)"],
  ["LIMIT NULL", "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT NULL) DELETE FROM t WHERE id IN (SELECT id FROM picked)"],
  [
    "a LIMIT nested below the CTE body's top level",
    "WITH picked AS MATERIALIZED (SELECT id FROM (SELECT id FROM t LIMIT $1) s) DELETE FROM t WHERE id IN (SELECT id FROM picked)",
  ],
  ["a CTE without MATERIALIZED", "WITH picked AS (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked)"],
  [
    "a CTE declared AS NOT MATERIALIZED",
    "WITH picked AS NOT MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked)",
  ],
  [
    "an IN reading a different CTE name",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1), other AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM other)",
  ],
  [
    "an IN reading a CTE declared after the write's own CTE (not in scope: resolves to a table)",
    "WITH deleted AS (DELETE FROM t WHERE id IN (SELECT id FROM picked) RETURNING id), picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) SELECT count(*) FROM deleted",
  ],
  [
    "a materialized key set in a nested WITH scope, not the literal's depth-0 list",
    "WITH d AS (WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1) DELETE FROM t WHERE id IN (SELECT id FROM picked) RETURNING id) SELECT count(*) FROM d",
  ],
  [
    "nested-scope shadowing: the write binds `picked` to the inner, unbounded CTE",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1), d AS (WITH picked AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM picked) RETURNING id) SELECT count(*) FROM d",
  ],
  [
    "a second, unbounded write in the same literal as a bounded one",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1), d AS (DELETE FROM t WHERE id IN (SELECT id FROM picked) RETURNING id) UPDATE t SET status = 'X' WHERE status = 'SENT'",
  ],
  ["a lowercase unbounded write", "delete from t where status = 'SENT'"],
  [
    "a C1 shape keyed on id for a table whose key is tenant_id (PK_BY_TABLE)",
    "WITH picked AS MATERIALIZED (SELECT id FROM audit_chain_anchors LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE audit_chain_anchors SET a = 1 WHERE (id) IN (SELECT id FROM picked)",
  ],
  [
    "an opaque ${…} target table resolves to the default id key, so a tenant_id key list is not its key",
    "WITH picked AS MATERIALIZED (SELECT tenant_id FROM ${tableIdent} LIMIT $1) DELETE FROM ${tableIdent} WHERE (tenant_id) IN (SELECT tenant_id FROM picked)",
  ],
  [
    "a ${…} key list mixed with a named column (not one identical substitution)",
    "WITH picked AS MATERIALIZED (SELECT ${keyList}, owner_id FROM ${tableIdent} LIMIT $1) DELETE FROM ${tableIdent} WHERE (${keyList}, owner_id) IN (SELECT ${keyList}, owner_id FROM picked)",
  ],
  [
    "${…} key lists whose substitution text differs between the two positions",
    "WITH picked AS MATERIALIZED (SELECT ${keyList} FROM ${tableIdent} LIMIT $1) DELETE FROM ${tableIdent} WHERE (${otherKeys}) IN (SELECT ${keyList} FROM picked)",
  ],
];

const C4_ALLOW: ReadonlyArray<readonly [string, string]> = [
  ["the C1 claim shape", C1_CLAIM],
  [
    "the C1 shape with FOR UPDATE on a PK_BY_TABLE override table (target read from the write, not from SKIP)",
    "WITH picked AS MATERIALIZED (SELECT tenant_id FROM audit_chain_anchors ORDER BY tenant_id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE audit_chain_anchors SET a = 1 WHERE (tenant_id) IN (SELECT tenant_id FROM picked)",
  ],
  [
    "the C1 shape as a CTE-body write reading an earlier CTE",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $2), deleted AS (DELETE FROM t WHERE id IN (SELECT id FROM picked) RETURNING id, tenant_id) SELECT tenant_id, COUNT(*) FROM deleted GROUP BY tenant_id",
  ],
  [
    "residual: identical ${…} key lists in both positions (cannot be resolved to a key)",
    "WITH picked AS MATERIALIZED (SELECT ${keyList} FROM ${tableIdent} LIMIT $1) DELETE FROM ${tableIdent} WHERE (${keyList}) IN (SELECT ${keyList} FROM picked)",
  ],
  [
    "residual: an opaque ${…} target table resolves to the default id key",
    "WITH picked AS MATERIALIZED (SELECT id FROM ${tableIdent} LIMIT $1) DELETE FROM ${tableIdent} WHERE (id) IN (SELECT id FROM picked)",
  ],
];

describe("C4 sweepBounds pairs — the C1 shape and each broken clause", () => {
  it.each(C4_DENY)("deny: %s", (_label, sql) => {
    expect(classifySweeps([sqlStatement(sql)], []).map((v) => v.kind)).toContain("unbounded");
  });

  it.each(C4_ALLOW)("allow: %s", (_label, sql) => {
    expect(classifySweeps([sqlStatement(sql)], [])).toEqual([]);
  });
});

// The fifteen members (worker-batch-limit-overrun plan, M1–M15) read from the
// worker sources as they stand, so a member drifting out of the C1 shape fails
// here by name and the allow side cannot drift from production.
const C1_MEMBERS: ReadonlyArray<readonly [string, string]> = [
  ["src/workers/audit-outbox-worker.ts", "claimOutboxBatchInTx"],
  ["src/workers/audit-outbox-worker.ts", "claimDeliveriesInTx"],
  ["src/workers/audit-outbox-worker.ts", "claimWebhookDeliveriesInTx"],
  ["src/workers/audit-outbox-worker.ts", "reapStuckRowsInTx"],
  ["src/workers/audit-outbox-worker.ts", "reapStuckDeliveriesInTx"],
  ["src/workers/audit-outbox-worker.ts", "reapStuckWebhookDeliveriesInTx"],
  ["src/workers/audit-outbox-worker.ts", "purgeDeliveryRetentionInTx"],
  ["src/workers/audit-outbox-worker.ts", "purgeWebhookDeliveryRetentionInTx"],
  ["src/workers/audit-outbox-worker.ts", "purgeSentAgedInTx"],
  ["src/workers/audit-outbox-worker.ts", "purgeFailedAgedInTx"],
  ["src/workers/retention-gc-worker/sweep.ts", "sweepExpiryEntry"],
  ["src/workers/retention-gc-worker/sweep.ts", "sweepGuardedExpiryEntry"],
  ["src/workers/retention-gc-worker/sweep.ts", "sweepAuditProvenanceEntry"],
  ["src/workers/retention-gc-worker/sweep.ts", "sweepPerTenantAge"],
  ["src/workers/retention-gc-worker/sweep.ts", "sweepExpiredAccessRequests"],
];

describe("C4 allow: each C1 member as it stands in the worker sources", () => {
  it.each(C1_MEMBERS)("%s#%s holds exactly one write, bounded by its materialized key set", (modulePath, fnName) => {
    const sf = parseRouteSource(readFileSync(path.join(REPO_ROOT, modulePath), "utf8"), modulePath);
    const fn = sf.getFunction(fnName);
    expect(fn, `${modulePath}#${fnName} not found`).toBeDefined();
    const writes = extractSweepStatementsFromSource(fn?.getText() ?? "", modulePath).flatMap((statement) => {
      const analysis = analyzeSql(statement.input);
      return analysis.writes.map((write) => ({ analysis, write }));
    });
    expect(writes).toHaveLength(1);
    expect(isKeySetLimited(writes[0].analysis, writes[0].write)).toBe(true);
  });
});

describe("C4 extraction — every write the scanner reads, any case", () => {
  it("extracts a lowercase write and the classifier flags it", () => {
    const statements = extractSweepStatementsFromSource(
      'export const q = "delete from audit_outbox where status = \'SENT\'";',
      "fixture.ts",
    );
    expect(statements).toHaveLength(1);
    expect(classifySweeps(statements, []).map((v) => v.kind)).toEqual(["unbounded"]);
  });

  it("does not extract prose that only starts with Update / Delete", () => {
    expect(
      extractSweepStatementsFromSource('export const m = "Update failed; Delete the row and retry";', "fixture.ts"),
    ).toEqual([]);
  });
});

// S-CR1-1: write forms the scanner first missed. Each deny row is a form that
// overran (MERGE, upsert: rolled-back probes) or that the statement-position
// reader skipped; INV4 must report it, and MERGE / upsert stay unbounded even
// when written in the C1 shape.
const WRITE_FORM_DENY: ReadonlyArray<readonly [string, string]> = [
  [
    "MERGE with the LIMIT in its ON clause",
    "MERGE INTO audit_outbox t USING (SELECT 1 AS one) s ON t.id IN (SELECT id FROM audit_outbox ORDER BY processing_started_at LIMIT $1 FOR UPDATE SKIP LOCKED) WHEN MATCHED THEN UPDATE SET attempt_count = t.attempt_count + 1",
  ],
  [
    "MERGE with a join source and an IN (… LIMIT … FOR UPDATE) predicate",
    "MERGE INTO audit_outbox t USING audit_outbox s ON t.id = s.id AND s.id IN (SELECT id FROM audit_outbox LIMIT $1 FOR UPDATE SKIP LOCKED) WHEN MATCHED THEN DELETE",
  ],
  [
    "INSERT … SELECT … IN (… LIMIT … FOR UPDATE) ON CONFLICT DO UPDATE",
    "INSERT INTO audit_outbox (id, attempt_count) SELECT o.id, o.attempt_count FROM audit_outbox o WHERE o.id IN (SELECT id FROM audit_outbox LIMIT $1 FOR UPDATE SKIP LOCKED) ON CONFLICT (id) DO UPDATE SET attempt_count = audit_outbox.attempt_count + 1",
  ],
  [
    "a write behind an opaque ${…} prefix",
    "${hint} UPDATE audit_outbox SET status = 'PROCESSING' WHERE id IN (SELECT id FROM audit_outbox LIMIT $1 FOR UPDATE SKIP LOCKED)",
  ],
  [
    "a write after a recursive CTE's SEARCH … SET clause",
    "WITH RECURSIVE r AS (SELECT id FROM t UNION ALL SELECT t.id FROM t JOIN r ON t.p = r.id) SEARCH DEPTH FIRST BY id SET ord DELETE FROM t WHERE id IN (SELECT id FROM r)",
  ],
  [
    "a write after a recursive CTE's CYCLE … SET … USING clause",
    "WITH RECURSIVE r AS (SELECT id FROM t UNION ALL SELECT id FROM r WHERE false) CYCLE id SET is_cycle TO true DEFAULT false USING path UPDATE t SET a = 1 WHERE status = 'SENT'",
  ],
  [
    "an unrecognised write form (EXPLAIN ANALYZE executes the UPDATE)",
    "EXPLAIN ANALYZE UPDATE audit_outbox SET status = 'PROCESSING' WHERE id IN (SELECT id FROM audit_outbox LIMIT $1 FOR UPDATE SKIP LOCKED)",
  ],
  ["an upsert without any LIMIT", "INSERT INTO t (id, n) VALUES ($1, 0) ON CONFLICT (id) DO UPDATE SET n = t.n + 1"],
  [
    "an upsert whose source and DO UPDATE both pin the key",
    "INSERT INTO t (id) SELECT id FROM u WHERE id = $1 ON CONFLICT (id) DO UPDATE SET n = 1 WHERE t.id = $1",
  ],
  ["a MERGE whose ON clause pins the key", "MERGE INTO t USING u ON t.id = u.id AND t.id = $1 WHEN MATCHED THEN DELETE"],
  [
    "a MERGE without any LIMIT",
    "MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN UPDATE SET n = u.n WHEN NOT MATCHED THEN INSERT (id, n) VALUES (u.id, u.n)",
  ],
  [
    "a MERGE reading a materialized key set (the C1 shape does not apply to MERGE)",
    "WITH picked AS MATERIALIZED (SELECT id FROM t LIMIT $1 FOR UPDATE SKIP LOCKED) MERGE INTO t USING picked p ON t.id = p.id WHEN MATCHED THEN DELETE",
  ],
];

// Neither a write nor an unrecognised one: no violation at all.
const WRITE_FORM_ALLOW: ReadonlyArray<readonly [string, string]> = [
  ["INSERT … ON CONFLICT DO NOTHING", "INSERT INTO t (id) VALUES ($1) ON CONFLICT DO NOTHING"],
  ["a MERGE whose actions are only INSERT / DO NOTHING", "MERGE INTO t USING u ON t.id = u.id WHEN NOT MATCHED THEN INSERT (id) VALUES (u.id) WHEN MATCHED THEN DO NOTHING"],
  ["a standalone SELECT … FOR UPDATE … LIMIT", "SELECT id FROM t ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED"],
  ["FK ON DELETE CASCADE / ON UPDATE text", "ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE ON UPDATE NO ACTION"],
];

describe("INV4 write forms (S-CR1-1)", () => {
  it.each(WRITE_FORM_DENY)("deny: %s", (_label, sql) => {
    expect(classifySweeps([sqlStatement(sql)], []).map((v) => v.kind)).toContain("unbounded");
  });

  it.each(WRITE_FORM_ALLOW)("allow: %s", (_label, sql) => {
    expect(classifySweeps([sqlStatement(sql)], [])).toEqual([]);
  });

  it("extracts each deny form from module source", () => {
    for (const [label, sql] of WRITE_FORM_DENY) {
      const source = `declare const hint: string;\nexport const q = \`${sql}\`;\n`;
      expect(extractSweepStatementsFromSource(source, "fixture.ts"), label).toHaveLength(1);
    }
  });

  it("an exemption cannot cover a MERGE, an upsert or an unrecognised write", () => {
    const literals = [
      "MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN DELETE",
      "INSERT INTO s (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET n = 1",
      // A single-row write does not carry an unrecognised one in its literal.
      "UPDATE audit_chain_anchors SET a = 1 WHERE tenant_id = $1; EXPLAIN ANALYZE DELETE FROM v WHERE id IN (SELECT 1)",
    ];
    const exemptions = ["MERGE INTO t", "INSERT INTO s", "UPDATE audit_chain_anchors"].map((match) => ({
      module: "m",
      match,
      reason: "x".repeat(10),
    }));
    const kinds = classifySweeps(literals.map(sqlStatement), exemptions).map((v) => v.kind).sort();
    expect(kinds).toEqual(["loose-exemption", "loose-exemption", "loose-exemption", "unbounded", "unbounded", "unbounded"]);
  });
});
