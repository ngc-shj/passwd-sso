/**
 * The anchor publisher suites' preconditions: each must refuse a row it was
 * not told about and accept the rows it was. A precondition that never
 * refuses turns every publisher case back into one whose verdict depends on
 * rows another file left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  assertNoForeignPublishedAnchors,
  assertOnlyChainEnabledTenants,
  seedChainTenant,
} from "./anchor-publisher-fixtures";

describe("anchor publisher preconditions", () => {
  let ctx: TestContext;
  let mine: string;
  let foreign: string;
  // Rows another file of this run may still hold: allowed in every call, so
  // only the planted foreign row decides the verdict.
  let ambientEnabled: string[];
  let ambientPublished: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
    const ambient = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const enabled = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text AS id FROM tenants WHERE audit_chain_enabled = true`,
      );
      const published = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT tenant_id::text AS id FROM audit_chain_anchors WHERE last_published_at IS NOT NULL`,
      );
      return { enabled, published };
    });
    ambientEnabled = ambient.enabled.map((r) => r.id);
    ambientPublished = ambient.published.map((r) => r.id);
    mine = await ctx.createTenant();
    foreign = await ctx.createTenant();
    for (const id of [mine, foreign]) {
      await seedChainTenant(ctx.su, id, { enabled: true, lastPublishedAt: new Date() });
    }
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it("refuses a chain-enabled tenant it was not told about, naming it", async () => {
    await expect(assertOnlyChainEnabledTenants(ctx.su, [...ambientEnabled, mine])).rejects.toThrow(foreign);
  });

  it("accepts the chain-enabled tenants it was told about", async () => {
    await expect(
      assertOnlyChainEnabledTenants(ctx.su, [...ambientEnabled, mine, foreign]),
    ).resolves.toBeUndefined();
  });

  it("refuses a published anchor it was not told about, naming its tenant", async () => {
    await expect(assertNoForeignPublishedAnchors(ctx.su, [...ambientPublished, mine])).rejects.toThrow(foreign);
  });

  it("accepts the published anchors it was told about", async () => {
    await expect(
      assertNoForeignPublishedAnchors(ctx.su, [...ambientPublished, mine, foreign]),
    ).resolves.toBeUndefined();
  });
});
