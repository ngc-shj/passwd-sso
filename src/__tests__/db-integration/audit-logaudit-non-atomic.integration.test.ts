/**
 * Negative test: enqueueAudit (standalone) persists even when an outer
 * transaction rolls back, proving the audit write is non-atomic with
 * the caller's business transaction.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { enqueueAudit, type AuditOutboxPayload } from "@/lib/audit-outbox";

describe("audit logAuditAsync non-atomic (negative test)", () => {
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
    await ctx.deleteTestData(tenantId);
  });

  function makePayload(): AuditOutboxPayload {
    return {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: "PasswordEntry",
      targetId: randomUUID(),
      metadata: null,
      ip: "127.0.0.1",
      userAgent: "integration-test",
    };
  }

  it("enqueueAudit persists independently of the caller's transaction", async () => {
    // enqueueAudit creates its own internal transaction, so it commits
    // regardless of what happens in the caller's scope.
    await enqueueAudit(tenantId, makePayload());

    // Simulate an outer business transaction that rolls back AFTER the
    // enqueueAudit call has already committed its own transaction.
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // Some business write that will be rolled back
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET name = 'should-rollback' WHERE id = $1::uuid`,
          tenantId,
        );
        throw new Error("outer tx rollback");
      }),
    ).rejects.toThrow("outer tx rollback");

    // The outbox row persists because enqueueAudit used its own connection
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });
});
