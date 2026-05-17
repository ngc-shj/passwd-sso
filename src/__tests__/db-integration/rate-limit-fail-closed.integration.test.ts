/**
 * AC5.4a — Integration test verifying `emitRateLimitFailClosed` writes a
 * `RATE_LIMIT_FAIL_CLOSED` row to `audit_outbox` via the real Prisma path
 * (no mock of logAuditAsync). Validates that the new enum value is accepted
 * by Postgres + Prisma Client end-to-end, and that the row carries the
 * documented target/actor/metadata shape.
 *
 * AC5.4b (drain side — audit_outbox(PENDING) → audit_logs(SENT)) is NOT
 * covered here; the existing outbox worker exercises that pipeline for ALL
 * action values. Manual-test Scenario A is the end-to-end drain proof.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";
import type { NextRequest } from "next/server";

// Per common-rules R30 / app-level convention: lazy-import to avoid loading
// the audit-helper module's getRedis() / pino setup at test-file-import time.
async function importEmitter() {
  const mod = await import("@/lib/security/rate-limit-audit");
  return mod.emitRateLimitFailClosed;
}

function makeReq(ip = "203.0.113.50"): NextRequest {
  return {
    headers: new Headers({ "x-forwarded-for": ip }),
    // extractClientIp() also checks request.ip on Edge runtime; node runtime
    // takes the header path. The integration tests run in node — header
    // suffices.
  } as unknown as NextRequest;
}

describe("rate-limit fail-closed audit emission (integration)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    __resetThrottleForTests();
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    __resetThrottleForTests();
  });

  it("writes a RATE_LIMIT_FAIL_CLOSED row to audit_outbox via the real path", async () => {
    const emitRateLimitFailClosed = await importEmitter();

    await emitRateLimitFailClosed({
      req: makeReq("203.0.113.55"),
      scope: "vault.unlock",
      userId,
      tenantId,
    });

    // Wait briefly for the async outbox enqueue. logAuditAsync is awaitable
    // but the helper does `void emit` in production; here we await directly,
    // so the row should be present immediately.
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{
          action: string;
          target_type: string | null;
          target_id: string | null;
          payload: Record<string, unknown>;
          status: string;
        }>
      >(
        `SELECT
           (payload->>'action')      AS action,
           (payload->>'targetType')  AS target_type,
           (payload->>'targetId')    AS target_id,
           payload,
           status
         FROM audit_outbox
         WHERE tenant_id = $1::uuid
           AND payload->>'action' = 'RATE_LIMIT_FAIL_CLOSED'
         ORDER BY created_at DESC`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe("RATE_LIMIT_FAIL_CLOSED");
    expect(row.target_type).toBe("RateLimiter");
    expect(row.target_id).toBe("vault.unlock");
    expect(row.status).toBe("PENDING");

    // Payload shape sanity (no PII / token fragments)
    const payload = row.payload;
    expect(payload.actorType).toBe("HUMAN");
    expect(payload.userId).toBe(userId);
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.scope).toBe("vault.unlock");
    expect(metadata.ip).toBe("203.0.113.55");
    expect(metadata.ipBucket).toBe("203.0.113.55");
    expect(Object.keys(metadata).sort()).toEqual(["ip", "ipBucket", "scope"]);
  });

  it("pre-auth case (tenantId=null) does NOT write a row", async () => {
    const emitRateLimitFailClosed = await importEmitter();

    await emitRateLimitFailClosed({
      req: makeReq("203.0.113.60"),
      scope: "auth.passkey_options",
      userId: null,
      tenantId: null,
    });

    // Query across ALL tenants for the action — there should be zero rows
    // newly inserted with this scope. (Other tests may have inserted rows
    // with other scopes; we filter narrowly.)
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n
         FROM audit_outbox
         WHERE payload->>'action' = 'RATE_LIMIT_FAIL_CLOSED'
           AND payload->'metadata'->>'scope' = 'auth.passkey_options'
           AND created_at > NOW() - INTERVAL '1 minute'`,
      );
    });
    expect(Number(rows[0].n)).toBe(0);
  });

  it("uses ACTOR_TYPE.ANONYMOUS when userId is null but tenantId resolves", async () => {
    const emitRateLimitFailClosed = await importEmitter();

    // Simulates share-link verify-access path: pre-auth USER but tenantId
    // is resolved from the share record.
    await emitRateLimitFailClosed({
      req: makeReq("203.0.113.65"),
      scope: "share.verify_access_token",
      userId: null,
      tenantId,
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{
          actor_type: string;
          user_id: string;
        }>
      >(
        `SELECT
           (payload->>'actorType') AS actor_type,
           (payload->>'userId')    AS user_id
         FROM audit_outbox
         WHERE tenant_id = $1::uuid
           AND payload->>'action' = 'RATE_LIMIT_FAIL_CLOSED'
         ORDER BY created_at DESC`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("ANONYMOUS");
    // ANONYMOUS_ACTOR_ID sentinel UUID
    expect(rows[0].user_id).toBe("00000000-0000-4000-8000-000000000000");
  });
});
