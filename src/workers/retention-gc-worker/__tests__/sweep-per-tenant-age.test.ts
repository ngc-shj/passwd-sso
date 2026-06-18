/**
 * Unit tests for sweepPerTenantAge (SC3): tenant enumeration (NULL skipped),
 * cutoff math, batch-bounded DELETE SQL shape (bound params, allowlisted
 * identifiers), and per-tenant audit emitted only when rows are trimmed.
 */

import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { sweepPerTenantAge } from "../sweep";
import type { PerTenantAgeEntry } from "../registry";

const ENTRY: PerTenantAgeEntry = {
  kind: "PER_TENANT_AGE",
  table: "password_entry_histories",
  cutoffColumn: "changed_at",
  tenantRetentionColumn: "historyRetentionDays",
  auditAction: "HISTORY_RETENTION_PURGED",
};

const LOG_ENTRY: PerTenantAgeEntry = {
  kind: "PER_TENANT_AGE",
  table: "share_access_logs",
  cutoffColumn: "created_at",
  tenantRetentionColumn: "shareAccessLogRetentionDays",
  auditAction: "LOG_RETENTION_PURGED",
};

function makeTx(
  tenants: Array<Record<string, string | number | null>>,
  deletedPerTenant: number,
) {
  const executeRaw = vi.fn().mockResolvedValue(undefined); // set_config
  const executeRawUnsafe = vi.fn().mockResolvedValue(deletedPerTenant); // DELETE
  const findMany = vi.fn().mockResolvedValue(tenants);
  const auditOutbox = { create: vi.fn().mockResolvedValue(undefined) };
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ bypass_rls: "on", tenant_id: "" }])
    .mockResolvedValue([{ ok: true }]);
  const tx = {
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRawUnsafe,
    $queryRaw: queryRaw,
    tenant: { findMany },
    auditOutbox,
  } as unknown as Prisma.TransactionClient;
  return { tx, executeRawUnsafe, findMany, auditOutbox };
}

describe("sweepPerTenantAge (SC3)", () => {
  it("enumerates only tenants with the retention column NOT NULL", async () => {
    const { tx, findMany } = makeTx([], 0);
    await sweepPerTenantAge(tx, ENTRY, 100);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { historyRetentionDays: { not: null } },
      }),
    );
  });

  it("DELETEs with batch-bounded (id) IN (SELECT ... LIMIT) and bound params (tenant, cutoff, batch)", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const { tx, executeRawUnsafe } = makeTx(
      [{ id: tenantId, historyRetentionDays: 90 }],
      5,
    );

    const before = Date.now();
    const total = await sweepPerTenantAge(tx, ENTRY, 200);
    const after = Date.now();

    expect(total).toBe(5);
    const [sql, ...params] = executeRawUnsafe.mock.calls[0];
    expect(sql).toMatch(
      /DELETE FROM password_entry_histories\s+WHERE \(id\) IN \(\s*SELECT id FROM password_entry_histories\s+WHERE tenant_id = \$1::uuid\s+AND changed_at < \$2::timestamptz\s+LIMIT \$3\s*\)/,
    );
    expect(sql).not.toContain("${");
    // params: [tenantId, cutoffDate, batchSize]
    expect(params[0]).toBe(tenantId);
    expect(params[2]).toBe(200);
    const cutoff = params[1] as Date;
    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    // cutoff ≈ now - 90d (within the test window)
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it("emits a per-tenant HISTORY_RETENTION_PURGED audit only when rows were trimmed", async () => {
    const tenantId = "22222222-2222-4222-8222-222222222222";
    const { tx, auditOutbox } = makeTx(
      [{ id: tenantId, historyRetentionDays: 30 }],
      3,
    );
    await sweepPerTenantAge(tx, ENTRY, 100);
    expect(auditOutbox.create).toHaveBeenCalledTimes(1);
    const emitted = auditOutbox.create.mock.calls[0][0];
    expect(emitted.data.tenantId).toBe(tenantId);
    const payload = emitted.data.payload;
    expect(payload.action).toBe("HISTORY_RETENTION_PURGED");
    expect(payload.metadata.purgedCount).toBe(3);
    expect(payload.metadata.table).toBe("password_entry_histories");
  });

  it("emits NO audit when a tenant has zero rows to trim", async () => {
    const { tx, auditOutbox } = makeTx(
      [{ id: "33333333-3333-4333-8333-333333333333", historyRetentionDays: 30 }],
      0,
    );
    const total = await sweepPerTenantAge(tx, ENTRY, 100);
    expect(total).toBe(0);
    expect(auditOutbox.create).not.toHaveBeenCalled();
  });

  it("emits the entry's auditAction (LOG_RETENTION_PURGED for append-only logs, SC7)", async () => {
    const tenantId = "44444444-4444-4444-8444-444444444444";
    const { tx, auditOutbox } = makeTx(
      [{ id: tenantId, shareAccessLogRetentionDays: 60 }],
      2,
    );
    await sweepPerTenantAge(tx, LOG_ENTRY, 100);
    expect(auditOutbox.create).toHaveBeenCalledTimes(1);
    const payload = auditOutbox.create.mock.calls[0][0].data.payload;
    expect(payload.action).toBe("LOG_RETENTION_PURGED");
    expect(payload.metadata.table).toBe("share_access_logs");
  });
});
