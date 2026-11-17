/**
 * Integration test (real DB): the tenant audit-log list and download filter by
 * actor (`userId`) and page stably when many rows share one `createdAt`
 * (#1069). The routes, the tenant RLS reads (as passwd_app) and the permission
 * check are real; only `auth()` and the rate limiter are mocked.
 *
 * Run (this database must not be shared with a live outbox worker):
 *   npm run test:integration -- tenant-audit-log-actor-filter
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_LOG_BATCH_SIZE } from "@/lib/validations/common.server";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { GET as listLogs } from "@/app/api/tenant/audit-logs/route";
import { GET as downloadLogs } from "@/app/api/tenant/audit-logs/download/route";

describe("tenant audit-log actor filter — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let otherTenantId: string;
  let admin: string;
  let member: string;
  let colleague: string;
  let otherTenantMember: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    admin = await ctx.createUser(tenantId);
    member = await ctx.createUser(tenantId);
    colleague = await ctx.createUser(tenantId);
    otherTenantMember = await ctx.createUser(otherTenantId);
    mockAuth.mockResolvedValue({ user: { id: admin } });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  /** `count` rows for one actor sharing a single created_at. */
  async function seedRows(tenant: string, actor: string, count: number, createdAt: string) {
    await ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, outbox_id, created_at)
         SELECT gen_random_uuid(), $1::uuid, 'TENANT', 'POLICY_UPDATE', $2::uuid, 'HUMAN', gen_random_uuid(), $3::timestamptz
         FROM generate_series(1, $4::int)`,
        tenant, actor, createdAt, count,
      );
    });
  }

  const SHARED_AT = new Date(Date.now() - 86_400_000).toISOString();

  async function list(query: Record<string, string>) {
    const res = await listLogs(
      new NextRequest(`http://localhost/api/tenant/audit-logs?${new URLSearchParams(query)}`),
    );
    return { status: res.status, body: (await res.json()) as { items: { id: string; userId: string }[]; nextCursor: string | null } };
  }

  async function download(query: Record<string, string>) {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const res = await downloadLogs(
      new NextRequest(`http://localhost/api/tenant/audit-logs/download?${new URLSearchParams({ from, ...query })}`),
    );
    const text = res.status === 200 ? await res.text() : "";
    const rows = text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as { id: string; userId?: string; action: string }) : [];
    return { status: res.status, rows };
  }

  it("returns this tenant's rows of the member and none of another member's or tenant's", async () => {
    await seedRows(tenantId, member, 3, SHARED_AT);
    await seedRows(tenantId, colleague, 2, SHARED_AT);
    // The same actor id under another tenant, and another tenant's own member.
    await seedRows(otherTenantId, member, 4, SHARED_AT);
    await seedRows(otherTenantId, otherTenantMember, 5, SHARED_AT);

    const mine = await list({ userId: member });
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(3);
    expect(new Set(mine.body.items.map((i) => i.userId))).toEqual(new Set([member]));

    const foreign = await list({ userId: otherTenantMember });
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toHaveLength(0);

    const unfiltered = await list({ limit: "100", action: "POLICY_UPDATE" });
    expect(unfiltered.body.items.map((i) => i.userId).sort()).toEqual(
      [member, member, member, colleague, colleague].sort(),
    );
  });

  it("the download returns the same narrowed set", async () => {
    await seedRows(tenantId, member, 3, SHARED_AT);
    await seedRows(tenantId, colleague, 2, SHARED_AT);
    await seedRows(otherTenantId, member, 4, SHARED_AT);

    const narrowed = await download({ userId: member });
    expect(narrowed.status).toBe(200);
    expect(narrowed.rows).toHaveLength(3);
    expect(narrowed.rows.every((r) => r.userId === member)).toBe(true);
  });

  it("answers 400 for an invalid userId on both routes", async () => {
    expect((await list({ userId: "nope" })).status).toBe(400);
    expect((await download({ userId: "nope" })).status).toBe(400);
  });

  it("pages the list without skip or duplicate when rows share one createdAt", async () => {
    const total = 130;
    await seedRows(tenantId, member, total, SHARED_AT);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list({
        userId: member,
        limit: "50",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i) => i.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  // The actor filter holding across a download batch boundary. It does not prove
  // the download's { id } tiebreak: without it Prisma reads the cursor in memory
  // and PostgreSQL happens to return the tied rows in a stable order here (see
  // containment-followups-deviation D8). That is pinned by the route's orderBy
  // unit cells and src/__tests__/cursor-pagination-tiebreak.test.ts.
  it("streams every narrowed row across download batches when rows share one createdAt", async () => {
    const total = AUDIT_LOG_BATCH_SIZE + 20;
    await seedRows(tenantId, member, total, SHARED_AT);

    const { status, rows } = await download({ userId: member });

    expect(status).toBe(200);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.id)).size).toBe(total);
  });
});
