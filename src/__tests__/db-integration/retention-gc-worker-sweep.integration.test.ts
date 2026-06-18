/**
 * Real-DB sweep tests for sweepOnce / sweepExpiryEntry (C2/T8/T12).
 *
 * Covers:
 *   1. mcp_clients 9-row boundary matrix (ported from dcr-cleanup-worker-sweep; C2).
 *   2. verification_tokens composite-key matrix (T12): rows sharing one identifier
 *      with mixed expires, asserts only expired composite rows deleted.
 *   3. sessions EXPIRY case proving globalDelete/bypass_rls works.
 *
 * NOTE: File co-location in one describe guarantees serial execution under vitest
 * file-parallelism — suites that mutate the global unclaimed-DCR namespace and
 * sessions must not run concurrently with other files that do the same.
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
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { sweepOnce } from "@/workers/retention-gc-worker/sweep";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

// ─── mcp_clients boundary matrix ─────────────────────────────────────────────

describe("retention-gc sweepOnce: mcp_clients 9-row boundary matrix (C2/T8)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let seededClientIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    seededClientIds = [];
    // Remove all pre-existing unclaimed DCR rows so sweepOnce only targets
    // rows seeded by this test run and returns an exact count.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
    });
  });
  afterEach(async () => {
    if (seededClientIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededClientIds) {
          await tx.$executeRawUnsafe(
            `DELETE FROM mcp_clients WHERE id = $1::uuid`,
            id,
          );
        }
      });
    }
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  async function insertMcpClient(opts: {
    isDcr: boolean;
    tenantId: string | null;
    expiresAt: string; // SQL expression e.g. "now() - interval '1 hour'"
  }): Promise<string> {
    const id = randomUUID();
    const clientIdStr = `test-cl-${id.slice(0, 12)}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (opts.tenantId !== null) {
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
           VALUES ($1::uuid, $2, 'hash', $3, '{}', 'credentials:list', $4, $5::uuid, ${opts.expiresAt}, now(), now())`,
          id,
          clientIdStr,
          `client-${id.slice(0, 8)}`,
          opts.isDcr,
          opts.tenantId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
           VALUES ($1::uuid, $2, 'hash', $3, '{}', 'credentials:list', $4, NULL, ${opts.expiresAt}, now(), now())`,
          id,
          clientIdStr,
          `client-${id.slice(0, 8)}`,
          opts.isDcr,
        );
      }
    });
    seededClientIds.push(id);
    return id;
  }

  it("deletes only the expired unclaimed DCR row (1 deleted, 8 kept)", async () => {
    // Row 1: target — is_dcr=true, tenant_id=null, expired (-1h)
    const targetId = await insertMcpClient({
      isDcr: true,
      tenantId: null,
      expiresAt: "now() - interval '1 hour'",
    });
    // Row 2: is_dcr=true, tenant_id=null, future (+1h) — keep
    await insertMcpClient({ isDcr: true, tenantId: null, expiresAt: "now() + interval '1 hour'" });
    // Row 3: is_dcr=true, tenant_id=real, expired (-1h) — keep (has tenant_id)
    await insertMcpClient({ isDcr: true, tenantId: tenantId, expiresAt: "now() - interval '1 hour'" });
    // Row 4: is_dcr=true, tenant_id=real, future (+1h) — keep
    await insertMcpClient({ isDcr: true, tenantId: tenantId, expiresAt: "now() + interval '1 hour'" });
    // Row 5: is_dcr=false, tenant_id=null, expired (-1h) — keep (is_dcr=false)
    await insertMcpClient({ isDcr: false, tenantId: null, expiresAt: "now() - interval '1 hour'" });
    // Row 6: is_dcr=false, tenant_id=null, future (+1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: null, expiresAt: "now() + interval '1 hour'" });
    // Row 7: is_dcr=false, tenant_id=real, expired (-1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: tenantId, expiresAt: "now() - interval '1 hour'" });
    // Row 8: is_dcr=false, tenant_id=real, future (+1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: tenantId, expiresAt: "now() + interval '1 hour'" });
    // Row 9: boundary — is_dcr=true, tenant_id=null, expires in +10s (not past — keep)
    await insertMcpClient({ isDcr: true, tenantId: null, expiresAt: "now() + interval '10 seconds'" });

    // Run sweepOnce using the superuser prisma client (integration: tests logic only)
    const counts = await sweepOnce(ctx.su.prisma, 20, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    // Only the mcp_clients entry should have a non-zero count
    expect(counts["mcp_clients"]).toBe(1);

    // Target row is gone
    const targetRemaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = $1::uuid`,
        targetId,
      );
    });
    expect(targetRemaining).toHaveLength(0);

    // All other 8 rows remain
    const otherRemaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = ANY($1::uuid[])`,
        seededClientIds.filter((id) => id !== targetId),
      );
    });
    expect(otherRemaining).toHaveLength(8);
  });
});

// ─── verification_tokens composite-key matrix (T12) ──────────────────────────

describe("retention-gc sweepOnce: verification_tokens composite-key matrix (T12)", () => {
  let ctx: TestContext;
  let seededTokenKeys: Array<{ identifier: string; token: string }>;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    seededTokenKeys = [];
  });
  afterEach(async () => {
    if (seededTokenKeys.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const { identifier, token } of seededTokenKeys) {
          await tx.$executeRawUnsafe(
            `DELETE FROM verification_tokens WHERE identifier = $1 AND token = $2`,
            identifier,
            token,
          );
        }
      });
    }
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
  });

  async function insertVerificationToken(opts: {
    identifier: string;
    token: string;
    expiresAt: string; // SQL expression
  }): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO verification_tokens (identifier, token, expires)
         VALUES ($1, $2, ${opts.expiresAt})
         ON CONFLICT DO NOTHING`,
        opts.identifier,
        opts.token,
      );
    });
    seededTokenKeys.push({ identifier: opts.identifier, token: opts.token });
  }

  it("deletes only expired composite rows; unexpired same-identifier row survives (T12)", async () => {
    const sharedIdentifier = `test-ident-${randomUUID().slice(0, 12)}`;
    const distinctIdentifier = `test-ident-${randomUUID().slice(0, 12)}`;

    // 3 rows sharing sharedIdentifier: 2 expired, 1 unexpired
    const expiredToken1 = `tok-${randomUUID().slice(0, 16)}`;
    const expiredToken2 = `tok-${randomUUID().slice(0, 16)}`;
    const freshToken = `tok-${randomUUID().slice(0, 16)}`;
    // Distinct identifier: 1 expired row
    const distinctExpiredToken = `tok-${randomUUID().slice(0, 16)}`;

    await insertVerificationToken({
      identifier: sharedIdentifier,
      token: expiredToken1,
      expiresAt: "now() - interval '1 hour'",
    });
    await insertVerificationToken({
      identifier: sharedIdentifier,
      token: expiredToken2,
      expiresAt: "now() - interval '2 hours'",
    });
    await insertVerificationToken({
      identifier: sharedIdentifier,
      token: freshToken,
      expiresAt: "now() + interval '1 hour'",
    });
    await insertVerificationToken({
      identifier: distinctIdentifier,
      token: distinctExpiredToken,
      expiresAt: "now() - interval '30 minutes'",
    });

    // Run sweepOnce with batchSize=10 (more than enough for 4 rows)
    const counts = await sweepOnce(ctx.su.prisma, 10, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    // 3 expired rows deleted (expiredToken1, expiredToken2, distinctExpiredToken)
    expect(counts["verification_tokens"]).toBe(3);

    // Unexpired shared-identifier row survives (T12b)
    const freshSurvives = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ token: string }[]>(
        `SELECT token FROM verification_tokens WHERE identifier = $1 AND token = $2`,
        sharedIdentifier,
        freshToken,
      );
    });
    expect(freshSurvives).toHaveLength(1);

    // Expired rows gone
    const expiredGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ token: string }[]>(
        `SELECT token FROM verification_tokens
         WHERE identifier = $1 AND token = ANY($2::text[])`,
        sharedIdentifier,
        [expiredToken1, expiredToken2],
      );
    });
    expect(expiredGone).toHaveLength(0);
  });

  it("batchSize caps composite-row deletion (T12c)", async () => {
    const identifier = `test-ident-batch-${randomUUID().slice(0, 12)}`;

    // Insert 5 expired rows under the same identifier
    for (let i = 0; i < 5; i++) {
      await insertVerificationToken({
        identifier,
        token: `tok-batch-${i}-${randomUUID().slice(0, 8)}`,
        expiresAt: "now() - interval '1 hour'",
      });
    }

    // Run with batchSize=2 — only 2 should be deleted per sweep
    const counts = await sweepOnce(ctx.su.prisma, 2, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    expect(counts["verification_tokens"]).toBe(2);

    // 3 rows remain (5 - 2 = 3)
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ token: string }[]>(
        `SELECT token FROM verification_tokens WHERE identifier = $1`,
        identifier,
      );
    });
    expect(remaining).toHaveLength(3);
  });
});

// ─── sessions EXPIRY with globalDelete / bypass_rls ──────────────────────────

describe("retention-gc sweepOnce: sessions globalDelete/bypass_rls (C2/INV-C2b)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let seededSessionIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    seededSessionIds = [];
  });
  afterEach(async () => {
    if (seededSessionIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededSessionIds) {
          await tx.$executeRawUnsafe(
            `DELETE FROM sessions WHERE id = $1::uuid`,
            id,
          );
        }
      });
    }
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  async function insertSession(expiresAt: string): Promise<string> {
    // sessions.id is @db.Uuid; session_token is a free string — keep distinct.
    const sessionId = randomUUID();
    const sessionToken = `sess-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, ${expiresAt}, now(), now(), 'credentials')`,
        sessionId,
        sessionToken,
        userId,
        tenantId,
      );
    });
    seededSessionIds.push(sessionId);
    return sessionId;
  }

  it("deletes expired session and keeps non-expired session across tenant boundary", async () => {
    const expiredSessionId = await insertSession("now() - interval '1 hour'");
    const freshSessionId = await insertSession("now() + interval '1 hour'");

    const counts = await sweepOnce(ctx.su.prisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    expect(counts["sessions"]).toBeGreaterThanOrEqual(1);

    // Expired session gone
    const expiredGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM sessions WHERE id = $1::uuid`,
        expiredSessionId,
      );
    });
    expect(expiredGone).toHaveLength(0);

    // Fresh session remains
    const freshRemains = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM sessions WHERE id = $1::uuid`,
        freshSessionId,
      );
    });
    expect(freshRemains).toHaveLength(1);

    // Remove the fresh session from afterEach cleanup
    seededSessionIds = seededSessionIds.filter((id) => id !== expiredSessionId);
  });
});
