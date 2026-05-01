/**
 * Integration test: outbox worker skips chain advancement for tenants whose
 * anchor has publish_paused_until set in the future.
 *
 * After deliverRowWithChain runs against a paused tenant:
 * - The outbox row must still be PENDING (not SENT).
 * - No audit_logs row must have been inserted for that outbox_id.
 * - The anchor chain_seq must not have advanced.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { deliverRowWithChain } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";

describe("deliverRowWithChain — respects publish_paused_until", () => {
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

    // Enable audit chain for the tenant
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantId,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("leaves outbox row PENDING and does not advance chain when publish_paused_until is in the future", async () => {
    const outboxId = randomUUID();
    const createdAt = new Date();

    // Insert a PROCESSING outbox row (simulating a row already claimed by the worker)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
        createdAt.toISOString(),
      );
    });

    // Seed the anchor row with publish_paused_until = now() + 1 hour
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, publish_paused_until)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now(), now() + interval '1 hour')
         ON CONFLICT (tenant_id) DO UPDATE
           SET publish_paused_until = now() + interval '1 hour'`,
        tenantId,
      );
    });

    const row: AuditOutboxRow = {
      id: outboxId,
      tenant_id: tenantId,
      payload: { scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" },
      status: "PROCESSING",
      attempt_count: 0,
      max_attempts: 5,
      created_at: createdAt,
      next_retry_at: createdAt,
      processing_started_at: new Date(),
      sent_at: null,
      last_error: null,
    };

    const payload: AuditOutboxPayload = {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
    };

    // Run deliverRowWithChain using the superuser Prisma client
    const delivered = await deliverRowWithChain(ctx.su.prisma, row, payload);

    // deliverRowWithChain must signal that the row was NOT delivered
    expect(delivered).toBe(false);

    // Outbox row must still be PENDING (not SENT)
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe("PENDING");

    // No audit_logs row must have been inserted for this outbox_id
    const auditRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    expect(auditRows).toHaveLength(0);

    // The anchor chain_seq must not have advanced (still 0)
    const anchorRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(anchorRows).toHaveLength(1);
    expect(Number(anchorRows[0].chain_seq)).toBe(0);
  });

  it("advances chain normally when publish_paused_until is NULL", async () => {
    const outboxId = randomUUID();
    const createdAt = new Date();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
        createdAt.toISOString(),
      );
    });

    // Seed anchor with publish_paused_until = NULL (not paused)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );
    });

    const row: AuditOutboxRow = {
      id: outboxId,
      tenant_id: tenantId,
      payload: { scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" },
      status: "PROCESSING",
      attempt_count: 0,
      max_attempts: 5,
      created_at: createdAt,
      next_retry_at: createdAt,
      processing_started_at: new Date(),
      sent_at: null,
      last_error: null,
    };

    const payload: AuditOutboxPayload = {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
    };

    const delivered = await deliverRowWithChain(ctx.su.prisma, row, payload);

    expect(delivered).toBe(true);

    // Outbox row must be SENT
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(outboxRows[0].status).toBe("SENT");

    // Anchor chain_seq must have advanced to 1
    const anchorRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(anchorRows[0].chain_seq)).toBe(1);
  });

  it("advances chain normally when publish_paused_until is in the past", async () => {
    const outboxId = randomUUID();
    const createdAt = new Date();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, $4::timestamptz, now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
        createdAt.toISOString(),
      );
    });

    // Seed anchor with publish_paused_until = 1 hour in the PAST (expired pause)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, publish_paused_until)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now(), now() - interval '1 hour')
         ON CONFLICT (tenant_id) DO UPDATE
           SET publish_paused_until = now() - interval '1 hour'`,
        tenantId,
      );
    });

    const row: AuditOutboxRow = {
      id: outboxId,
      tenant_id: tenantId,
      payload: { scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" },
      status: "PROCESSING",
      attempt_count: 0,
      max_attempts: 5,
      created_at: createdAt,
      next_retry_at: createdAt,
      processing_started_at: new Date(),
      sent_at: null,
      last_error: null,
    };

    const payload: AuditOutboxPayload = {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
    };

    const delivered = await deliverRowWithChain(ctx.su.prisma, row, payload);

    // Expired pause — should proceed normally
    expect(delivered).toBe(true);

    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(outboxRows[0].status).toBe("SENT");
  });
});
