/**
 * invalidateUserSessions as passwd_app, with a row in EACH of the ten models of
 * BYPASS_GRANT.USER_SESSION_INVALIDATION. The enforcing bypass refuses a
 * statement that examines a row of a table outside the grant, so the call can
 * only resolve, and revoke every row, if the grant names every model the
 * function reaches — and a seeded row in each is what makes it examine them
 * (a policy is only consulted for a row that is there).
 *
 * The seeded rows belong to the target user in the tenant the call names.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { assertRlsApplies, createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);

describe("invalidateUserSessions covers every model of its grant (as passwd_app)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let creatorId: string;
  const ids = {
    session: randomUUID(),
    extensionToken: randomUUID(),
    apiKey: randomUUID(),
    mcpClient: randomUUID(),
    mcpAccessToken: randomUUID(),
    mcpRefreshToken: randomUUID(),
    delegationSession: randomUUID(),
    mcpAuthorizationCode: randomUUID(),
    extensionBridgeCode: randomUUID(),
    mobileBridgeCode: randomUUID(),
    operatorToken: randomUUID(),
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    creatorId = await ctx.createUser(tenantId);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
        ids.session, hashSessionToken(`sess-${randomUUID()}`), userId, tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, family_created_at, created_at, cnf_jkt)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension:read', now() + interval '1 day', $5::uuid, now(), now(), $6)`,
        ids.extensionToken, userId, tenantId, hex64(), randomUUID(), "a".repeat(43),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_test', $5, 'passwords:read', now() + interval '1 day', now())`,
        ids.apiKey, userId, tenantId, hex64(), `key-${ids.apiKey.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, ARRAY['http://localhost/cb']::text[], 'passwords:read', true, $6::uuid, now(), now())`,
        ids.mcpClient, tenantId, `cli-${ids.mcpClient.slice(0, 16)}`, hex64(), `client-${ids.mcpClient.slice(0, 8)}`, userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'passwords:read', now() + interval '1 day', now())`,
        ids.mcpAccessToken, hex64(), ids.mcpClient, tenantId, userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, scope, expires_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'passwords:read', now() + interval '7 days', now())`,
        ids.mcpRefreshToken, hex64(), randomUUID(), ids.mcpAccessToken, ids.mcpClient, tenantId, userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, ARRAY[]::text[], now() + interval '1 hour', now())`,
        ids.delegationSession, tenantId, userId, ids.mcpAccessToken,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'http://localhost/cb', 'passwords:read', $6, 'S256', now() + interval '10 minutes', now())`,
        ids.mcpAuthorizationCode, hex64(), ids.mcpClient, tenantId, userId, "c".repeat(43),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_bridge_codes (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'extension:read', now() + interval '1 minute', now(), $5)`,
        ids.extensionBridgeCode, hex64(), userId, tenantId, "a".repeat(43),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mobile_bridge_codes (id, code_hash, user_id, tenant_id, state, code_challenge, device_jkt, expires_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '1 minute', now())`,
        ids.mobileBridgeCode, hex64(), userId, tenantId, "s".repeat(32), "c".repeat(43), "d".repeat(43),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO operator_tokens (id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id, scope, expires_at, created_at)
         VALUES ($1::uuid, $2, 'op_test1', $3, $4::uuid, $5::uuid, $6::uuid, 'maintenance', now() + interval '1 day', now())`,
        ids.operatorToken, hex64(), `op-${ids.operatorToken.slice(0, 8)}`, tenantId, userId, creatorId,
      );
    });
  });

  afterEach(async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      for (const table of ["delegation_sessions", "mcp_refresh_tokens", "mcp_authorization_codes", "mcp_access_tokens"]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM mcp_clients WHERE tenant_id = $1::uuid`, tenantId);
    });
    await ctx.deleteTestData(tenantId);
  });

  /** One row's column read back through the superuser, after the call. */
  async function readBack(table: string, column: string, id: string): Promise<unknown> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${column} AS v FROM ${table} WHERE id = $1::uuid`, id);
    });
    return rows.length === 0 ? "absent" : rows[0].v;
  }

  it("resolves, and revokes or deletes the seeded row of each of the ten models", async () => {
    // Control: every row is live before the call, so a "revoked" below is the call's doing.
    expect(await readBack("sessions", "id", ids.session)).toBe(ids.session);
    for (const [table, id] of [
      ["extension_tokens", ids.extensionToken],
      ["api_keys", ids.apiKey],
      ["mcp_access_tokens", ids.mcpAccessToken],
      ["mcp_refresh_tokens", ids.mcpRefreshToken],
      ["delegation_sessions", ids.delegationSession],
      ["operator_tokens", ids.operatorToken],
    ] as const) {
      expect(await readBack(table, "revoked_at", id), table).toBeNull();
    }
    for (const [table, id] of [
      ["extension_bridge_codes", ids.extensionBridgeCode],
      ["mobile_bridge_codes", ids.mobileBridgeCode],
      ["mcp_authorization_codes", ids.mcpAuthorizationCode],
    ] as const) {
      expect(await readBack(table, "used_at", id), table).toBeNull();
    }

    const result = await invalidateUserSessions(userId, { tenantId, reason: "rds-shaped-grant-cell" });

    expect(result).toMatchObject({
      sessions: 1,
      extensionTokens: 1,
      apiKeys: 1,
      mcpAccessTokens: 1,
      mcpRefreshTokens: 1,
      delegationSessions: 1,
      operatorTokens: 1,
      extensionBridgeCodes: 1,
      mobileBridgeCodes: 1,
      mcpAuthorizationCodes: 1,
    });

    expect(await readBack("sessions", "id", ids.session)).toBe("absent");
    for (const [table, id] of [
      ["extension_tokens", ids.extensionToken],
      ["api_keys", ids.apiKey],
      ["mcp_access_tokens", ids.mcpAccessToken],
      ["mcp_refresh_tokens", ids.mcpRefreshToken],
      ["delegation_sessions", ids.delegationSession],
      ["operator_tokens", ids.operatorToken],
    ] as const) {
      expect(await readBack(table, "revoked_at", id), table).not.toBeNull();
    }
    for (const [table, id] of [
      ["extension_bridge_codes", ids.extensionBridgeCode],
      ["mobile_bridge_codes", ids.mobileBridgeCode],
      ["mcp_authorization_codes", ids.mcpAuthorizationCode],
    ] as const) {
      expect(await readBack(table, "used_at", id), table).not.toBeNull();
    }
  });
});
