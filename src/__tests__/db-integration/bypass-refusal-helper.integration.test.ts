/**
 * expectBypassRefusal's own cells: it must fail when the statement it wraps is
 * not refused, or is refused for another reason, or a refusal cell would pass
 * on a statement the database admitted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, assertRlsApplies, expectBypassRefusal, type TestContext } from "./helpers";
import { defineGrant, setBypassGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

const SESSIONS_ONLY = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["session"]);
const USERS_ONLY = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user"]);

describe("expectBypassRefusal", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(ctx.app.prisma);
    tenantId = await ctx.createTenant();
    await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  const readUsersUnder = (grant: typeof USERS_ONLY) =>
    ctx.app.prisma.$transaction(async (tx) => {
      await setBypassGucs(tx, grant);
      return tx.user.findFirst({ select: { id: true } });
    });

  it("returns the reports and the table of a refused statement", async () => {
    const { notices, table, error } = await expectBypassRefusal(() => readUsersUnder(SESSIONS_ONLY));
    expect(table).toBe("users");
    expect(notices).toEqual([{ table: "users", purpose: "auth_flow" }]);
    expect(error).toBeInstanceOf(Error);
  });

  it("throws when the statement resolves", async () => {
    await expect(expectBypassRefusal(() => readUsersUnder(USERS_ONLY))).rejects.toThrow(
      "but the statement succeeded",
    );
  });

  it("throws when the statement rejects with another SQLSTATE", async () => {
    await expect(
      expectBypassRefusal(() => ctx.app.prisma.$queryRawUnsafe(`SELECT 1 FROM no_such_table_for_refusal_helper`)),
    ).rejects.toThrow(/expected a 42501 RLS_BYPASS_NOT_GRANTED refusal, got SQLSTATE 42P01/);
  });

  it("throws on a 42501 that is not the bypass refusal", async () => {
    await expect(
      expectBypassRefusal(() => ctx.app.prisma.$queryRawUnsafe(`SELECT rolpassword FROM pg_authid`)),
    ).rejects.toThrow(/got SQLSTATE 42501/);
  });
});
