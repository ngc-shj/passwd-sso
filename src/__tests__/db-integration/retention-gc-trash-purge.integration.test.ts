/**
 * Real-DB integration tests for sweepTrashEntry (SC2 / C3 / C6 / C7 / T2).
 *
 * DB blob backend (the CI default): collectEntryAttachmentRefs returns [] and
 * the FK cascade removes the Attachment rows with the entry. Covers:
 *   - trashed entry past grace (deleted_at = now()-31d) → deleted + its
 *     attachment row gone via cascade.
 *   - within-grace trashed entry (deleted_at = now()-5d) → kept.
 *   - non-trashed entry (deleted_at NULL) → kept.
 *   - NULL-retention tenant's trashed entry → untouched.
 *   - T2 negative grant: the worker role CANNOT directly DELETE FROM attachments
 *     (permission denied) but CAN delete password_entries (cascade removes the
 *     attachment).
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
import { sweepTrashEntry } from "@/workers/retention-gc-worker/sweep";
import type { PerTenantTrashEntry } from "@/workers/retention-gc-worker/registry";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

const PERSONAL_ENTRY: PerTenantTrashEntry = {
  kind: "PER_TENANT_TRASH",
  table: "password_entries",
  scopeKind: "personal",
  tenantRetentionColumn: "trashRetentionDays",
};

describe("retention-gc sweepTrashEntry: personal trash purge (SC2/C3/C7)", () => {
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
    // Drain the SYSTEM-tenant heartbeat/per-tenant audit rows this sweep enqueued.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id IN ($1::uuid, $2::uuid) AND status IN ('PENDING', 'PROCESSING')`,
        tenantId,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        tenantId,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  async function setTrashRetention(
    targetTenantId: string,
    days: number | null,
  ): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET trash_retention_days = $2 WHERE id = $1::uuid`,
        targetTenantId,
        days,
      );
    });
  }

  async function insertEntry(opts: {
    ownerTenantId: string;
    ownerUserId: string;
    deletedAt: string; // SQL expression or 'NULL'
  }): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_entries
           (id, encrypted_blob, blob_iv, blob_auth_tag,
            encrypted_overview, overview_iv, overview_auth_tag,
            key_version, user_id, tenant_id, deleted_at, created_at, updated_at)
         VALUES ($1::uuid, 'blob', 'iv0', 'tag0',
                 'ov', 'oviv', 'ovtag',
                 1, $2::uuid, $3::uuid, ${opts.deletedAt}, now(), now())`,
        id,
        opts.ownerUserId,
        opts.ownerTenantId,
      );
    });
    return id;
  }

  async function insertAttachment(
    entryId: string,
    ownerTenantId: string,
    ownerUserId: string,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO attachments
           (id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
            tenant_id, password_entry_id, created_by_id, created_at)
         VALUES ($1::uuid, 'f.txt', 'text/plain', 3, '\\x010203'::bytea, 'aiv', 'atag',
                 $2::uuid, $3::uuid, $4::uuid, now())`,
        id,
        ownerTenantId,
        entryId,
        ownerUserId,
      );
    });
    return id;
  }

  async function entryExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM password_entries WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length === 1;
  }

  async function attachmentExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM attachments WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length === 1;
  }

  it("purges a past-grace trashed entry and cascade-removes its attachment; keeps within-grace + non-trashed", async () => {
    await setTrashRetention(tenantId, 30);

    // Past grace (31d) — should be purged, with its attachment.
    const pastId = await insertEntry({
      ownerTenantId: tenantId,
      ownerUserId: userId,
      deletedAt: "now() - interval '31 days'",
    });
    const attachmentId = await insertAttachment(pastId, tenantId, userId);

    // Within grace (5d) — should be kept.
    const withinGraceId = await insertEntry({
      ownerTenantId: tenantId,
      ownerUserId: userId,
      deletedAt: "now() - interval '5 days'",
    });

    // Non-trashed (deleted_at NULL) — should be kept.
    const liveId = await insertEntry({
      ownerTenantId: tenantId,
      ownerUserId: userId,
      deletedAt: "NULL",
    });

    const deleted = await sweepTrashEntry(ctx.su.prisma, PERSONAL_ENTRY, 100);

    // Only the configured tenant's past-grace entry is deleted.
    expect(deleted).toBe(1);
    expect(await entryExists(pastId)).toBe(false);
    expect(await attachmentExists(attachmentId)).toBe(false); // cascade
    expect(await entryExists(withinGraceId)).toBe(true);
    expect(await entryExists(liveId)).toBe(true);
  });

  it("does not touch a NULL-retention tenant's past-grace trashed entry", async () => {
    // tenantId keeps its default NULL trash_retention_days.
    const pastId = await insertEntry({
      ownerTenantId: tenantId,
      ownerUserId: userId,
      deletedAt: "now() - interval '90 days'",
    });

    const deleted = await sweepTrashEntry(ctx.su.prisma, PERSONAL_ENTRY, 100);

    expect(deleted).toBe(0);
    expect(await entryExists(pastId)).toBe(true);
  });

  // ─── T2: negative grant — worker role can't directly DELETE attachments ──────

  it("T2: worker role CANNOT directly DELETE FROM attachments, but CAN delete password_entries (cascade removes the attachment)", async () => {
    await setTrashRetention(tenantId, 30);
    const entryId = await insertEntry({
      ownerTenantId: tenantId,
      ownerUserId: userId,
      deletedAt: "now() - interval '31 days'",
    });
    const attachmentId = await insertAttachment(entryId, tenantId, userId);

    // Direct DELETE FROM attachments is denied for the worker role.
    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM attachments WHERE id = $1::uuid`,
          attachmentId,
        );
      }),
    ).rejects.toThrow(/permission denied/);

    // Attachment still present (the denied DELETE rolled back).
    expect(await attachmentExists(attachmentId)).toBe(true);

    // But deleting the parent entry via the worker role cascades the attachment.
    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM password_entries WHERE id = $1::uuid`,
        entryId,
      );
    });

    expect(await entryExists(entryId)).toBe(false);
    expect(await attachmentExists(attachmentId)).toBe(false);
  });
});
