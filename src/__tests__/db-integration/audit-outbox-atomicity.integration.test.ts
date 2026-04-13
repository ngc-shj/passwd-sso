/**
 * F1 atomicity: enqueueAuditInTx inside a transaction that rolls back
 * must also roll back the outbox row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { enqueueAuditInTx, type AuditOutboxPayload } from "@/lib/audit-outbox";

describe("audit-outbox atomicity (F1)", () => {
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

  it("rolls back outbox row when the enclosing transaction throws", async () => {
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await enqueueAuditInTx(tx, tenantId, makePayload());
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    // Verify no outbox row was persisted
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("commits exactly one PENDING outbox row on successful transaction", async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await enqueueAuditInTx(tx, tenantId, makePayload());
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint; status: string }[]>(
        `SELECT COUNT(*) AS cnt, MIN(status) AS status
         FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
    expect(rows[0].status).toBe("PENDING");
  });
});
