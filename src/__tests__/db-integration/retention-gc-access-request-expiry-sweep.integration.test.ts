/**
 * Real-DB test for sweepExpiredAccessRequests (external-review-2026-07
 * remediation, C7 / 残3): PENDING access_requests past expiry flip to
 * EXPIRED; PENDING rows before expiry and non-PENDING rows are untouched.
 *
 * Connects as the retention-gc-worker role (passwd_retention_gc_worker), NOT
 * superuser — a superuser connection would false-green past a missing GRANT
 * (migration 20260722000100 grants UPDATE (status) ON access_requests to this
 * role; without it, the sweep would 42501-permission-denied against a real
 * NOBYPASSRLS role even though a superuser-run test would pass).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  sweepExpiredAccessRequests,
  sweepAuditProvenanceEntry,
} from "@/workers/retention-gc-worker/sweep";
import {
  RETENTION_REGISTRY,
  type AuditProvenanceEntry,
} from "@/workers/retention-gc-worker/registry";
import { MS_PER_DAY } from "@/lib/constants/time";

const accessRequestProvenanceEntry = RETENTION_REGISTRY.find(
  (e): e is AuditProvenanceEntry =>
    e.kind === "EXPIRY_AUDIT_PROVENANCE" && e.table === "access_requests",
)!;

// Grace window derived from the registry (never hardcode the day count —
// the tests must track the registry value). Fail loud if the grace offset
// is ever removed from the entry: these tests exist to pin it.
if (accessRequestProvenanceEntry.retentionDays === undefined) {
  throw new Error(
    "access_requests EXPIRY_AUDIT_PROVENANCE entry lost its retentionDays grace — the EXPIRED-visibility tests below require it",
  );
}
const GRACE_DAYS = accessRequestProvenanceEntry.retentionDays;

describe("retention-gc sweepExpiredAccessRequests: PENDING -> EXPIRED (C7)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let saId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    saId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), now())`,
        saId,
        tenantId,
        `sweep-test-sa-${saId.slice(0, 8)}`,
        userId,
      );
    });
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function insertAccessRequest(opts: {
    status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO access_requests
           (id, tenant_id, service_account_id, requested_scope, status, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"AccessRequestStatus", $6, now())`,
        id,
        tenantId,
        saId,
        "passwords:read",
        opts.status,
        opts.expiresAt,
      );
    });
    return id;
  }

  async function statusOf(id: string): Promise<string> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM access_requests WHERE id = $1::uuid`,
        id,
      );
    });
    return rows[0]?.status ?? "MISSING";
  }

  async function runSweep(): Promise<number> {
    return ctx.retentionWorker.prisma.$transaction((tx) =>
      sweepExpiredAccessRequests(tx, 100),
    );
  }

  it("flips a PENDING row past its expiry to EXPIRED", async () => {
    const id = await insertAccessRequest({
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const count = await runSweep();

    expect(count).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe("EXPIRED");
  });

  it("leaves a PENDING row before its expiry unchanged", async () => {
    const id = await insertAccessRequest({
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await runSweep();

    expect(await statusOf(id)).toBe("PENDING");
  });

  it("leaves an APPROVED row past its expiry unchanged (status filter proven)", async () => {
    const id = await insertAccessRequest({
      status: "APPROVED",
      expiresAt: new Date(Date.now() - 60_000),
    });

    await runSweep();

    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("is idempotent — re-running after a full sweep flips nothing further", async () => {
    await insertAccessRequest({
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const firstCount = await runSweep();
    expect(firstCount).toBeGreaterThanOrEqual(1);

    const secondCount = await runSweep();
    expect(secondCount).toBe(0);
  });

  // M2: the retentionDays grace on the access_requests
  // EXPIRY_AUDIT_PROVENANCE registry entry means the hard-delete cutoff is
  // expires_at < now() - retentionDays, NOT expires_at < now() — so an
  // EXPIRED row (past expires_at but within the grace window) survives the
  // audit-provenance sweep in the SAME cycle it was flipped in. Without the
  // grace offset both sweeps share the same cutoff and the row would be
  // purged before ever being observed as EXPIRED.
  it("an EXPIRED row survives the audit-provenance sweep within the retentionDays grace window (M2)", async () => {
    const id = await insertAccessRequest({
      status: "PENDING",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const flippedCount = await runSweep();
    expect(flippedCount).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe("EXPIRED");

    // Same cycle: run the audit-provenance sweep that would otherwise
    // hard-delete this row (cutoff column is the same expires_at).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, accessRequestProvenanceEntry, 100);
    });

    // The row still exists, still EXPIRED — visible within the grace window.
    expect(await statusOf(id)).toBe("EXPIRED");
  });

  it("the audit-provenance sweep still purges an access_requests row past the retentionDays grace window", async () => {
    const id = await insertAccessRequest({
      status: "EXPIRED",
      // expires_at is one day past the grace window, so now() - retentionDays
      // is still past it and this row IS eligible for the hard delete.
      expiresAt: new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
    });

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, accessRequestProvenanceEntry, 100);
    });

    expect(await statusOf(id)).toBe("MISSING");

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ payload: { action: string; metadata: Record<string, unknown> } }[]>(
        `SELECT payload FROM audit_outbox
         WHERE tenant_id = $1::uuid AND payload->>'targetId' = $2`,
        tenantId,
        id,
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.action).toBe("SECURITY_RECORD_RETENTION_PURGED");
    expect(rows[0].payload.metadata.status).toBe("EXPIRED");
  });
});
