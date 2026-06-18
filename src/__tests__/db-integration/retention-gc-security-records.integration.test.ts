/**
 * Real-DB tests for EXPIRY_AUDIT_PROVENANCE security-record GC (SC6).
 *
 * Before deleting an expired security record, the worker emits its provenance to
 * the audit outbox UNDER THE ROW'S OWN TENANT, atomically, then deletes the row.
 * Two representatives are covered: team_invitations (simplest, no cascade child)
 * and password_shares (has an ON DELETE CASCADE child, share_access_logs).
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
import {
  RETENTION_REGISTRY,
  type AuditProvenanceEntry,
} from "@/workers/retention-gc-worker/registry";

function provenanceEntry(table: string): AuditProvenanceEntry {
  return RETENTION_REGISTRY.find(
    (e): e is AuditProvenanceEntry =>
      e.kind === "EXPIRY_AUDIT_PROVENANCE" && e.table === table,
  )!;
}

const inviteEntry = provenanceEntry("team_invitations");
const shareEntry = provenanceEntry("password_shares");

describe("retention-gc security-record GC (SC6)", () => {
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
  });
  afterEach(async () => {
    await cleanupSecurityRecords(tenantId);
    await ctx.deleteTestData(tenantId);
  });

  // deleteTestData does not know about these tables; clear them first (FK-safe).
  async function cleanupSecurityRecords(tid: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM share_access_logs WHERE tenant_id = $1::uuid`,
        tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM password_shares WHERE tenant_id = $1::uuid`,
        tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_invitations WHERE tenant_id = $1::uuid`,
        tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM teams WHERE tenant_id = $1::uuid`,
        tid,
      );
    });
  }

  async function createTeam(): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
        id,
        tenantId,
        `team-${id.slice(0, 8)}`,
        `slug-${id.slice(0, 8)}`,
      );
    });
    return id;
  }

  async function insertInvitation(
    teamId: string,
    expiresAt: string,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token, expires_at, invited_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', 'PENDING', $5, ${expiresAt}, $6::uuid, now(), now())`,
        id,
        teamId,
        tenantId,
        `invitee-${id.slice(0, 8)}@example.com`,
        `tok-${id.slice(0, 16)}`,
        userId,
      );
    });
    return id;
  }

  async function insertShare(expiresAt: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_shares (id, tenant_id, token_hash, share_type, encrypted_data, data_iv, data_auth_tag, expires_at, created_by_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'ENTRY_SHARE', 'enc', 'iv', 'tag', ${expiresAt}, $4::uuid, now())`,
        id,
        tenantId,
        `psh-${id.slice(0, 16)}`,
        userId,
      );
    });
    return id;
  }

  async function insertShareAccessLog(shareId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO share_access_logs (id, share_id, tenant_id, ip, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '10.0.0.1', now())`,
        id,
        shareId,
        tenantId,
      );
    });
    return id;
  }

  async function rowExists(table: string, id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ${table} WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function outboxRowsFor(targetId: string): Promise<
    {
      tenant_id: string;
      payload: { action: string; targetId: string; metadata: Record<string, unknown> };
    }[]
  > {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe(
        `SELECT tenant_id, payload FROM audit_outbox
         WHERE tenant_id = $1::uuid AND payload->>'targetId' = $2`,
        tenantId,
        targetId,
      );
    });
  }

  it("team_invitations: emits provenance under the row's own tenant, then deletes the expired invitation", async () => {
    const teamId = await createTeam();
    const inviteId = await insertInvitation(teamId, "now() - interval '1 hour'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, inviteEntry, 100);
    });

    expect(await rowExists("team_invitations", inviteId)).toBe(false);

    const rows = await outboxRowsFor(inviteId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].payload.action).toBe("SECURITY_RECORD_RETENTION_PURGED");
    expect(rows[0].payload.metadata.table).toBe("team_invitations");
    expect(rows[0].payload.metadata.invited_by_id).toBe(userId);
  });

  it("team_invitations: does NOT delete a non-expired invitation", async () => {
    const teamId = await createTeam();
    const inviteId = await insertInvitation(teamId, "now() + interval '1 hour'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, inviteEntry, 100);
    });

    expect(await rowExists("team_invitations", inviteId)).toBe(true);
    expect(await outboxRowsFor(inviteId)).toHaveLength(0);
  });

  it("team_invitations: worker role CAN delete + emit but CANNOT delete audit_logs (least privilege)", async () => {
    const teamId = await createTeam();
    const inviteId = await insertInvitation(teamId, "now() - interval '1 hour'");

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepAuditProvenanceEntry(tx, inviteEntry, 100);
    });
    expect(await rowExists("team_invitations", inviteId)).toBe(false);

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

  it("password_shares: deletes the expired share and cascades its share_access_logs child", async () => {
    const shareId = await insertShare("now() - interval '1 hour'");
    const logId = await insertShareAccessLog(shareId);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, shareEntry, 100);
    });

    expect(await rowExists("password_shares", shareId)).toBe(false);
    // ON DELETE CASCADE removed the child access log.
    expect(await rowExists("share_access_logs", logId)).toBe(false);

    const rows = await outboxRowsFor(shareId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].payload.action).toBe("SECURITY_RECORD_RETENTION_PURGED");
    expect(rows[0].payload.metadata.created_by_id).toBe(userId);
  });

  it("password_shares: does NOT delete a non-expired share", async () => {
    const shareId = await insertShare("now() + interval '1 hour'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, shareEntry, 100);
    });

    expect(await rowExists("password_shares", shareId)).toBe(true);
    expect(await outboxRowsFor(shareId)).toHaveLength(0);
  });

  it("password_shares: worker role can run the full capture→emit→delete", async () => {
    const shareId = await insertShare("now() - interval '1 hour'");
    await insertShareAccessLog(shareId);

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepAuditProvenanceEntry(tx, shareEntry, 100);
    });
    expect(await rowExists("password_shares", shareId)).toBe(false);
  });
});
