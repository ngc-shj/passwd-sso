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
 *   - `sweepBounds` (every `rawSql: true` entry): every extracted raw-SQL
 *     DELETE/UPDATE sweep statement in the entry's modules must be LIMIT-bounded,
 *     single-row-by-id, or covered by exactly one tight, used
 *     `sweepBounds.exemptions[]` entry (INV4).
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
import { Node, SyntaxKind } from "ts-morph";

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

const HAS_LIMIT_RE = /LIMIT/i;
const SINGLE_ROW_BY_ID_RE = /WHERE\s+id\s*=/i;
// Exemption tightness gate (S5/S6): the statement an exemption identifies must
// itself be a top-level single-row equality on a PK/unique column, with no
// subselect. A loose /WHERE\s+\w+\s*=/ would also match an equality *inside* a
// multi-row sweep's subselect (e.g. `WHERE status = 'PROCESSING'`), which must
// NOT be accepted as proof of single-row shape.
const TIGHT_PK_WHERE_RE = /\bWHERE\s+(id|tenant_id)\s*=/i;
const HAS_SUBSELECT_RE = /\(SELECT/i;

/**
 * Pure classifier: given the extracted SQL statement strings for one worker
 * module (or the union of a worker's modules) plus the exemptions scoped to
 * that module, returns the list of sweep-boundedness violations. An empty
 * array means every statement passes.
 */
export function classifySweeps(
  statements: string[],
  exemptions: SweepExemption[],
): SweepViolation[] {
  const violations: SweepViolation[] = [];

  // Pre-compute, for every exemption, which statements its `match` hits and
  // whether the statement it identifies passes the tightness gate.
  const exemptionMatchCounts = exemptions.map((exemption) => {
    const matchingStatements = statements.filter((statement) =>
      statement.includes(exemption.match),
    );
    return { exemption, matchingStatements };
  });

  for (const { exemption, matchingStatements } of exemptionMatchCounts) {
    if (matchingStatements.length === 0) {
      violations.push({
        statement: exemption.match,
        kind: "unused-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) does not appear in any extracted statement`,
      });
      continue;
    }
    if (matchingStatements.length >= 2) {
      violations.push({
        statement: exemption.match,
        kind: "ambiguous-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) matches ${matchingStatements.length} statements — must match exactly 1`,
      });
      continue;
    }
    const [target] = matchingStatements;
    const passesTightnessGate = TIGHT_PK_WHERE_RE.test(target) && !HAS_SUBSELECT_RE.test(target);
    if (!passesTightnessGate) {
      violations.push({
        statement: target,
        kind: "loose-exemption",
        detail: `exemption match "${exemption.match}" (module ${exemption.module}) identifies a statement that is not top-level single-row-shaped (contains a subselect or lacks a top-level WHERE id/tenant_id = equality): ${target}`,
      });
    }
  }

  // A statement passes iff it has LIMIT, is single-row-by-id, or is covered by
  // exactly one exemption whose target statement independently passed the
  // tightness gate above.
  const tightlyExemptedStatements = new Set(
    exemptionMatchCounts
      .filter(
        ({ matchingStatements }) =>
          matchingStatements.length === 1 &&
          TIGHT_PK_WHERE_RE.test(matchingStatements[0]) &&
          !HAS_SUBSELECT_RE.test(matchingStatements[0]),
      )
      .map(({ matchingStatements }) => matchingStatements[0]),
  );

  for (const statement of statements) {
    if (HAS_LIMIT_RE.test(statement)) continue;
    if (SINGLE_ROW_BY_ID_RE.test(statement)) continue;
    if (tightlyExemptedStatements.has(statement)) continue;
    violations.push({
      statement,
      kind: "unbounded",
      detail: `no LIMIT, no top-level WHERE id =, and no valid exemption covers this statement: ${statement}`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// C5 extraction (assertion 1): pull every string/template literal's full text
// out of a module's AST and keep only DELETE FROM / leading UPDATE candidates.
// ---------------------------------------------------------------------------

const SWEEP_CANDIDATE_RE = /DELETE FROM|\bUPDATE\s/;

function extractSweepStatements(modulePath: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, modulePath), "utf8");
  const sf = parseRouteSource(source, modulePath);
  const statements: string[] = [];

  const kinds = [
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateExpression,
  ];
  for (const kind of kinds) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      // Skip TemplateExpression nodes that are nested inside another
      // TemplateExpression's span (not applicable here — TemplateExpression
      // does not nest within itself via getDescendantsOfKind double-counting,
      // but guard defensively against a Head/Middle/Tail child also being
      // separately visited under a different kind).
      if (kind === SyntaxKind.TemplateExpression && !Node.isTemplateExpression(node)) continue;
      const text = node.getText();
      if (SWEEP_CANDIDATE_RE.test(text)) {
        statements.push(text);
      }
    }
  }
  return statements;
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

    if (maxAttemptsLines.length !== 2) {
      violations.push(
        `prisma/schema.prisma: expected exactly 2 maxAttempts lines (AuditOutbox, AuditDelivery), found ${maxAttemptsLines.length}`,
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
  it("(a) an unbounded DELETE with no LIMIT, no WHERE id=, no exemption is flagged", () => {
    const violations = classifySweeps(["DELETE FROM x WHERE status = 'SENT'"], []);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unbounded");
  });

  it("(b) a DELETE with LIMIT in a subselect passes", () => {
    const violations = classifySweeps(
      ["DELETE FROM x WHERE id IN (SELECT id FROM x LIMIT 5)"],
      [],
    );
    expect(violations).toEqual([]);
  });

  it("(c) a single-row WHERE id = statement passes", () => {
    const violations = classifySweeps(["DELETE FROM x WHERE id = $1"], []);
    expect(violations).toEqual([]);
  });

  it("(d) an exemption whose match no longer appears in any statement is flagged as unused", () => {
    // Note: the statement's own WHERE tenant_id = does not satisfy the primary
    // single-row predicate (WHERE id =, not tenant_id), so absent a valid
    // exemption it is separately unbounded too — the fixture's point is that
    // the stale exemption itself is caught, not that it is the only finding.
    const violations = classifySweeps(
      ["UPDATE audit_chain_anchors SET a=1 WHERE tenant_id = $1"],
      [{ module: "m", match: "UPDATE nonexistent", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "unused-exemption")).toBe(true);
  });

  it("(e) an over-broad exemption targeting an unbounded, non-PK-WHERE statement is rejected as loose-exemption", () => {
    const violations = classifySweeps(
      ["DELETE FROM x WHERE status='SENT'"],
      [{ module: "m", match: "DELETE FROM x", reason: "x".repeat(10) }],
    );
    expect(violations.some((v) => v.kind === "loose-exemption")).toBe(true);
  });

  it("(f) an exemption targeting a statement whose only equality is inside a subselect is rejected as loose-exemption, not silently passed", () => {
    const statements = [
      "DELETE FROM x WHERE id IN (SELECT id FROM x WHERE status = 'PROCESSING')",
    ];
    const violations = classifySweeps(statements, [
      { module: "m", match: "DELETE FROM x", reason: "x".repeat(10) },
    ]);
    expect(violations.some((v) => v.kind === "loose-exemption")).toBe(true);
  });
});
