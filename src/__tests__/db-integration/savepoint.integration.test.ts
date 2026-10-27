/**
 * Integration test (real DB): attemptInSavepoint inside a tenant RLS
 * transaction, as the app role.
 *
 * The unit test pins the statement sequence; this pins what PostgreSQL does
 * with it — a statement rejected inside `fn` leaves the outer transaction
 * usable, `fn`'s earlier writes are undone, and the transaction still commits
 * everything written outside the failed attempt.
 *
 * Run: docker compose up -d db && npm run test:integration -- savepoint
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "./helpers";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { attemptInSavepoint } from "@/lib/prisma/savepoint";

describe("attemptInSavepoint — real-DB integration", () => {
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

  async function persistedTagIds(): Promise<string[]> {
    const r = await ctx.su.pool.query<{ id: string }>(
      `SELECT id FROM tags WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return r.rows.map((row) => row.id).sort();
  }

  it("undoes a failed attempt's earlier write, and the next attempt and the outer transaction commit", async () => {
    const rolledBackId = randomUUID();
    const keptId = randomUUID();

    const [failed, succeeded] = await withTenantRls(prisma, tenantId, async (tx) => {
      const createTag = (id: string) =>
        tx.tag.create({ data: { id, name: `tag-${randomUUID()}`, userId, tenantId } });

      const first = await attemptInSavepoint(tx, async () => {
        await createTag(rolledBackId);
        await createTag(rolledBackId); // tags_pkey violation
      });
      const second = await attemptInSavepoint(tx, () => createTag(keptId));
      return [first, second] as const;
    });

    expect(failed.ok).toBe(false);
    expect(failed.ok ? null : pgErrorCode(failed.error)).toBe("23505");
    expect(succeeded.ok).toBe(true);
    expect(await persistedTagIds()).toEqual([keptId]);
  });

  it("a failed inner attempt inside a successful outer attempt undoes only the inner writes", async () => {
    const outerBeforeId = randomUUID();
    const innerId = randomUUID();
    const outerAfterId = randomUUID();

    const outer = await withTenantRls(prisma, tenantId, async (tx) => {
      const createTag = (id: string) =>
        tx.tag.create({ data: { id, name: `tag-${randomUUID()}`, userId, tenantId } });

      return attemptInSavepoint(tx, async () => {
        await createTag(outerBeforeId);
        const inner = await attemptInSavepoint(tx, async () => {
          await createTag(innerId);
          await createTag(innerId); // tags_pkey violation
        });
        await createTag(outerAfterId);
        return inner;
      });
    });

    expect(outer.ok).toBe(true);
    expect(outer.ok && outer.value.ok).toBe(false);
    expect(await persistedTagIds()).toEqual([outerBeforeId, outerAfterId].sort());
  });
});
