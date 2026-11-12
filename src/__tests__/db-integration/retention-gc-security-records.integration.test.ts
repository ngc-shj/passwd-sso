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
  createPrismaForRole,
  raceTwoClients,
  type TestContext,
  type PrismaWithPool,
  inRetentionSweepTx,
} from "./helpers";
import { sweepAuditProvenanceEntry, grantForEntry } from "@/workers/retention-gc-worker/sweep";
import {
  RETENTION_REGISTRY,
  EXPIRED_RECORD_VISIBILITY_GRACE_DAYS,
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
const adminResetEntry = provenanceEntry("admin_vault_resets");
const breakGlassEntry = provenanceEntry("personal_log_access_grants");

// The grace is always derived from the registry constant, never a literal. Fail
// loud if a member entry stops carrying it: the boundary tests below pin it.
const G = EXPIRED_RECORD_VISIBILITY_GRACE_DAYS;
for (const entry of [shareEntry, adminResetEntry, breakGlassEntry]) {
  if (entry.retentionDays !== G) {
    throw new Error(
      `${entry.table} registry entry must carry retentionDays === EXPIRED_RECORD_VISIBILITY_GRACE_DAYS (${G}), got ${entry.retentionDays}`,
    );
  }
}

// DB-clock expiry expressions around the grace boundary.
const EXPIRED_1H = "now() - interval '1 hour'";
const EXPIRED_WITHIN_GRACE = `now() - make_interval(days => ${G - 1})`;
const EXPIRED_PAST_GRACE = `now() - make_interval(days => ${G}) - interval '1 hour'`;

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
        `DELETE FROM admin_vault_resets WHERE tenant_id = $1::uuid`,
        tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM personal_log_access_grants WHERE tenant_id = $1::uuid`,
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

  async function insertAdminReset(expiresAt: string): Promise<string> {
    const id = randomUUID();
    const targetUserId = await ctx.createUser(tenantId);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, token_hash, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, ${expiresAt}, now())`,
        id,
        tenantId,
        targetUserId,
        userId,
        `${id.replace(/-/g, "")}${id.replace(/-/g, "")}`,
      );
    });
    return id;
  }

  async function insertBreakGlassGrant(expiresAt: string): Promise<string> {
    const id = randomUUID();
    const targetUserId = await ctx.createUser(tenantId);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO personal_log_access_grants (id, tenant_id, requester_id, target_user_id, reason, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'incident review', ${expiresAt}, now())`,
        id,
        tenantId,
        userId,
        targetUserId,
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

    await inRetentionSweepTx(ctx.retentionWorker.prisma, async (tx) => {
      await sweepAuditProvenanceEntry(tx, inviteEntry, 100);
    }, grantForEntry(inviteEntry));
    expect(await rowExists("team_invitations", inviteId)).toBe(false);

    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("password_shares: deletes the expired share and cascades its share_access_logs child", async () => {
    const shareId = await insertShare(EXPIRED_PAST_GRACE);
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

  it.each([
    ["1 hour ago", EXPIRED_1H],
    ["G-1 days ago", EXPIRED_WITHIN_GRACE],
  ])("password_shares: keeps a share expired %s (inside the visibility grace)", async (_label, expr) => {
    const shareId = await insertShare(expr);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, shareEntry, 100);
    });

    expect(await rowExists("password_shares", shareId)).toBe(true);
    expect(await outboxRowsFor(shareId)).toHaveLength(0);
  });

  describe.each([
    ["admin_vault_resets", adminResetEntry, insertAdminReset],
    ["personal_log_access_grants", breakGlassEntry, insertBreakGlassGrant],
  ] as const)("%s grace window", (table, entry, insert) => {
    it.each([
      ["1 hour ago", EXPIRED_1H],
      ["G-1 days ago", EXPIRED_WITHIN_GRACE],
    ])("keeps a row expired %s, with no provenance row", async (_label, expr) => {
      const id = await insert(expr);

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await sweepAuditProvenanceEntry(tx, entry, 100);
      });

      expect(await rowExists(table, id)).toBe(true);
      expect(await outboxRowsFor(id)).toHaveLength(0);
    });

    it("deletes a row expired G days + 1 hour ago with one provenance row", async () => {
      const id = await insert(EXPIRED_PAST_GRACE);

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await sweepAuditProvenanceEntry(tx, entry, 100);
      });

      expect(await rowExists(table, id)).toBe(false);
      const rows = await outboxRowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantId);
      expect(rows[0].payload.action).toBe("SECURITY_RECORD_RETENTION_PURGED");
      expect(rows[0].payload.metadata.table).toBe(table);
    });
  });

  it("password_shares: worker role can run the full capture→emit→delete", async () => {
    const shareId = await insertShare(EXPIRED_PAST_GRACE);
    await insertShareAccessLog(shareId);

    await inRetentionSweepTx(ctx.retentionWorker.prisma, async (tx) => {
      await sweepAuditProvenanceEntry(tx, shareEntry, 100);
    }, grantForEntry(shareEntry));
    expect(await rowExists("password_shares", shareId)).toBe(false);
  });

  // A2 regression: two concurrent sweep instances over the same expired rows
  // must NOT double-emit provenance audit events. The delete-first reorder
  // (DELETE ... RETURNING, then emit from the returned rows) makes each row
  // returned to exactly one racer, so total audit rows == total deleted rows.
  it("A2: two racing sweeps over the same expired shares emit exactly one audit per row (no double-emit)", async () => {
    const SEED = 6;
    const shareIds: string[] = [];
    for (let i = 0; i < SEED; i++) {
      shareIds.push(await insertShare(EXPIRED_PAST_GRACE));
    }

    // Two separate connections so the DELETEs genuinely contend at the row level.
    const clientA: PrismaWithPool = createPrismaForRole("superuser");
    const clientB: PrismaWithPool = createPrismaForRole("superuser");
    try {
      // batchSize >= SEED so both racers' DELETE subqueries select the SAME
      // full id set — the maximal-overlap condition under which the OLD
      // select-then-emit code would double-emit. Delete-first serializes on
      // the row lock: the first DELETE removes all rows, the second finds them
      // gone and deletes 0, so each row is deleted (and audited) exactly once.
      // (A smaller batch is not used because a single race round with LIMIT <
      // SEED can leave some rows unswept — production catches them next cycle,
      // but the test needs a deterministic full sweep.)
      const runSweep = (c: PrismaWithPool) =>
        c.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return sweepAuditProvenanceEntry(tx, shareEntry, 100);
        });

      const [deletedA, deletedB] = await raceTwoClients(
        clientA.prisma,
        clientB.prisma,
        () => runSweep(clientA),
        () => runSweep(clientB),
      );

      // Per-racer split is nondeterministic (delete-first hands each row to
      // exactly one racer; a large-enough batch may let one take all) — the
      // invariant is that the union covers every row with no overlap.
      expect(deletedA + deletedB).toBe(SEED);

      // The real A2 guard: exactly one provenance audit row per seeded share.
      // A regression to select-then-emit would double-emit for the overlap and
      // fail this toHaveLength(1).
      let totalAudit = 0;
      for (const id of shareIds) {
        const rows = await outboxRowsFor(id);
        expect(rows).toHaveLength(1);
        totalAudit += rows.length;
      }
      expect(totalAudit).toBe(SEED);
      // Positive control: every seeded share was really deleted (the sweep ran
      // over eligible rows), so the audit count above is not vacuously equal.
      for (const id of shareIds) expect(await rowExists("password_shares", id)).toBe(false);
    } finally {
      await clientA.prisma.$disconnect().then(() => clientA.pool.end());
      await clientB.prisma.$disconnect().then(() => clientB.pool.end());
    }
  });
});
