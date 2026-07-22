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
import { sweepExpiredAccessRequests } from "@/workers/retention-gc-worker/sweep";

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
});
