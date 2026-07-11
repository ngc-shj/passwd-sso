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

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKERS_DIR = path.join(REPO_ROOT, "src/workers");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// SECURITY DEFINER function names, extracted from the migration that creates
// them (grep 'CREATE OR REPLACE FUNCTION' / 'CREATE FUNCTION' / 'SECURITY DEFINER'
// against prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql).
// The sibling migration 20260618000000_add_retention_gc_worker_role only GRANTs
// EXECUTE on the existing audit_log_purge function — it defines no new function.
const SECURITY_DEFINER_FUNCTION_NAMES = ["audit_log_purge", "audit_log_tenant_migrate"] as const;

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
});
