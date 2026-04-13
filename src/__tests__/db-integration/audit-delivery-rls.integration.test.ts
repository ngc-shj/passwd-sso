/**
 * Phase 3: RLS enforcement on audit_delivery_targets and audit_deliveries.
 * Cross-tenant reads are blocked for both passwd_app and passwd_user roles.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-delivery RLS", () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    userA = await ctx.createUser(tenantA);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
  });

  /** Insert a delivery target for tenant A using superuser with bypass. */
  async function insertTargetForA(kind: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, $3::"AuditDeliveryTargetKind", 'test_enc', 'test_iv', 'test_tag', 1, true, now())`,
        id,
        tenantA,
        kind,
      );
    });
    return id;
  }

  /** Insert a delivery row for tenant A. */
  async function insertDeliveryForA(outboxId: string, targetId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        id,
        outboxId,
        targetId,
        tenantA,
      );
    });
    return id;
  }

  async function insertOutboxForA(): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
        id,
        tenantA,
        JSON.stringify({
          scope: "PERSONAL",
          action: "ENTRY_CREATE",
          userId: userA,
          actorType: "HUMAN",
        }),
      );
    });
    return id;
  }

  it("passwd_app with tenant B cannot read tenant A delivery targets", async () => {
    await insertTargetForA("WEBHOOK");

    // Set GUCs for tenant B on the app connection
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_delivery_targets`,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("passwd_app with tenant B cannot read tenant A deliveries", async () => {
    const targetId = await insertTargetForA("SIEM_HEC");
    const outboxId = await insertOutboxForA();
    await insertDeliveryForA(outboxId, targetId);

    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries`,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("passwd_app with tenant A CAN read its own delivery targets", async () => {
    await insertTargetForA("WEBHOOK");
    await insertTargetForA("S3_OBJECT");

    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_delivery_targets`,
      );
    });
    expect(Number(rows[0].cnt)).toBe(2);
  });

  it("passwd_app with tenant A CAN read its own deliveries", async () => {
    const targetId = await insertTargetForA("WEBHOOK");
    const outboxId = await insertOutboxForA();
    await insertDeliveryForA(outboxId, targetId);

    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries`,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("superuser without bypass RLS cannot read cross-tenant (FORCE RLS)", async () => {
    await insertTargetForA("WEBHOOK");

    // Superuser (passwd_user) without bypass GUC — RLS is FORCE-enabled
    // so even the table owner should see 0 rows without correct tenant_id
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      // Set tenant_id to tenant B (not A) without bypass
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_delivery_targets`,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });
});
