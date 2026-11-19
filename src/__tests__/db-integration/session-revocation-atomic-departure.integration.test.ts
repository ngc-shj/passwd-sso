/**
 * Integration test (real DB): a departure, a member removal and an admin vault
 * reset revoke the user's sessions and tokens atomically with the change, so a
 * failed revocation leaves nothing committed and a retry starts over
 * (docs/archive/review/session-revocation-failure-surfaces-plan.md T1, T2, T7,
 * T8; AC1–AC4, AC6, AC7).
 *
 * The revocation is made to fail by a test-only BEFORE UPDATE trigger on
 * mcp_authorization_codes, the last table the revocation writes. It raises
 * T1_REVOCATION_FAULT only once the seeded session is gone, so the raise
 * itself proves the session delete ran in the same transaction. Production
 * routes, services and the directory-sync engine run under their real RLS
 * contexts on passwd_app; only the auth, step-up, rate-limit, SCIM-token and
 * IdP boundaries are mocked.
 *
 * Run: npm run test:integration -- session-revocation-atomic-departure
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createTestContext, recipientKey, setBypassRlsGucs, type TestContext } from "./helpers";

const { scimTenant, mockFetchOktaUsers } = vi.hoisted(() => ({
  scimTenant: { id: "" },
  mockFetchOktaUsers: vi.fn(),
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
// Every limiter passes, admin-reset's fail-closed one included (T7).
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

import { POST as scimPostUser } from "@/app/api/scim/v2/Users/route";
import {
  PATCH as scimPatchUser,
  PUT as scimPutUser,
  DELETE as scimDeleteUser,
} from "@/app/api/scim/v2/Users/[id]/route";
import { DELETE as removeMember } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { POST as adminReset } from "@/app/api/vault/admin-reset/route";
import { runDirectorySync } from "@/lib/directory-sync/engine";
import { patchScimUser } from "@/lib/services/scim-user-service";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

const hex = (n: number) => randomBytes(n).toString("hex");
const FAULT = "T1_REVOCATION_FAULT";

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function oktaUser(id: string, email: string, displayName: string, active: boolean) {
  return { id, profile: { email, displayName, firstName: "First", lastName: "Last" }, status: active ? "ACTIVE" : "SUSPENDED" };
}

type Artifacts = {
  sessionId: string;
  extensionTokenId: string;
  mcpAccessTokenId: string;
  mcpAuthorizationCodeId: string;
};

describe("session revocation is atomic with the departure — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    // SCIM responses and admin-reset build on the app origin; CI sets none.
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    tenantId = await ctx.createTenant();
    scimTenant.id = tenantId;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // admin_vault_resets FKs the tenant with RESTRICT.
    await sql(`DELETE FROM admin_vault_resets WHERE tenant_id = $1::uuid`, tenantId);
    await ctx.deleteTestData(tenantId);
    vi.unstubAllEnvs();
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  // ── Seeding ──────────────────────────────────────────────────

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

  /** A user this tenant owns with no membership row (a guest of its teams, say). */
  async function ownedWithoutRow(): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenantId);
    await sql(`DELETE FROM tenant_members WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  async function team(owner: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, tenantId, `team-${id.slice(0, 8)}`,
    );
    await addTeamMember(id, owner, "OWNER");
    return id;
  }

  /** A team membership with its key; returns the team_members row id. */
  async function addTeamMember(teamId: string, userId: string, role: string): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
      rowId, teamId, userId, tenantId, role,
    );
    const { fingerprint } = await recipientKey(ctx.su, userId);
    await sql(
      `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, recipient_key_fingerprint, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, $10, now(), now())`,
      randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), fingerprint,
    );
    return rowId;
  }

  /** A pending invitation `inviter` issued (a departure expires it). */
  async function invitationFrom(teamId: string, inviter: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token_hash, expires_at, invited_by_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', 'PENDING', $5, now() + interval '1 day', $6::uuid, now())`,
      id, teamId, tenantId, `invitee-${id.slice(0, 8)}@example.com`, hex(32), inviter,
    );
    return id;
  }

  /**
   * A session, an extension token, an MCP access token and an MCP
   * authorization code (with its client) for `userId` in this tenant. The
   * session is in the departure's tenant, so RLS cannot hide it from the
   * fault trigger's check.
   */
  async function seedArtifacts(userId: string, clientCreator: string): Promise<Artifacts> {
    const ids: Artifacts & { mcpClientId: string } = {
      sessionId: randomUUID(),
      extensionTokenId: randomUUID(),
      mcpClientId: randomUUID(),
      mcpAccessTokenId: randomUUID(),
      mcpAuthorizationCodeId: randomUUID(),
    };
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      ids.sessionId, hashSessionToken(`sess-${randomUUID()}`), userId, tenantId,
    );
    await sql(
      `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, family_created_at, created_at, cnf_jkt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension:read', now() + interval '1 day', $5::uuid, now(), now(), $6)`,
      ids.extensionTokenId, userId, tenantId, hex(32), randomUUID(), "a".repeat(43),
    );
    await sql(
      `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, ARRAY['http://localhost/cb']::text[], 'passwords:read', true, $6::uuid, now(), now())`,
      ids.mcpClientId, tenantId, `cli-${ids.mcpClientId.slice(0, 16)}`, hex(32), `client-${ids.mcpClientId.slice(0, 8)}`, clientCreator,
    );
    await sql(
      `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'passwords:read', now() + interval '1 day', now())`,
      ids.mcpAccessTokenId, hex(32), ids.mcpClientId, tenantId, userId,
    );
    await sql(
      `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'http://localhost/cb', 'passwords:read', $6, 'S256', now() + interval '10 minutes', now())`,
      ids.mcpAuthorizationCodeId, hex(32), ids.mcpClientId, tenantId, userId, "c".repeat(43),
    );
    return ids;
  }

  // ── The fault ────────────────────────────────────────────────

  // Fixed names: check-bypass-rls allowlists exactly this routine in this file.
  const FAULT_FN = "t1_revocation_fault";
  const FAULT_TRIGGER = `${FAULT_FN}_trg`;

  async function dropFault(): Promise<void> {
    await sql(`DROP TRIGGER IF EXISTS ${FAULT_TRIGGER} ON mcp_authorization_codes`);
    await sql(`DROP FUNCTION IF EXISTS public.${FAULT_FN}() CASCADE`);
  }

  /**
   * Arm the fault for `userId`, whose seeded session is `sessionId`, and prove
   * its predicate is false while that session exists: an update of the code
   * fires the trigger and passes.
   */
  async function armFault(userId: string, artifacts: Artifacts): Promise<void> {
    await sql(`DROP FUNCTION IF EXISTS public.${FAULT_FN}() CASCADE`);
    await sql(
      `CREATE FUNCTION t1_revocation_fault() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM sessions WHERE id = TG_ARGV[0]::uuid) THEN
           RAISE EXCEPTION '${FAULT}';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await sql(
      `CREATE TRIGGER ${FAULT_TRIGGER} BEFORE UPDATE ON mcp_authorization_codes FOR EACH ROW
         WHEN (OLD.user_id = '${userId}'::uuid) EXECUTE FUNCTION public.${FAULT_FN}('${artifacts.sessionId}')`,
    );
    await sql(`UPDATE mcp_authorization_codes SET scope = scope WHERE id = $1::uuid`, artifacts.mcpAuthorizationCodeId);
  }

  /** Run `fn` with the fault armed; it is dropped however `fn` ends. */
  async function withFault<T>(userId: string, artifacts: Artifacts, fn: () => Promise<T>): Promise<T> {
    try {
      await armFault(userId, artifacts);
      return await fn();
    } finally {
      await dropFault();
    }
  }

  // ── Observation ──────────────────────────────────────────────

  /**
   * Every row a departure, a removal or a revocation of `userId` in this
   * tenant could change, as full rows. A key is a table; the predicate column
   * names the user.
   */
  async function snapshot(userId: string): Promise<Record<string, string[]>> {
    const subjects: [string, string][] = [
      ["tenant_members", "user_id"],
      ["team_members", "user_id"],
      ["team_member_keys", "user_id"],
      ["team_invitations", "invited_by_id"],
      ["scim_external_mappings", "internal_id"],
      ["tenant_member_departures", "user_id"],
      ["sessions", "user_id"],
      ["extension_tokens", "user_id"],
      ["mcp_access_tokens", "user_id"],
      ["mcp_authorization_codes", "user_id"],
    ];
    const out: Record<string, string[]> = {};
    for (const [table, column] of subjects) {
      const rows = await sql<{ r: string }>(
        `SELECT row_to_json(t)::text AS r FROM ${table} t WHERE t.tenant_id = $1::uuid AND t.${column}::text = $2 ORDER BY 1`,
        tenantId, userId,
      );
      out[table] = rows.map((row) => row.r);
    }
    return out;
  }

  /** The row counts a snapshot of a seeded user must start from, so equality is not vacuous. */
  function expectSeeded(before: Record<string, string[]>, opts: { departureRecord: number; tenantMember?: number }) {
    expect(Object.fromEntries(Object.entries(before).map(([t, rows]) => [t, rows.length]))).toEqual({
      tenant_members: opts.tenantMember ?? 1,
      team_members: 1,
      team_member_keys: 1,
      team_invitations: 1,
      scim_external_mappings: 1,
      tenant_member_departures: opts.departureRecord,
      sessions: 1,
      extension_tokens: 1,
      mcp_access_tokens: 1,
      mcp_authorization_codes: 1,
    });
  }

  async function outbox(): Promise<{ action: string; targetId: string; metadata: Record<string, unknown> }[]> {
    const rows = await sql<{ payload: { action: string; targetId: string; metadata: Record<string, unknown> } }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at`,
      tenantId,
    );
    return rows.map(({ payload }) => ({ action: payload.action, targetId: payload.targetId, metadata: payload.metadata }));
  }

  /** Each seeded artifact: whether it still authenticates. */
  async function artifactState(a: Artifacts) {
    const [s] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE id = $1::uuid`, a.sessionId);
    const [e] = await sql<{ v: Date | null }>(`SELECT revoked_at AS v FROM extension_tokens WHERE id = $1::uuid`, a.extensionTokenId);
    const [m] = await sql<{ v: Date | null }>(`SELECT revoked_at AS v FROM mcp_access_tokens WHERE id = $1::uuid`, a.mcpAccessTokenId);
    const [c] = await sql<{ v: Date | null }>(`SELECT used_at AS v FROM mcp_authorization_codes WHERE id = $1::uuid`, a.mcpAuthorizationCodeId);
    return { session: s.n === 1, extensionToken: e.v === null, mcpAccessToken: m.v === null, mcpAuthorizationCode: c.v === null };
  }

  const LIVE = { session: true, extensionToken: true, mcpAccessToken: true, mcpAuthorizationCode: true };
  const REVOKED = { session: false, extensionToken: false, mcpAccessToken: false, mcpAuthorizationCode: false };

  async function tenantStamp(userId: string): Promise<Date | null | "absent"> {
    const [row] = await sql<{ deactivated_at: Date | null }>(
      `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenantId, userId,
    );
    return row ? row.deactivated_at : "absent";
  }

  // ── Entry points ─────────────────────────────────────────────

  function scimPatch(userId: string, active: boolean) {
    return scimPatchUser(
      jsonRequest(`http://localhost/api/scim/v2/Users/${userId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  function scimPut(user: { id: string; email: string; ext: string }, active: boolean) {
    return scimPutUser(
      jsonRequest(`http://localhost/api/scim/v2/Users/${user.id}`, "PUT", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: user.email,
        externalId: user.ext,
        active,
      }),
      { params: Promise.resolve({ id: user.id }) },
    );
  }

  function scimDelete(userId: string) {
    return scimDeleteUser(
      new NextRequest(`http://localhost/api/scim/v2/Users/${userId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  function teamRemove(actor: string, teamId: string, rowId: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return removeMember(new NextRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, { method: "DELETE" }), {
      params: Promise.resolve({ teamId, memberId: rowId }),
    });
  }

  /** A mapped member of one team, with a key, an invitation they issued, and the four artifacts. */
  async function departingMember() {
    const owner = await ctx.createUser(tenantId);
    const user = await mapped();
    const teamId = await team(owner);
    const rowId = await addTeamMember(teamId, user.id, "MEMBER");
    await invitationFrom(teamId, user.id);
    const artifacts = await seedArtifacts(user.id, owner);
    return { owner, user, teamId, rowId, artifacts };
  }

  // ── T1: SCIM PUT / PATCH / DELETE and team DELETE (AC1–AC3) ──
  //
  // A route handler that throws is answered 500 by Next.js; called in-process,
  // withRequestLog rethrows it, so the rejection IS the 500. Its message
  // carrying T1_REVOCATION_FAULT proves the 500 came from the faulted
  // revocation and not from an earlier failure.

  describe("T1: a failed revocation commits nothing, and the retry transitions and revokes", () => {
    it("SCIM PATCH active=false", async () => {
      const { user, artifacts } = await departingMember();
      const before = await snapshot(user.id);
      expectSeeded(before, { departureRecord: 0 });

      await withFault(user.id, artifacts, () =>
        expect(scimPatch(user.id, false)).rejects.toThrow(FAULT),
      );

      expect(await snapshot(user.id)).toEqual(before);
      expect(await outbox()).toEqual([]);

      const retried = await scimPatch(user.id, false);
      expect(retried.status).toBe(200);
      expect(await tenantStamp(user.id)).toBeInstanceOf(Date);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      const deactivate = (await outbox()).filter((r) => r.action === AUDIT_ACTION.SCIM_USER_DEACTIVATE);
      expect(deactivate).toHaveLength(1);
      expect(deactivate[0].metadata).toMatchObject({ sessions: 1, extensionTokens: 1, mcpAccessTokens: 1, mcpAuthorizationCodes: 1 });
    });

    it("SCIM PUT active=false", async () => {
      const { user, artifacts } = await departingMember();
      const before = await snapshot(user.id);
      expectSeeded(before, { departureRecord: 0 });

      await withFault(user.id, artifacts, () =>
        expect(scimPut(user, false)).rejects.toThrow(FAULT),
      );

      expect(await snapshot(user.id)).toEqual(before);
      expect(await outbox()).toEqual([]);

      const retried = await scimPut(user, false);
      expect(retried.status).toBe(200);
      expect(await tenantStamp(user.id)).toBeInstanceOf(Date);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      const deactivate = (await outbox()).filter((r) => r.action === AUDIT_ACTION.SCIM_USER_DEACTIVATE);
      expect(deactivate).toHaveLength(1);
      expect(deactivate[0].metadata).toMatchObject({ sessions: 1, extensionTokens: 1, mcpAccessTokens: 1, mcpAuthorizationCodes: 1 });
    });

    it("SCIM DELETE: the retry deletes (204, not 404)", async () => {
      const { user, artifacts } = await departingMember();
      const before = await snapshot(user.id);
      expectSeeded(before, { departureRecord: 0 });

      await withFault(user.id, artifacts, () =>
        expect(scimDelete(user.id)).rejects.toThrow(FAULT),
      );

      expect(await snapshot(user.id)).toEqual(before);
      expect(await outbox()).toEqual([]);

      const retried = await scimDelete(user.id);
      expect(retried.status).toBe(204);
      expect(await tenantStamp(user.id)).toBe("absent");
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      const deleted = (await outbox()).filter((r) => r.action === AUDIT_ACTION.SCIM_USER_DELETE);
      expect(deleted).toHaveLength(1);
      expect(deleted[0].metadata).toMatchObject({ sessions: 1, extensionTokens: 1, mcpAccessTokens: 1, mcpAuthorizationCodes: 1 });
    });

    it("team member DELETE: the retry removes (200, not MEMBER_NOT_FOUND)", async () => {
      const { owner, user, teamId, rowId, artifacts } = await departingMember();
      const before = await snapshot(user.id);
      expectSeeded(before, { departureRecord: 0 });

      await withFault(user.id, artifacts, () =>
        expect(teamRemove(owner, teamId, rowId)).rejects.toThrow(FAULT),
      );

      expect(await snapshot(user.id)).toEqual(before);
      expect(await outbox()).toEqual([]);

      const retried = await teamRemove(owner, teamId, rowId);
      expect(retried.status).toBe(200);
      const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM team_members WHERE id = $1::uuid`, rowId);
      expect(n).toBe(0);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      const removed = (await outbox()).filter((r) => r.action === AUDIT_ACTION.TEAM_MEMBER_REMOVE);
      expect(removed).toHaveLength(1);
      expect(removed[0].metadata).toMatchObject({ removedUserId: user.id, sessions: 1, extensionTokens: 1, mcpAccessTokens: 1, mcpAuthorizationCodes: 1 });
    });
  });

  // ── T8: a departure with no transition revokes nothing (AC7) ──

  describe("T8: a PATCH active=false of a member already deactivated", () => {
    it("revokes nothing and returns revocation null, while its transitioning pair revoked", async () => {
      const { user, artifacts } = await departingMember();
      // The transitioning pair (T1's retry, without a fault): it revokes.
      expect((await scimPatch(user.id, false)).status).toBe(200);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      // Artifacts minted after the departure; nothing must touch them now.
      const owner = await ctx.createUser(tenantId);
      const fresh = await seedArtifacts(user.id, owner);
      const stamp = await tenantStamp(user.id);

      const res = await scimPatch(user.id, false);
      expect(res.status).toBe(200);
      const service = await withTenantRls(prisma, tenantId, () =>
        patchScimUser(tenantId, user.id, { active: false }, { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM }),
      );

      expect(service).toMatchObject({ auditAction: AUDIT_ACTION.SCIM_USER_UPDATE, revocation: null });
      expect(await artifactState(fresh)).toEqual(LIVE);
      expect(await tenantStamp(user.id)).toEqual(stamp);
      const updates = (await outbox()).filter((r) => r.action === AUDIT_ACTION.SCIM_USER_UPDATE);
      expect(updates).toHaveLength(1);
      expect(updates[0].metadata).not.toHaveProperty("sessions");
    });
  });

  // ── T2: directory sync (AC4) ─────────────────────────────────

  describe("T2: directory sync", () => {
    let configId: string;

    beforeEach(async () => {
      mockFetchOktaUsers.mockReset();
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

    async function lastLog() {
      const [log] = await sql<{ status: string }>(
        `SELECT status FROM directory_sync_logs WHERE config_id = $1::uuid ORDER BY started_at DESC LIMIT 1`,
        configId,
      );
      const [config] = await sql<{ last_sync_error: string | null }>(
        `SELECT last_sync_error FROM directory_sync_configs WHERE id = $1::uuid`,
        configId,
      );
      return { status: log?.status, lastSyncError: config.last_sync_error };
    }

    const tenantDeactivations = async () =>
      (await outbox()).filter((r) => r.action === AUDIT_ACTION.TEAM_MEMBER_TENANT_DEACTIVATE);

    it("a run that suspends a user deactivates and revokes them; with the revocation failing it changes nothing, and the next run does", async () => {
      const { user, artifacts } = await departingMember();
      mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", false)]);
      const before = await snapshot(user.id);
      expectSeeded(before, { departureRecord: 0 });

      const failed = await withFault(user.id, artifacts, () => runDirectorySync({ configId, tenantId, force: true }));

      expect(failed.success).toBe(false);
      expect(failed.errorMessage).toContain(FAULT);
      expect(await lastLog()).toEqual({ status: "ERROR", lastSyncError: expect.stringContaining(FAULT) });
      expect(await snapshot(user.id)).toEqual(before);
      expect(await tenantDeactivations()).toEqual([]);

      const next = await runDirectorySync({ configId, tenantId, force: true });

      expect(next.success).toBe(true);
      expect(await tenantStamp(user.id)).toBeInstanceOf(Date);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      expect(await tenantDeactivations()).toEqual([expect.objectContaining({ targetId: user.id })]);
    });

    it("a run creating a user deactivated revokes what they already hold in the tenant", async () => {
      const owner = await ctx.createUser(tenantId);
      const guest = await ownedWithoutRow();
      const artifacts = await seedArtifacts(guest.id, owner);
      mockFetchOktaUsers.mockResolvedValue([oktaUser(`ext-${guest.id.slice(0, 8)}`, guest.email, "Guest", false)]);

      const result = await runDirectorySync({ configId, tenantId, force: true });

      expect(result.success).toBe(true);
      expect(await tenantStamp(guest.id)).toBeInstanceOf(Date);
      expect(await artifactState(artifacts)).toEqual(REVOKED);
    });
  });

  it("T2: a SCIM POST creating a user deactivated revokes what they already hold in the tenant", async () => {
    const owner = await ctx.createUser(tenantId);
    const guest = await ownedWithoutRow();
    const artifacts = await seedArtifacts(guest.id, owner);
    expect(await artifactState(artifacts)).toEqual(LIVE);

    const res = await scimPostUser(jsonRequest("http://localhost/api/scim/v2/Users", "POST", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: guest.email,
      active: false,
    }));

    expect(res.status).toBe(201);
    expect(await tenantStamp(guest.id)).toBeInstanceOf(Date);
    expect(await artifactState(artifacts)).toEqual(REVOKED);
  });

  async function apiKey(userId: string, tenant: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_test', $5, 'passwords:read', now() + interval '1 day', now())`,
      id, userId, tenant, hex(32), `key-${id.slice(0, 8)}`,
    );
    return id;
  }

  async function apiKeyLive(id: string): Promise<boolean> {
    const [row] = await sql<{ revoked_at: Date | null }>(`SELECT revoked_at FROM api_keys WHERE id = $1::uuid`, id);
    return row.revoked_at === null;
  }

  /** A session and an API key of `userId` in `tenant`, the user's own there; returns their ids. */
  async function otherTenantCredentials(userId: string, tenant: string) {
    const otherSessionId = randomUUID();
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      otherSessionId, hashSessionToken(`sess-${randomUUID()}`), userId, tenant,
    );
    return { otherSessionId, otherKey: await apiKey(userId, tenant) };
  }

  async function otherTenantLive(otherSessionId: string, otherKey: string) {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE id = $1::uuid`, otherSessionId);
    return { session: n === 1, apiKey: await apiKeyLive(otherKey) };
  }

  // ── Reactivation revokes leftovers (code-review round-1 S1) ──
  //
  // Departures made before revocation was atomic (every directory-sync one,
  // a SCIM/team failure that was swallowed) left the user's credentials in the
  // tenant alive. A return revokes what the user holds there, so it cannot
  // bring them back.

  describe("a reactivation revokes the credentials a departure left behind", () => {
    let otherTenantId: string;

    beforeEach(async () => {
      otherTenantId = await ctx.createTenant();
    });

    afterEach(async () => {
      // The user belongs to this tenant, so deleteTestData(otherTenantId) does
      // not reach their rows there.
      await sql(`DELETE FROM sessions WHERE tenant_id = $1::uuid`, otherTenantId);
      await sql(`DELETE FROM api_keys WHERE tenant_id = $1::uuid`, otherTenantId);
      await ctx.deleteTestData(otherTenantId);
    });

    /**
     * A mapped member deactivated without a revocation (the residue of a
     * pre-change departure), still holding the four artifacts and an API key in
     * this tenant, and a session and an API key in another tenant.
     */
    async function departedWithLeftovers() {
      const owner = await ctx.createUser(tenantId);
      const user = await mapped();
      const artifacts = await seedArtifacts(user.id, owner);
      const key = await apiKey(user.id, tenantId);
      await sql(
        `UPDATE tenant_members SET deactivated_at = now() - interval '1 hour' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        tenantId, user.id,
      );
      const { otherSessionId, otherKey } = await otherTenantCredentials(user.id, otherTenantId);
      expect(await artifactState(artifacts)).toEqual(LIVE);
      expect(await apiKeyLive(key)).toBe(true);
      return { user, artifacts, key, otherSessionId, otherKey };
    }

    it("SCIM PATCH active=true revokes them, records the counts on SCIM_USER_REACTIVATE, and leaves another tenant's alone", async () => {
      const { user, artifacts, key, otherSessionId, otherKey } = await departedWithLeftovers();

      const res = await scimPatch(user.id, true);

      expect(res.status).toBe(200);
      expect(await tenantStamp(user.id)).toBeNull();
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      expect(await apiKeyLive(key)).toBe(false);
      const reactivate = (await outbox()).filter((r) => r.action === AUDIT_ACTION.SCIM_USER_REACTIVATE);
      expect(reactivate).toHaveLength(1);
      expect(reactivate[0].metadata).toMatchObject({
        sessions: 1,
        extensionTokens: 1,
        apiKeys: 1,
        mcpAccessTokens: 1,
        mcpAuthorizationCodes: 1,
      });
      expect(await otherTenantLive(otherSessionId, otherKey)).toEqual({ session: true, apiKey: true });
    });

    it("a directory-sync run reactivating the user revokes them, and leaves another tenant's alone", async () => {
      const { user, artifacts, key, otherSessionId, otherKey } = await departedWithLeftovers();
      const configId = randomUUID();
      await sql(
        `INSERT INTO directory_sync_configs
           (id, tenant_id, provider, display_name, enabled, sync_interval_minutes,
            encrypted_credentials, credentials_iv, credentials_auth_tag, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'OKTA'::"DirectorySyncProvider", 'test-config', true, 60,
            'cipher', 'iv', 'tag', 'IDLE'::"DirectorySyncStatus", now(), now())`,
        configId, tenantId,
      );
      mockFetchOktaUsers.mockReset();
      mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", true)]);

      const result = await runDirectorySync({ configId, tenantId, force: true });

      expect(result.success).toBe(true);
      expect(await tenantStamp(user.id)).toBeNull();
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      expect(await apiKeyLive(key)).toBe(false);
      expect(await otherTenantLive(otherSessionId, otherKey)).toEqual({ session: true, apiKey: true });
    });
  });

  // ── A membership creation revokes leftovers (code-review round-4 S-R4-1, deviation D13) ──
  //
  // An old-release SCIM DELETE whose revocation failed leaves the user with no
  // row and live credentials in the tenant. Re-creating the row is not a
  // reactivation, so returnToTenant never runs; the creating transaction
  // revokes what the user holds there instead.

  describe("a membership creation revokes the credentials an earlier membership left behind", () => {
    let otherTenantId: string;

    beforeEach(async () => {
      otherTenantId = await ctx.createTenant();
    });

    afterEach(async () => {
      await sql(`DELETE FROM sessions WHERE tenant_id = $1::uuid`, otherTenantId);
      await sql(`DELETE FROM api_keys WHERE tenant_id = $1::uuid`, otherTenantId);
      await ctx.deleteTestData(otherTenantId);
    });

    /**
     * A user this tenant owns whose row was deleted (the SCIM DELETE) while
     * the revocation failed: the four artifacts and an API key still live
     * here, and a session and an API key of theirs in another tenant.
     */
    async function removedWithLeftovers() {
      const owner = await ctx.createUser(tenantId);
      const user = await ownedWithoutRow();
      const artifacts = await seedArtifacts(user.id, owner);
      const key = await apiKey(user.id, tenantId);
      const other = await otherTenantCredentials(user.id, otherTenantId);
      expect(await tenantStamp(user.id)).toBe("absent");
      expect(await artifactState(artifacts)).toEqual(LIVE);
      expect(await apiKeyLive(key)).toBe(true);
      return { user, artifacts, key, ...other };
    }

    it("a SCIM POST creating the user active revokes them, and leaves another tenant's alone", async () => {
      const { user, artifacts, key, otherSessionId, otherKey } = await removedWithLeftovers();

      const res = await scimPostUser(jsonRequest("http://localhost/api/scim/v2/Users", "POST", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: user.email,
        active: true,
      }));

      expect(res.status).toBe(201);
      expect(await tenantStamp(user.id)).toBeNull();
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      expect(await apiKeyLive(key)).toBe(false);
      expect(await otherTenantLive(otherSessionId, otherKey)).toEqual({ session: true, apiKey: true });
    });

    it("a directory-sync run creating the user active revokes them, and leaves another tenant's alone", async () => {
      const { user, artifacts, key, otherSessionId, otherKey } = await removedWithLeftovers();
      const configId = randomUUID();
      await sql(
        `INSERT INTO directory_sync_configs
           (id, tenant_id, provider, display_name, enabled, sync_interval_minutes,
            encrypted_credentials, credentials_iv, credentials_auth_tag, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'OKTA'::"DirectorySyncProvider", 'test-config', true, 60,
            'cipher', 'iv', 'tag', 'IDLE'::"DirectorySyncStatus", now(), now())`,
        configId, tenantId,
      );
      mockFetchOktaUsers.mockReset();
      mockFetchOktaUsers.mockResolvedValue([oktaUser(`ext-${user.id.slice(0, 8)}`, user.email, "User", true)]);

      const result = await runDirectorySync({ configId, tenantId, force: true });

      expect(result.success).toBe(true);
      expect(result.usersCreated).toBe(1);
      expect(await tenantStamp(user.id)).toBeNull();
      expect(await artifactState(artifacts)).toEqual(REVOKED);
      expect(await apiKeyLive(key)).toBe(false);
      expect(await otherTenantLive(otherSessionId, otherKey)).toEqual({ session: true, apiKey: true });
    });
  });

  // ── T7: admin vault reset (AC6) ──────────────────────────────

  describe("T7: admin vault reset", () => {
    async function approvedReset(targetUserId: string): Promise<{ id: string; token: string }> {
      const initiator = await ctx.createUser(tenantId);
      const approver = await ctx.createUser(tenantId);
      const id = randomUUID();
      const token = hex(32);
      await sql(
        `INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, token_hash, encrypted_token,
           target_email_at_initiate, expires_at, approved_at, approved_by_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '24 hours', now(), $8::uuid, now())`,
        id, tenantId, targetUserId, initiator, createHash("sha256").update(token).digest("hex"), `enc-${hex(8)}`,
        `target-${id.slice(0, 8)}@example.com`, approver,
      );
      return { id, token };
    }

    async function vaultEntry(userId: string): Promise<string> {
      const id = randomUUID();
      await sql(
        `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
           encrypted_overview, overview_iv, overview_auth_tag, key_version, aad_version, entry_type, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 1, 1, 'LOGIN', now(), now())`,
        id, userId, tenantId, hex(32), hex(12), hex(16), hex(32), hex(12), hex(16),
      );
      return id;
    }

    /** The reset token and the vault: what a failed reset must leave as it was. */
    async function resetState(resetId: string, userId: string) {
      const [reset] = await sql<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM admin_vault_resets t WHERE id = $1::uuid`, resetId);
      const entries = await sql<{ r: string }>(
        `SELECT row_to_json(t)::text AS r FROM password_entries t WHERE user_id = $1::uuid ORDER BY 1`,
        userId,
      );
      const [user] = await sql<{ esk: string | null; vault_setup_at: Date | null }>(
        `SELECT encrypted_secret_key AS esk, vault_setup_at FROM users WHERE id = $1::uuid`,
        userId,
      );
      return { reset: reset.r, entries: entries.map((e) => e.r), user };
    }

    function execute(userId: string, token: string) {
      mockAuth.mockResolvedValue({ user: { id: userId } });
      return adminReset(jsonRequest("http://localhost/api/vault/admin-reset", "POST", {
        token,
        confirmation: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT,
      }));
    }

    it("a failed revocation leaves the token unspent and the vault intact; the retry wipes and revokes", async () => {
      const userId = await ctx.createUser(tenantId);
      await sql(
        `UPDATE users SET encrypted_secret_key = 'placeholder-esk', vault_setup_at = now(), key_version = 1 WHERE id = $1::uuid`,
        userId,
      );
      await vaultEntry(userId);
      const owner = await ctx.createUser(tenantId);
      const artifacts = await seedArtifacts(userId, owner);
      const reset = await approvedReset(userId);
      const before = await resetState(reset.id, userId);
      expect(before.entries).toHaveLength(1);
      expect(before.user.esk).not.toBeNull();
      expect(JSON.parse(before.reset)).toMatchObject({ executed_at: null, encrypted_token: expect.any(String) });

      await withFault(userId, artifacts, () => expect(execute(userId, reset.token)).rejects.toThrow(FAULT));

      expect(await resetState(reset.id, userId)).toEqual(before);
      expect(await artifactState(artifacts)).toEqual(LIVE);
      expect((await outbox()).map((r) => r.action)).toEqual([]);

      const retried = await execute(userId, reset.token);

      expect(retried.status).toBe(200);
      const after = await resetState(reset.id, userId);
      expect(JSON.parse(after.reset)).toMatchObject({ executed_at: expect.any(String), encrypted_token: null });
      expect(after.entries).toEqual([]);
      expect(after.user.esk).toBeNull();
      expect(await artifactState(artifacts)).toEqual(REVOKED);
    });
  });
});
