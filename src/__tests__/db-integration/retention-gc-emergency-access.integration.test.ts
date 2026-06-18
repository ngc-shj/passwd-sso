/**
 * Real-DB tests for SC6b emergency-access-grant GC (EMERGENCY_GRANT_DEAD guard).
 *
 * The guard deletes ONLY dead grants: terminal (REVOKED/REJECTED) or never-accepted
 * expired invites (PENDING + token_expires_at past). The CRITICAL case (RT7): an
 * ACCEPTED/ACTIVATED grant whose token_expires_at is in the past is STILL LIVE
 * (token_expires_at is the invite window, not a death signal) and MUST be KEPT —
 * removing the guard would delete it (data loss). The test asserts it survives.
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
import { sweepAuditProvenanceEntry } from "@/workers/retention-gc-worker/sweep";
import { RETENTION_REGISTRY } from "@/workers/retention-gc-worker/registry";

const grantEntry = RETENTION_REGISTRY.find(
  (e) =>
    e.kind === "EXPIRY_AUDIT_PROVENANCE" &&
    e.table === "emergency_access_grants",
)! as Extract<
  (typeof RETENTION_REGISTRY)[number],
  { kind: "EXPIRY_AUDIT_PROVENANCE" }
>;

describe("retention-gc emergency-access-grant GC (SC6b)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let ownerId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    ownerId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function insertGrant(opts: {
    status: string;
    tokenExpiresAt: string; // SQL expr
  }): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants
           (id, owner_id, grantee_email, wait_days, token_hash, token_expires_at, status, tenant_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 3, $4, ${opts.tokenExpiresAt}, $5::"EmergencyAccessStatus", $6::uuid, now(), now())`,
        id,
        ownerId,
        `grantee-${id.slice(0, 8)}@example.com`,
        `tok-${id.slice(0, 16)}`,
        opts.status,
        tenantId,
      );
    });
    return id;
  }

  async function insertKeyPair(grantId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_key_pairs
           (id, grant_id, encrypted_private_key, private_key_iv, private_key_auth_tag, tenant_id)
         VALUES ($1::uuid, $2::uuid, '\\x00', 'iv', 'tag', $3::uuid)`,
        id,
        grantId,
        tenantId,
      );
    });
    return id;
  }

  async function grantExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM emergency_access_grants WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function keyPairExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM emergency_access_key_pairs WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function sweep() {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, grantEntry, 100);
    });
  }

  it("deletes REVOKED and REJECTED grants (terminal)", async () => {
    const revoked = await insertGrant({
      status: "REVOKED",
      tokenExpiresAt: "now() + interval '1 day'",
    });
    const rejected = await insertGrant({
      status: "REJECTED",
      tokenExpiresAt: "now() + interval '1 day'",
    });

    await sweep();

    expect(await grantExists(revoked)).toBe(false);
    expect(await grantExists(rejected)).toBe(false);
  });

  it("deletes a never-accepted EXPIRED invite (PENDING + token_expires_at past)", async () => {
    const expiredInvite = await insertGrant({
      status: "PENDING",
      tokenExpiresAt: "now() - interval '1 hour'",
    });
    await sweep();
    expect(await grantExists(expiredInvite)).toBe(false);
  });

  it("KEEPS a still-pending live invite (PENDING + token_expires_at future)", async () => {
    const liveInvite = await insertGrant({
      status: "PENDING",
      tokenExpiresAt: "now() + interval '6 days'",
    });
    await sweep();
    expect(await grantExists(liveInvite)).toBe(true);
  });

  it("CRITICAL (RT7): KEEPS an ACCEPTED grant whose token_expires_at is in the past (still live)", async () => {
    // token_expires_at is the invite window; an ACCEPTED grant is live past it.
    // Removing the EMERGENCY_GRANT_DEAD guard would delete this — data loss.
    const liveAccepted = await insertGrant({
      status: "ACCEPTED",
      tokenExpiresAt: "now() - interval '30 days'",
    });
    const activated = await insertGrant({
      status: "ACTIVATED",
      tokenExpiresAt: "now() - interval '30 days'",
    });
    await sweep();
    expect(await grantExists(liveAccepted)).toBe(true);
    expect(await grantExists(activated)).toBe(true);
  });

  it("KEEPS recoverable STALE/IDLE grants even with token_expires_at past", async () => {
    const stale = await insertGrant({
      status: "STALE",
      tokenExpiresAt: "now() - interval '30 days'",
    });
    const idle = await insertGrant({
      status: "IDLE",
      tokenExpiresAt: "now() - interval '30 days'",
    });
    await sweep();
    expect(await grantExists(stale)).toBe(true);
    expect(await grantExists(idle)).toBe(true);
  });

  it("cascade-removes a dead grant's emergency_access_key_pairs child", async () => {
    const revoked = await insertGrant({
      status: "REVOKED",
      tokenExpiresAt: "now() + interval '1 day'",
    });
    const keyPair = await insertKeyPair(revoked);

    await sweep();

    expect(await grantExists(revoked)).toBe(false);
    expect(await keyPairExists(keyPair)).toBe(false); // cascade
  });

  it("worker role CAN delete dead grants but CANNOT delete audit_logs (least privilege)", async () => {
    const revoked = await insertGrant({
      status: "REVOKED",
      tokenExpiresAt: "now() + interval '1 day'",
    });

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepAuditProvenanceEntry(tx, grantEntry, 100);
    });
    expect(await grantExists(revoked)).toBe(false);

    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
