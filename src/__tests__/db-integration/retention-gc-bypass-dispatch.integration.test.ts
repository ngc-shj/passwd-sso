/**
 * Real-DB tests for the retention-gc bypass rule (#874): the module-private
 * dispatcher (sweep.ts inSweepTx) sets the tx-local RLS bypass, and each sweep
 * only asserts the state its entry declares.
 *
 * Covers:
 *   1. Production composition: sweepOnce on the NOBYPASSRLS
 *      passwd_retention_gc_worker role. Every other sweepOnce test runs as the
 *      superuser, which ignores RLS, so only this one shows the wrapper's GUC
 *      reaching an RLS-enabled globalDelete table (sessions) and the
 *      bypass:false path (verification_tokens) running on the real role.
 *   2. Guard: as the superuser (RLS cannot stop the write, so only the assert
 *      can), a sweep in a plain transaction with no GUC refuses before touching
 *      a row. The rejection is caught INSIDE the transaction, which then
 *      commits — so "rows still present" cannot be a rollback artefact — and a
 *      positive control on the same fixture with the GUC deletes them.
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
  inRetentionSweepTx,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { sweepExpiryEntry, sweepOnce, sweepPerTenantAge } from "@/workers/retention-gc-worker/sweep";
import {
  RETENTION_REGISTRY,
  type ExpiryEntry,
  type PerTenantAgeEntry,
} from "@/workers/retention-gc-worker/registry";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

const C2_ERROR = "retention-gc sweep requires the RLS bypass state its entry declares";

const sessionsEntry = RETENTION_REGISTRY.find(
  (e): e is ExpiryEntry => e.kind === "EXPIRY" && e.table === "sessions",
);
const historyEntry = RETENTION_REGISTRY.find(
  (e): e is PerTenantAgeEntry => e.kind === "PER_TENANT_AGE" && e.table === "password_entry_histories",
);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`registry has no ${what} entry`);
  return value;
}

async function removeSystemHeartbeats(ctx: TestContext): Promise<void> {
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
}

describe("retention-gc dispatcher bypass, shared fixture", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let seededSessionIds: string[];
  let seededTokens: Array<{ identifier: string; token: string }>;

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
    seededTokens = [];
    // An expired backlog from elsewhere could fill the batch before our rows.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE expires < now()`);
      await tx.$executeRawUnsafe(`DELETE FROM verification_tokens WHERE expires < now()`);
    });
  });
  afterEach(async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      for (const id of seededSessionIds) {
        await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE id = $1::uuid`, id);
      }
      for (const { identifier, token } of seededTokens) {
        await tx.$executeRawUnsafe(
          `DELETE FROM verification_tokens WHERE identifier = $1 AND token = $2`,
          identifier,
          token,
        );
      }
    });
    await removeSystemHeartbeats(ctx);
    await ctx.deleteTestData(tenantId);
  });

  async function insertExpiredSession(): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() - interval '1 hour', now(), now(), 'credentials')`,
        id,
        `sess-${randomUUID()}`,
        userId,
        tenantId,
      );
    });
    seededSessionIds.push(id);
    return id;
  }

  async function insertExpiredToken(): Promise<{ identifier: string; token: string }> {
    const key = { identifier: `test-ident-${randomUUID().slice(0, 12)}`, token: `tok-${randomUUID()}` };
    await ctx.su.prisma.$executeRawUnsafe(
      `INSERT INTO verification_tokens (identifier, token, expires)
       VALUES ($1, $2, now() - interval '1 hour')`,
      key.identifier,
      key.token,
    );
    seededTokens.push(key);
    return key;
  }

  async function sessionExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM sessions WHERE id = $1::uuid`, id);
    });
    return rows.length > 0;
  }

  async function tokenExists(key: { identifier: string; token: string }): Promise<boolean> {
    const rows = await ctx.su.prisma.$queryRawUnsafe<{ token: string }[]>(
      `SELECT token FROM verification_tokens WHERE identifier = $1 AND token = $2`,
      key.identifier,
      key.token,
    );
    return rows.length > 0;
  }

  describe("sweepOnce on the passwd_retention_gc_worker role (production composition)", () => {
    it("deletes an expired session (globalDelete) and an expired verification token (no bypass), with no -1", async () => {
      const sessionId = await insertExpiredSession();
      const token = await insertExpiredToken();
      // Preconditions: both rows exist, so "gone" below is the sweep's doing.
      expect(await sessionExists(sessionId)).toBe(true);
      expect(await tokenExists(token)).toBe(true);

      const counts = await sweepOnce(ctx.retentionWorker.prisma, 100, {
        intervalMs: 3_600_000,
        emitHeartbeatAudit: false,
      });

      expect(Object.entries(counts).filter(([, n]) => n === -1)).toEqual([]);
      expect(counts.sessions).toBeGreaterThanOrEqual(1);
      expect(counts.verification_tokens).toBeGreaterThanOrEqual(1);
      expect(await sessionExists(sessionId)).toBe(false);
      expect(await tokenExists(token)).toBe(false);
    });
  });

  describe("guard: a sweep with no bypass GUC refuses before touching a row (superuser)", () => {
    it("EXPIRY globalDelete entry (sessions): refuses without the GUC, deletes with it", async () => {
      const entry = required(sessionsEntry, "sessions EXPIRY");
      const sessionId = await insertExpiredSession();

      // Caught inside the tx, which then commits: a delete the assert failed to
      // stop would persist and show below.
      await ctx.su.prisma.$transaction(async (tx) => {
        await expect(sweepExpiryEntry(tx, entry, 100)).rejects.toThrow(C2_ERROR);
      });
      expect(await sessionExists(sessionId)).toBe(true);

      // Positive control on the same fixture.
      const deleted = await inRetentionSweepTx(ctx.su.prisma, (tx) => sweepExpiryEntry(tx, entry, 100));
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await sessionExists(sessionId)).toBe(false);
    });

    it("sweepPerTenantAge (password_entry_histories): refuses without the GUC, trims with it", async () => {
      const entry = required(historyEntry, "password_entry_histories PER_TENANT_AGE");
      const entryId = randomUUID();
      const historyId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET history_retention_days = 30 WHERE id = $1::uuid`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, key_version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, '\\x00', 'iv', 'tag', '\\x00', 'oiv', 'otag', 1, now(), now())`,
          entryId,
          userId,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, key_version, changed_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, '\\x00', 'iv', 'tag', 1, now() - interval '31 days')`,
          historyId,
          entryId,
          tenantId,
        );
      });
      const historyExists = async () => {
        const rows = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM password_entry_histories WHERE id = $1::uuid`,
            historyId,
          );
        });
        return rows.length > 0;
      };

      await ctx.su.prisma.$transaction(async (tx) => {
        await expect(sweepPerTenantAge(tx, entry, 100)).rejects.toThrow(C2_ERROR);
      });
      expect(await historyExists()).toBe(true);

      await inRetentionSweepTx(ctx.su.prisma, (tx) => sweepPerTenantAge(tx, entry, 100));
      expect(await historyExists()).toBe(false);
    });
  });
});
