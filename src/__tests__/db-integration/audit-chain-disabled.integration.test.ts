/**
 * Tests that a tenant with audit_chain_enabled = false (the default)
 * produces audit_logs rows without chain fields and no anchor row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

describe("audit-chain disabled tenant", () => {
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
    // Do NOT enable audit chain — default is false
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("inserts audit_logs without chain fields when chain is disabled", async () => {
    const auditLogId = randomUUID();
    const outboxId = randomUUID();
    const createdAt = new Date();

    // Create a SENT outbox row first (deliverRow writes outbox_id to audit_logs)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
    });

    // Simulate what deliverRow (non-chain path) does: insert audit_logs with outbox_id but without chain fields
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type,
          metadata, created_at, outbox_id
        ) VALUES (
          $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
          $3::uuid, 'HUMAN'::"ActorType",
          $4::jsonb, $5::timestamptz, $6::uuid
        )`,
        auditLogId,
        tenantId,
        userId,
        JSON.stringify({ test: "disabled-chain" }),
        createdAt.toISOString(),
        outboxId,
      );
    });

    // Verify chain fields are NULL
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        chain_seq: bigint | null;
        event_hash: Uint8Array | null;
        chain_prev_hash: Uint8Array | null;
      }[]>(
        `SELECT chain_seq, event_hash, chain_prev_hash
         FROM audit_logs WHERE id = $1::uuid`,
        auditLogId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].chain_seq).toBeNull();
    expect(rows[0].event_hash).toBeNull();
    expect(rows[0].chain_prev_hash).toBeNull();
  });

  it("does not create an anchor row for a disabled tenant", async () => {
    // Create a SENT outbox row so the HUMAN audit_logs row satisfies
    // CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
    });

    // Insert a plain audit_logs row (no chain)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type,
          created_at, outbox_id
        ) VALUES (
          $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
          $3::uuid, 'HUMAN'::"ActorType",
          now(), $4::uuid
        )`,
        randomUUID(),
        tenantId,
        userId,
        outboxId,
      );
    });

    // Verify no anchor row exists
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    expect(anchors).toHaveLength(0);
  });

  it("audit_chain_enabled defaults to false for new tenants", async () => {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ audit_chain_enabled: boolean }[]>(
        `SELECT audit_chain_enabled FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].audit_chain_enabled).toBe(false);
  });
});
