/**
 * Integration test (real DB): the batch revocation a departure runs in its own
 * transaction (docs/archive/review/session-revocation-failure-surfaces-plan.md
 * T3, T6; AC5).
 *
 * - T3: a departure through the production path, under the tenant context on
 *   passwd_app, revokes a row of each of the ten models.
 * - T6: the batch path takes the same credential lock a mint takes; a
 *   departure waits for it a bounded time and refuses with 409 past that; and
 *   it takes the lock last, so a team removal parked between its row writes
 *   and its revocation does not deadlock with a directory sync departing the
 *   same user.
 *
 * Races are parked on locks a test transaction holds and witnessed through
 * pg_blocking_pids / pg_locks (race-helpers.ts), never by sleeping.
 *
 * Run: npm run test:integration -- session-revocation-lock-order
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createTestContext, Deferred, setBypassRlsGucs, type TestContext } from "./helpers";
import { BLOCK_WAIT_MS, createRaceHelpers } from "./race-helpers";
import { TEAM_KEY_LOCK_TIMEOUT_MS, TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

const { scimTenant, mockFetchOktaUsers } = vi.hoisted(() => ({
  scimTenant: { id: "" },
  mockFetchOktaUsers: vi.fn(),
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));
vi.mock("@/lib/scim/with-scim-auth", async () => {
  const { SYSTEM_ACTOR_ID } = await import("@/lib/constants/app");
  const { ACTOR_TYPE } = await import("@/lib/constants/audit/audit");
  return {
    authorizeScim: async () => ({
      ok: true,
      data: {
        tokenId: "token-under-test",
        tenantId: scimTenant.id,
        createdById: null,
        auditUserId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
      },
    }),
  };
});
vi.mock("@/lib/directory-sync/okta", () => ({ fetchOktaUsers: mockFetchOktaUsers }));
vi.mock("@/lib/directory-sync/credentials", () => ({
  decryptCredentials: () => JSON.stringify({ orgUrl: "https://example.okta.com", apiToken: "token" }),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchTenantWebhook: vi.fn() }));

import { PATCH as scimPatchUser } from "@/app/api/scim/v2/Users/[id]/route";
import { DELETE as removeMember } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { runDirectorySync } from "@/lib/directory-sync/engine";
import { departFromTenant } from "@/lib/team/team-departure";
import { revokeUsersAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import {
  isSessionRowLive,
  UserAuthRevokedError,
  userAuthLockKey,
} from "@/lib/auth/session/user-auth-serialization";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_ACTION } from "@/lib/constants/audit/audit";

const hex = (n: number) => randomBytes(n).toString("hex");

function oktaUser(id: string, email: string, displayName: string, active: boolean) {
  return { id, profile: { email, displayName, firstName: "First", lastName: "Last" }, status: active ? "ACTIVE" : "SUSPENDED" };
}

describe("departure revocation: models, lock identity, bounded wait, lock order — real-DB integration", () => {
  let ctx: TestContext;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    race = createRaceHelpers(ctx.su.pool);
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    scimTenant.id = tenantId;
    vi.clearAllMocks();
    mockFetchOktaUsers.mockReset();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
    vi.unstubAllEnvs();
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A mapped, SCIM-managed tenant MEMBER (createUser makes OWNERs, whom a departure never touches). */
  async function mapped(): Promise<{ id: string; email: string; ext: string }> {
    const id = await ctx.createUser(tenantId);
    await sql(`UPDATE tenant_members SET role = 'MEMBER', scim_managed = true WHERE user_id = $1::uuid`, id);
    const ext = `ext-${id.slice(0, 8)}`;
    await sql(
      `INSERT INTO scim_external_mappings (id, tenant_id, external_id, resource_type, internal_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'User', $4, now(), now())`,
      randomUUID(), tenantId, ext, id,
    );
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email, ext };
  }

  async function session(userId: string, tenant = tenantId): Promise<{ id: string; raw: string }> {
    const id = randomUUID();
    const raw = randomUUID();
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      id, hashSessionToken(raw), userId, tenant,
    );
    return { id, raw };
  }

  async function sessionExists(id: string): Promise<boolean> {
    return (await sql(`SELECT 1 FROM sessions WHERE id = $1::uuid`, id)).length > 0;
  }

  async function tenantStamp(userId: string): Promise<Date | null> {
    const [row] = await sql<{ deactivated_at: Date | null }>(
      `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenantId, userId,
    );
    return row.deactivated_at;
  }

  async function outboxActions(): Promise<string[]> {
    const rows = await sql<{ action: string }>(
      `SELECT payload->>'action' AS action FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at`,
      tenantId,
    );
    return rows.map((row) => row.action);
  }

  function scimPatch(userId: string, active: boolean) {
    return scimPatchUser(
      new NextRequest(`http://localhost/api/scim/v2/Users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: active }],
        }),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  // ── T3: all ten models under the tenant context (AC5) ───────

  describe("T3: departFromTenant under withTenantRls on passwd_app", () => {
    const hex64 = () => hex(32);

    /** One row of each of the ten models for `userId` in `tenant`; returns their ids. */
    async function seedTenModels(userId: string, creatorId: string, tenant: string) {
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
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
          ids.session, hashSessionToken(`sess-${randomUUID()}`), userId, tenant,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, family_created_at, created_at, cnf_jkt)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension:read', now() + interval '1 day', $5::uuid, now(), now(), $6)`,
          ids.extensionToken, userId, tenant, hex64(), randomUUID(), "a".repeat(43),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_test', $5, 'passwords:read', now() + interval '1 day', now())`,
          ids.apiKey, userId, tenant, hex64(), `key-${ids.apiKey.slice(0, 8)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, ARRAY['http://localhost/cb']::text[], 'passwords:read', true, $6::uuid, now(), now())`,
          ids.mcpClient, tenant, `cli-${ids.mcpClient.slice(0, 16)}`, hex64(), `client-${ids.mcpClient.slice(0, 8)}`, creatorId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'passwords:read', now() + interval '1 day', now())`,
          ids.mcpAccessToken, hex64(), ids.mcpClient, tenant, userId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, scope, expires_at, created_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'passwords:read', now() + interval '7 days', now())`,
          ids.mcpRefreshToken, hex64(), randomUUID(), ids.mcpAccessToken, ids.mcpClient, tenant, userId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, ARRAY[]::text[], now() + interval '1 hour', now())`,
          ids.delegationSession, tenant, userId, ids.mcpAccessToken,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'http://localhost/cb', 'passwords:read', $6, 'S256', now() + interval '10 minutes', now())`,
          ids.mcpAuthorizationCode, hex64(), ids.mcpClient, tenant, userId, "c".repeat(43),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO extension_bridge_codes (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'extension:read', now() + interval '1 minute', now(), $5)`,
          ids.extensionBridgeCode, hex64(), userId, tenant, "a".repeat(43),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO mobile_bridge_codes (id, code_hash, user_id, tenant_id, state, code_challenge, device_jkt, expires_at, created_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '1 minute', now())`,
          ids.mobileBridgeCode, hex64(), userId, tenant, "s".repeat(32), "c".repeat(43), "d".repeat(43),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO operator_tokens (id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id, scope, expires_at, created_at)
           VALUES ($1::uuid, $2, 'op_test1', $3, $4::uuid, $5::uuid, $6::uuid, 'maintenance', now() + interval '1 day', now())`,
          ids.operatorToken, hex64(), `op-${ids.operatorToken.slice(0, 8)}`, tenant, userId, creatorId,
        );
      });
      return ids;
    }

    /** Whether each of the ten rows still authenticates (the session: still exists). */
    async function liveness(ids: Awaited<ReturnType<typeof seedTenModels>>): Promise<Record<string, boolean>> {
      const read = async (table: string, column: string, id: string) => {
        const rows = await sql<{ v: unknown }>(`SELECT ${column} AS v FROM ${table} WHERE id = $1::uuid`, id);
        return rows.length === 1 && rows[0].v === null;
      };
      return {
        sessions: (await sql(`SELECT 1 FROM sessions WHERE id = $1::uuid`, ids.session)).length === 1,
        extensionTokens: await read("extension_tokens", "revoked_at", ids.extensionToken),
        apiKeys: await read("api_keys", "revoked_at", ids.apiKey),
        mcpAccessTokens: await read("mcp_access_tokens", "revoked_at", ids.mcpAccessToken),
        mcpRefreshTokens: await read("mcp_refresh_tokens", "revoked_at", ids.mcpRefreshToken),
        delegationSessions: await read("delegation_sessions", "revoked_at", ids.delegationSession),
        operatorTokens: await read("operator_tokens", "revoked_at", ids.operatorToken),
        extensionBridgeCodes: await read("extension_bridge_codes", "used_at", ids.extensionBridgeCode),
        mobileBridgeCodes: await read("mobile_bridge_codes", "used_at", ids.mobileBridgeCode),
        mcpAuthorizationCodes: await read("mcp_authorization_codes", "used_at", ids.mcpAuthorizationCode),
      };
    }

    const allTen = (value: boolean) => ({
      sessions: value,
      extensionTokens: value,
      apiKeys: value,
      mcpAccessTokens: value,
      mcpRefreshTokens: value,
      delegationSessions: value,
      operatorTokens: value,
      extensionBridgeCodes: value,
      mobileBridgeCodes: value,
      mcpAuthorizationCodes: value,
    });

    afterEach(async () => {
      // delegation_sessions FKs mcp_access_tokens; deleteTestData's own order covers
      // the rest once these are gone.
      await sql(`DELETE FROM delegation_sessions WHERE tenant_id = ANY($1::uuid[])`, [tenantId, otherTenantId]);
    });

    it("revokes a row of each of the ten models, with counts of 1 each", async () => {
      const user = await mapped();
      const creator = await ctx.createUser(tenantId);
      const ids = await seedTenModels(user.id, creator, tenantId);
      expect(await liveness(ids)).toEqual(allTen(true));

      const departed = await withTenantRls(prisma, tenantId, (tx) =>
        departFromTenant(tx, tenantId, [user.id], { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } }),
      );

      expect(departed.userIds).toEqual([user.id]);
      expect(departed.revocation.counts).toEqual({
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
      expect(departed.revocation.sessionTokens).toHaveLength(1);
      expect(await liveness(ids)).toEqual(allTen(false));
    });

    it("leaves the user's rows in another tenant alone (pins the RLS scope; tenantFilter itself is pinned by the T4 unit cells)", async () => {
      const user = await mapped();
      const creator = await ctx.createUser(tenantId);
      const otherCreator = await ctx.createUser(otherTenantId);
      const here = await seedTenModels(user.id, creator, tenantId);
      const elsewhere = await seedTenModels(user.id, otherCreator, otherTenantId);

      await withTenantRls(prisma, tenantId, (tx) =>
        departFromTenant(tx, tenantId, [user.id], { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } }),
      );

      expect(await liveness(here)).toEqual(allTen(false));
      expect(await liveness(elsewhere)).toEqual(allTen(true));
    });
  });

  // ── T6: lock identity ────────────────────────────────────────

  describe("T6: the batch revocation takes the lock a mint takes", () => {
    async function mcpClient(creator: string): Promise<string> {
      const id = randomUUID();
      await sql(
        `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, '', $4, ARRAY['http://localhost/cb']::text[], 'credentials:list', true, $5::uuid, now(), now())`,
        id, tenantId, `cli-${id.slice(0, 16)}`, `test-mcp-client-${id.slice(0, 8)}`, creator,
      );
      return id;
    }

    async function authorizationCodeCount(userId: string): Promise<number> {
      const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_authorization_codes WHERE user_id = $1::uuid`, userId);
      return n;
    }

    /**
     * Wait until `work` settles or a backend waits on `heldPid`, and say which.
     * A mint that does not take the revocation's lock runs through.
     */
    async function parkedOrSettled(work: Promise<unknown>, heldPid: number): Promise<"parked" | "settled"> {
      let settled = false;
      void work.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + BLOCK_WAIT_MS;
      while (Date.now() < deadline) {
        if (settled) return "settled";
        if ((await race.backendsBlockedBy(heldPid)).length > 0) return "parked";
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error(`the mint neither settled nor parked on pid ${heldPid} within ${BLOCK_WAIT_MS}ms`);
    }

    it("a consent for one of two users parks behind a batch revocation that took no lock first, and creates no code", async () => {
      const userId = await ctx.createUser(tenantId);
      const other = await ctx.createUser(tenantId);
      const clientId = await mcpClient(userId);
      const consenting = await session(userId);
      const req = new NextRequest("http://localhost/api/mcp/authorize/consent", {
        method: "POST",
        headers: { cookie: `${configuredSessionCookieName()}=${consenting.raw}` },
      });

      // The revocation, held open uncommitted. No lockUserAuthArtifacts first:
      // the batch path's own lock is the subject.
      const entered = new Deferred<number>();
      const release = new Deferred();
      const held = ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await setBypassRlsGucs(tx);
        await revokeUsersAuthArtifactsInTx(tx, [other, userId], { tenantFilter: {} });
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        entered.resolve(pid);
        await release.promise;
      }, { timeout: 30_000 });
      held.catch((e: unknown) => entered.reject(e));
      const heldPid = await entered.promise;

      const minting = createAuthorizationCode({
        clientId,
        tenantId,
        userId,
        redirectUri: "http://localhost/cb",
        scope: "credentials:list",
        codeChallenge: "A".repeat(43),
        userProof: (tx) => isSessionRowLive(tx, req, userId),
      });
      minting.catch(() => {});
      let outcome: "parked" | "settled";
      let waitingIn: string | undefined;
      try {
        outcome = await parkedOrSettled(minting, heldPid);
        if (outcome === "parked") {
          const [parked] = await race.backendsBlockedBy(heldPid);
          waitingIn = await race.waitingQueryOf(parked);
        }
      } finally {
        release.resolve();
        await held;
      }

      expect(outcome).toBe("parked");
      expect(waitingIn).toContain("pg_advisory_xact_lock");
      await expect(minting).rejects.toBeInstanceOf(UserAuthRevokedError);
      expect(await authorizationCodeCount(userId)).toBe(0);
    });
  });

  // ── T6: bounded wait ─────────────────────────────────────────

  describe("T6: a departure waits for the credential lock a bounded time", () => {
    const holdUserAuth = (userId: string) =>
      race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userAuthLockKey(userId)]);

    it("held past the budget: the SCIM PATCH answers 409 with the sign-in reason, inside the transaction deadline, changing nothing", async () => {
      const user = await mapped();
      const live = await session(user.id);
      const holder = await holdUserAuth(user.id);
      let res: Response;
      let elapsed: number;
      try {
        const started = Date.now();
        res = await scimPatch(user.id, false);
        elapsed = Date.now() - started;
      } finally {
        await holder.release();
      }

      expect(res.status).toBe(409);
      expect((await res.json()).detail).toBe("The user's sign-in state is being changed; retry later");
      expect(elapsed).toBeGreaterThanOrEqual(TEAM_KEY_LOCK_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(TEAM_MEMBERSHIP_TX_TIMEOUT_MS);
      expect(await tenantStamp(user.id)).toBeNull();
      expect(await sessionExists(live.id)).toBe(true);
      expect(await outboxActions()).toEqual([]);
    });

    it("released within the budget: the same PATCH waits, then deactivates and revokes", async () => {
      const user = await mapped();
      const live = await session(user.id);
      const holder = await holdUserAuth(user.id);
      let pending: Promise<Response> | undefined;
      try {
        pending = scimPatch(user.id, false);
        pending.catch(() => {});
        const parked = await race.waitForBackendBlockedBy(holder.pid);
        expect(await race.waitingQueryOf(parked)).toContain("pg_advisory_xact_lock");
      } finally {
        await holder.release();
      }

      expect((await pending).status).toBe(200);
      expect(await tenantStamp(user.id)).toBeInstanceOf(Date);
      expect(await sessionExists(live.id)).toBe(false);
      expect((await outboxActions()).filter((action) => action === AUDIT_ACTION.SCIM_USER_DEACTIVATE)).toHaveLength(1);
    });
  });

  // ── T6: lock order ───────────────────────────────────────────

  describe("T6: a departure takes the credential lock after its row writes", () => {
    let configId: string;

    beforeEach(async () => {
      configId = randomUUID();
      await sql(
        `INSERT INTO directory_sync_configs
           (id, tenant_id, provider, display_name, enabled, sync_interval_minutes,
            encrypted_credentials, credentials_iv, credentials_auth_tag, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'OKTA'::"DirectorySyncProvider", 'test-config', true, 60,
            'cipher', 'iv', 'tag', 'IDLE'::"DirectorySyncStatus", now(), now())`,
        configId, tenantId,
      );
    });

    async function team(owner: string): Promise<string> {
      const id = randomUUID();
      await sql(
        `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
        id, tenantId, `team-${id.slice(0, 8)}`,
      );
      await sql(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER', true, now(), now())`,
        randomUUID(), id, owner, tenantId,
      );
      return id;
    }

    async function addMemberWithKey(teamId: string, userId: string): Promise<string> {
      const rowId = randomUUID();
      await sql(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MEMBER', true, now(), now())`,
        rowId, teamId, userId, tenantId,
      );
      await sql(
        `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
           team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, now(), now())`,
        randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32),
      );
      return rowId;
    }

    /** How many `user-auth:<userId>` advisory locks backend `pid` holds (pg_locks splits the int8 key). */
    async function userAuthLocksHeldBy(pid: number, userId: string): Promise<number> {
      const [{ n }] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE pid = $1 AND locktype = 'advisory' AND granted AND objsubid = 1
            AND classid = ((hashtext($2)::bigint >> 32) & 4294967295)::oid
            AND objid = (hashtext($2)::bigint & 4294967295)::oid`,
        pid, userAuthLockKey(userId),
      );
      return n;
    }

    // Fixed names: check-bypass-rls allowlists exactly this routine in this file.
    const PARK_FN = "t6_lock_order_park";
    const PARK_TRIGGER = `${PARK_FN}_trg`;

    it("a sync departing a user whose team removal is parked before its revocation waits on it, holds no credential lock, and both commit", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await mapped();
      const teamId = await team(owner);
      const rowId = await addMemberWithKey(teamId, user.id);
      const live = await session(user.id);
      mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", false)]);
      const parkKey = `t6-park:${user.id}`;

      // Positive control for the pg_locks witness: it sees the lock when held.
      const control = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [userAuthLockKey(user.id)]);
      try {
        expect(await userAuthLocksHeldBy(control.pid, user.id)).toBe(1);
      } finally {
        await control.release();
      }

      const park = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [parkKey]);
      let removing: Promise<Response> | undefined;
      let syncing: ReturnType<typeof runDirectorySync> | undefined;
      let syncHeldUserAuth: number | undefined;
      try {
        await sql(`DROP FUNCTION IF EXISTS public.${PARK_FN}() CASCADE`);
        await sql(
          `CREATE FUNCTION t6_lock_order_park() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]));
             RETURN OLD;
           END $$`,
        );
        await sql(
          `CREATE TRIGGER ${PARK_TRIGGER} BEFORE DELETE ON team_member_keys FOR EACH ROW
             WHEN (OLD.user_id = '${user.id}'::uuid) EXECUTE FUNCTION public.${PARK_FN}('${parkKey}')`,
        );

        // The removal deletes the member row, reaches the key delete and parks
        // there: past its row writes, before its revocation, holding no
        // credential lock.
        mockAuth.mockResolvedValue({ user: { id: owner } });
        removing = removeMember(new NextRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, { method: "DELETE" }), {
          params: Promise.resolve({ teamId, memberId: rowId }),
        });
        removing.catch(() => {});
        const removalPid = await race.waitForBackendBlockedBy(park.pid);
        expect(await userAuthLocksHeldBy(removalPid, user.id)).toBe(0);

        // The sync departs the same user and waits on the removal's member row.
        syncing = runDirectorySync({ configId, tenantId, force: true });
        syncing.catch(() => {});
        const syncPid = await race.waitForBackendBlockedBy(removalPid);
        syncHeldUserAuth = await userAuthLocksHeldBy(syncPid, user.id);
      } finally {
        await park.release();
        await Promise.allSettled([removing, syncing]);
        await sql(`DROP TRIGGER IF EXISTS ${PARK_TRIGGER} ON team_member_keys`);
        await sql(`DROP FUNCTION IF EXISTS public.${PARK_FN}() CASCADE`);
      }

      // Outcome first: a credential lock taken before the row writes turns this
      // into a deadlock (40P01), refused on one side.
      const removed = await removing;
      const synced = await syncing;
      expect({ removal: removed.status, sync: synced.success, syncError: synced.errorMessage }).toEqual({
        removal: 200,
        sync: true,
        syncError: undefined,
      });
      expect(syncHeldUserAuth).toBe(0);
      expect(await tenantStamp(user.id)).toBeInstanceOf(Date);
      expect(await sessionExists(live.id)).toBe(false);
      const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM team_members WHERE id = $1::uuid`, rowId);
      expect(n).toBe(0);
    });
  });
});
