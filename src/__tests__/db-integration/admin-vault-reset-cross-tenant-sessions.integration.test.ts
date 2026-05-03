/**
 * Integration test (real DB + Redis): cross-tenant session invalidation
 * triggered by admin vault reset execute.
 *
 * Plan: docs/archive/review/admin-vault-reset-dual-approval-plan.md §11.2
 *   - FR7 + F3+S2 fix: invalidateUserSessions(userId, { allTenants: true })
 *     must clear Session rows in EVERY tenant the target belongs to,
 *     revoke ExtensionToken/ApiKey rows tenant-wide, and write tombstones
 *     to the per-session Redis cache so a leaked cookie cannot resurrect
 *     access to a wiped vault.
 *
 * Run: docker compose up -d db redis && npm run test:integration -- \
 *      admin-vault-reset-cross-tenant-sessions.integration
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { getRedis } from "@/lib/redis";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import {
  SESSION_CACHE_KEY_PREFIX,
  hashSessionToken,
} from "@/lib/auth/session/session-cache";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const redisAvailable = !!process.env.REDIS_URL;

function tombstoneKey(token: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
}

describe.skipIf(!redisAvailable)(
  "admin-vault-reset cross-tenant session invalidation (real DB + Redis)",
  () => {
    let ctx: TestContext;
    let redis: Redis;
    let tenantA: string;
    let tenantB: string;
    let userId: string;
    const sessionTokens: string[] = [];

    beforeAll(async () => {
      ctx = await createTestContext();
      const r = getRedis();
      if (!r) throw new Error("REDIS_URL set but getRedis() returned null");
      redis = r;
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    beforeEach(async () => {
      tenantA = await ctx.createTenant();
      tenantB = await ctx.createTenant();
      userId = await ctx.createUser(tenantA);
      sessionTokens.length = 0;

      // Make the user a member of tenantB as well.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
          randomUUID(),
          tenantB,
          userId,
        );
      });
    });

    afterEach(async () => {
      // Clean Redis tombstones for this test's session tokens.
      for (const token of sessionTokens) {
        await redis.del(tombstoneKey(token));
      }

      // FK-safe — sessions/extensionTokens/apiKeys/mcp tokens/delegation
      // sessions ref users; clear before user delete via deleteTestData.
      // delegation_sessions FKs into mcp_access_tokens, so clear it first.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM delegation_sessions WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_refresh_tokens WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_access_tokens WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_clients WHERE created_by_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM sessions WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_tokens WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM api_keys WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM tenant_members WHERE user_id = $1::uuid`,
          userId,
        );
      });
      await ctx.deleteTestData(tenantA);
      await ctx.deleteTestData(tenantB);
    });

    async function insertSession(tenantId: string): Promise<string> {
      const token = `sess-${randomUUID()}-${Math.random().toString(36).slice(2)}`;
      sessionTokens.push(token);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (
             id, session_token, user_id, tenant_id, expires, created_at, last_active_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid,
             now() + interval '1 day', now(), now()
           )`,
          randomUUID(),
          token,
          userId,
          tenantId,
        );
      });
      return token;
    }

    async function insertExtensionToken(tenantId: string): Promise<string> {
      const id = randomUUID();
      const familyId = randomUUID();
      const tokenHash = (id + id).replace(/-/g, "").slice(0, 64);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO extension_tokens (
             id, user_id, tenant_id, token_hash, scope,
             expires_at, family_id, family_created_at, created_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5,
             now() + interval '1 day', $6::uuid, now(), now()
           )`,
          id,
          userId,
          tenantId,
          tokenHash,
          "extension:read",
          familyId,
        );
      });
      return id;
    }

    async function insertApiKey(tenantId: string): Promise<string> {
      const id = randomUUID();
      const tokenHash = (id + id).replace(/-/g, "").slice(0, 64);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO api_keys (
             id, user_id, tenant_id, token_hash, prefix, name, scope,
             expires_at, created_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, 'api_test',
             $5, 'passwords:read',
             now() + interval '1 day', now()
           )`,
          id,
          userId,
          tenantId,
          tokenHash,
          `test-key-${id.slice(0, 8)}`,
        );
      });
      return id;
    }

    /** Inserts a McpClient + McpAccessToken + McpRefreshToken + DelegationSession,
     *  all bound to the test user under the given tenant. Returns the four ids. */
    async function insertMcpStack(tenantId: string): Promise<{
      mcpClientId: string;
      mcpAccessTokenId: string;
      mcpRefreshTokenId: string;
      delegationSessionId: string;
    }> {
      const mcpClientId = randomUUID();
      const mcpAccessTokenId = randomUUID();
      const mcpRefreshTokenId = randomUUID();
      const delegationSessionId = randomUUID();
      const accessTokenHash = (mcpAccessTokenId + mcpAccessTokenId)
        .replace(/-/g, "")
        .slice(0, 64);
      const refreshTokenHash = (mcpRefreshTokenId + mcpRefreshTokenId)
        .replace(/-/g, "")
        .slice(0, 64);
      const familyId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (
             id, tenant_id, client_id, client_secret_hash, name,
             redirect_uris, allowed_scopes, is_active, created_by_id,
             created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5,
             ARRAY['http://localhost/cb']::text[], 'passwords:read', true, $6::uuid,
             now(), now()
           )`,
          mcpClientId,
          tenantId,
          `cli-${mcpClientId.slice(0, 16)}`,
          accessTokenHash,
          `test-mcp-client-${mcpClientId.slice(0, 8)}`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_access_tokens (
             id, token_hash, client_id, tenant_id, user_id, scope,
             expires_at, created_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'passwords:read',
             now() + interval '1 day', now()
           )`,
          mcpAccessTokenId,
          accessTokenHash,
          mcpClientId,
          tenantId,
          userId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_refresh_tokens (
             id, token_hash, family_id, access_token_id, client_id,
             tenant_id, user_id, scope, expires_at, created_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, $7::uuid, 'passwords:read',
             now() + interval '7 days', now()
           )`,
          mcpRefreshTokenId,
          refreshTokenHash,
          familyId,
          mcpAccessTokenId,
          mcpClientId,
          tenantId,
          userId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO delegation_sessions (
             id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, created_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             ARRAY[]::text[], now() + interval '1 hour', now()
           )`,
          delegationSessionId,
          tenantId,
          userId,
          mcpAccessTokenId,
        );
      });
      return { mcpClientId, mcpAccessTokenId, mcpRefreshTokenId, delegationSessionId };
    }

    it(
      "invalidateUserSessions(allTenants: true) deletes sessions across all tenants and revokes tokens (incl. MCP + delegation)",
      async () => {
        // Setup: 2 sessions in T1, 1 in T2; ext token in T1; api key in T2;
        // MCP stack (client + access token + refresh token + delegation
        // session) in T1; another delegation+access in T2 to verify
        // cross-tenant coverage of MCP artifacts.
        const sessA1 = await insertSession(tenantA);
        const sessA2 = await insertSession(tenantA);
        const sessB1 = await insertSession(tenantB);
        const extTokenId = await insertExtensionToken(tenantA);
        const apiKeyId = await insertApiKey(tenantB);
        const mcpA = await insertMcpStack(tenantA);
        const mcpB = await insertMcpStack(tenantB);

        // Sanity check pre-state.
        const sessionsBefore = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.session.findMany({
            where: { userId },
            select: { sessionToken: true, tenantId: true },
          });
        });
        expect(sessionsBefore.length).toBe(3);

        // Act.
        const result = await invalidateUserSessions(userId, {
          allTenants: true,
          reason: "admin_vault_reset",
        });

        // Helper return shape (T5) — includes MCP + delegation counts plus
        // cacheTombstoneFailures (0 here because Redis is healthy).
        expect(result.sessions).toBe(3);
        expect(result.extensionTokens).toBe(1);
        expect(result.apiKeys).toBe(1);
        expect(result.mcpAccessTokens).toBe(2);
        expect(result.mcpRefreshTokens).toBe(2);
        expect(result.delegationSessions).toBe(2);
        expect(result.cacheTombstoneFailures).toBe(0);

        // All 3 Session rows deleted.
        const sessionsAfter = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.session.findMany({ where: { userId } });
        });
        expect(sessionsAfter.length).toBe(0);

        // ExtensionToken in T1 — revokedAt set.
        const ext = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.extensionToken.findUniqueOrThrow({
            where: { id: extTokenId },
            select: { revokedAt: true, tenantId: true },
          });
        });
        expect(ext.revokedAt).not.toBeNull();
        expect(ext.tenantId).toBe(tenantA);

        // ApiKey in T2 — revokedAt set.
        const ak = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.apiKey.findUniqueOrThrow({
            where: { id: apiKeyId },
            select: { revokedAt: true, tenantId: true },
          });
        });
        expect(ak.revokedAt).not.toBeNull();
        expect(ak.tenantId).toBe(tenantB);

        // MCP access/refresh tokens + delegation sessions revoked in BOTH
        // tenants (allTenants: true must cover MCP artifacts too — the
        // user-facing risk that motivated this PR's round-2 review).
        for (const m of [mcpA, mcpB]) {
          const accessRow = await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            return tx.mcpAccessToken.findUniqueOrThrow({
              where: { id: m.mcpAccessTokenId },
              select: { revokedAt: true },
            });
          });
          expect(accessRow.revokedAt).not.toBeNull();

          const refreshRow = await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            return tx.mcpRefreshToken.findUniqueOrThrow({
              where: { id: m.mcpRefreshTokenId },
              select: { revokedAt: true },
            });
          });
          expect(refreshRow.revokedAt).not.toBeNull();

          const delegationRow = await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            return tx.delegationSession.findUniqueOrThrow({
              where: { id: m.delegationSessionId },
              select: { revokedAt: true },
            });
          });
          expect(delegationRow.revokedAt).not.toBeNull();
        }

        // Cache tombstones present for all 3 session tokens.
        for (const token of [sessA1, sessA2, sessB1]) {
          const raw = await redis.get(tombstoneKey(token));
          expect(raw).not.toBeNull();
          const parsed = JSON.parse(raw as string);
          expect(parsed).toEqual({ tombstone: true });
        }
      },
    );
  },
);
