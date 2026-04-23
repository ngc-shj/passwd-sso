/**
 * Integration tests for the unified session-timeout policy:
 *   - Tenant-level defaults and per-column backfill from the Batch A migration
 *   - Team-override (strictest-wins) resolution
 *   - AAL3 clamp for webauthn sessions
 *   - Extension token family tracking across refresh
 *   - family_id / family_created_at NOT NULL flip (Batch D migration)
 *
 * Runs against the real Postgres dev instance via `npm run test:integration`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

describe("session timeout — integration", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("schema + migration state", () => {
    let tenantId: string;
    beforeEach(async () => {
      tenantId = await ctx.createTenant();
    });
    afterEach(async () => {
      await ctx.deleteTestData(tenantId);
    });

    it("tenant row has non-null session + extension columns seeded to policy defaults", async () => {
      const row = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            sessionIdleTimeoutMinutes: true,
            sessionAbsoluteTimeoutMinutes: true,
            extensionTokenIdleTimeoutMinutes: true,
            extensionTokenAbsoluteTimeoutMinutes: true,
          },
        });
      });
      expect(row.sessionIdleTimeoutMinutes).toBe(480);
      expect(row.sessionAbsoluteTimeoutMinutes).toBe(43200);
      expect(row.extensionTokenIdleTimeoutMinutes).toBe(10080);
      expect(row.extensionTokenAbsoluteTimeoutMinutes).toBe(43200);
    });

    it("extension_tokens.family_id / family_created_at are NOT NULL at the DB level", async () => {
      // Insert a row with explicit null must fail
      await expect(
        ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          const userId = await ctx.createUser(tenantId);
          // Raw insert — skips Prisma type-check to verify the DB constraint directly
          await tx.$executeRawUnsafe(
            `INSERT INTO extension_tokens (
               id, user_id, tenant_id, token_hash, scope, expires_at, created_at,
               family_id, family_created_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now() + interval '1 hour', now(), NULL, NULL)`,
            randomUUID(),
            userId,
            tenantId,
            `tok_${randomUUID()}`,
            "passwords:read",
          );
        }),
      ).rejects.toThrow(/null value in column "family_(id|created_at)"/);
    });
  });

  describe("resolver — end-to-end with real DB", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
    });
    afterEach(async () => {
      // Clean up teams first (deleteTestData only handles tenant-scoped tables
      // that it knows about; teams + team_policies + team_members must go here).
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM team_policies WHERE tenant_id = $1::uuid`, tenantId);
        await tx.$executeRawUnsafe(`DELETE FROM team_members WHERE tenant_id = $1::uuid`, tenantId);
        await tx.$executeRawUnsafe(`DELETE FROM teams WHERE tenant_id = $1::uuid`, tenantId);
      });
      await ctx.deleteTestData(tenantId);
    });

    it("returns tenant values when user has no team policies", async () => {
      // Dynamic import so the resolver reads the freshly-regenerated Prisma client
      const mod = await import("@/lib/auth/session-timeout");
      mod._internal.clear();

      const result = await mod.resolveEffectiveSessionTimeouts(userId, null);
      expect(result.tenantId).toBe(tenantId);
      expect(result.idleMinutes).toBe(480);
      expect(result.absoluteMinutes).toBe(43200);
    });

    it("applies AAL3 clamp when sessionProvider === 'webauthn'", async () => {
      const mod = await import("@/lib/auth/session-timeout");
      mod._internal.clear();

      const result = await mod.resolveEffectiveSessionTimeouts(userId, "webauthn");
      expect(result.idleMinutes).toBe(15);
      expect(result.absoluteMinutes).toBe(720);
    });

    it("applies the strictest team override across memberships", async () => {
      // Seed two teams with differing policies
      const teamIdA = await seedTeamWithPolicy(ctx, tenantId, userId, {
        sessionIdleTimeoutMinutes: 120,
        sessionAbsoluteTimeoutMinutes: 1440,
      });
      const teamIdB = await seedTeamWithPolicy(ctx, tenantId, userId, {
        sessionIdleTimeoutMinutes: 60,
        sessionAbsoluteTimeoutMinutes: null,
      });

      const mod = await import("@/lib/auth/session-timeout");
      mod._internal.clear();

      const result = await mod.resolveEffectiveSessionTimeouts(userId, null);
      expect(result.idleMinutes).toBe(60);        // strictest across A(120), B(60) wins
      expect(result.absoluteMinutes).toBe(1440);  // A sets it, B null ignored

      // sanity: both teams still exist
      expect(teamIdA).toBeTruthy();
      expect(teamIdB).toBeTruthy();
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────

async function seedTeamWithPolicy(
  ctx: TestContext,
  tenantId: string,
  userId: string,
  policy: {
    sessionIdleTimeoutMinutes: number | null;
    sessionAbsoluteTimeoutMinutes: number | null;
  },
): Promise<string> {
  const teamId = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.team.create({
      data: {
        id: teamId,
        tenantId,
        name: `team-${teamId.slice(0, 8)}`,
        slug: `team-${teamId.slice(0, 8)}`,
        teamKeyVersion: 0,
      },
    });
    await tx.teamMember.create({
      data: {
        teamId,
        tenantId,
        userId,
        role: "MEMBER",
      },
    });
    await tx.teamPolicy.create({
      data: {
        teamId,
        tenantId,
        sessionIdleTimeoutMinutes: policy.sessionIdleTimeoutMinutes,
        sessionAbsoluteTimeoutMinutes: policy.sessionAbsoluteTimeoutMinutes,
      },
    });
  });
  return teamId;
}
