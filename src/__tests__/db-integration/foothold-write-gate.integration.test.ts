/**
 * Integration test (real DB): every site that writes a member foothold takes
 * the foothold write gate as the first statement of its transaction
 * (src/lib/tenant/foothold-write-gate.ts; docs/archive/review/
 * member-foothold-containment-plan.md C5). The gate locks the actor's tenant
 * row FOR SHARE, so a demotion or deactivation holding the row uncommitted
 * parks the route; once it commits the route refuses and writes nothing. The
 * route's own pre-check reads the committed state and passes, so only the
 * gate can refuse here — a cell where the gate is removed finds the route run
 * through and fails at the blocked observation (RT4).
 *
 * Each row of SITES is one C5 site and carries { seed, invoke, assertNoWrite,
 * assertWritten, heldChange }: "demotion" for the rows whose permission is
 * tested, "deactivation" for the `permission: null` rows (consent,
 * emergency-access), where a demotion changes nothing the gate reads.
 *
 * Run: npm run test:integration -- foothold-write-gate
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers, holdPrismaWriter, type HeldWriter } from "./race-helpers";
import { deleteSession, requestWithSession, seedSession } from "./session-request";
import { createMultipartRequest } from "../helpers/request-builder";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: async () => {},
  }),
}));
// No real mail from the reset, emergency and breakglass notifications.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));

import { POST as mintSaToken } from "@/app/api/tenant/service-accounts/[id]/tokens/route";
import { POST as approveAccessRequest } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { POST as initiateReset } from "@/app/api/tenant/members/[userId]/reset-vault/route";
import { POST as approveReset } from "@/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route";
import { POST as createTenantWebhook } from "@/app/api/tenant/webhooks/route";
import { POST as createScimToken } from "@/app/api/tenant/scim-tokens/route";
import { POST as createMcpClient } from "@/app/api/tenant/mcp-clients/route";
import { PUT as updateMcpClient } from "@/app/api/tenant/mcp-clients/[id]/route";
import { POST as createServiceAccount } from "@/app/api/tenant/service-accounts/route";
import { PUT as updateServiceAccount } from "@/app/api/tenant/service-accounts/[id]/route";
import { POST as consent } from "@/app/api/mcp/authorize/consent/route";
import { POST as createBreakglassGrant } from "@/app/api/tenant/breakglass/route";
import { POST as createEmergencyGrant } from "@/app/api/emergency-access/route";
import { POST as createShareLink } from "@/app/api/share-links/route";
import { POST as createSend } from "@/app/api/sends/route";
import { POST as createFileSend } from "@/app/api/sends/file/route";
import { POST as createDeliveryTarget } from "@/app/api/tenant/audit-delivery-targets/route";
import { PATCH as patchDeliveryTarget } from "@/app/api/tenant/audit-delivery-targets/[id]/route";
import { departFromTenant } from "@/lib/team/team-departure";
import { revokeUsersAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import { encryptResetToken } from "@/lib/vault/admin-reset-token-crypto";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

const BASE = "http://localhost";
const HELD_TX_TIMEOUT_MS = 30_000;
const hex = (n: number) => randomBytes(n).toString("hex");

type Env = { tenantId: string; actorId: string };
type HeldChange = "demotion" | "deactivation";

type Site = {
  name: string;
  heldChange: HeldChange;
  okStatus: number;
  /** The pre-check's own refusal of a committed change, when it is not a 403 response. */
  controlRejects?: string;
  /** Rows the request needs besides the actor's membership; returns what invoke/asserts read. */
  seed: (env: Env) => Promise<Record<string, string>>;
  invoke: (cookie: string, env: Env, seeded: Record<string, string>) => Promise<Response>;
  assertNoWrite: (env: Env, seeded: Record<string, string>) => Promise<void>;
  assertWritten: (env: Env, seeded: Record<string, string>) => Promise<void>;
};

describe("foothold write gate — real-DB integration", () => {
  let ctx: TestContext;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  const dcrClientIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    race = createRaceHelpers(ctx.su.pool);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });

  afterEach(async () => {
    // An unclaimed DCR client has no tenant, so the tenant sweep does not reach it.
    if (dcrClientIds.length > 0) {
      await sql(`DELETE FROM mcp_clients WHERE id = ANY($1::uuid[])`, dcrClientIds.splice(0));
    }
    await ctx.deleteTestData(tenantId);
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  async function count(table: string, where: string, ...params: unknown[]): Promise<number> {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, ...params);
    return n;
  }

  async function member(role: "OWNER" | "ADMIN" | "MEMBER"): Promise<string> {
    const id = await ctx.createUser(tenantId);
    if (role !== "OWNER") {
      await sql(`UPDATE tenant_members SET role = $3::"TenantRole" WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, id, role);
    }
    return id;
  }

  async function emailOf(userId: string): Promise<string> {
    const [{ email }] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, userId);
    return email;
  }

  /** An uncommitted change to the user's tenant row, held until release(). */
  function holdChange(kind: HeldChange, userId: string): Promise<HeldWriter> {
    return holdPrismaWriter(
      ctx.su.prisma,
      async (tx) => {
        await setBypassRlsGucs(tx);
        if (kind === "demotion") {
          await tx.$executeRaw`UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid`;
        } else {
          await tx.$executeRaw`UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid`;
        }
      },
      HELD_TX_TIMEOUT_MS,
    );
  }

  /** The same change, committed: the pre-check control. */
  async function commitChange(kind: HeldChange, userId: string): Promise<void> {
    const held = await holdChange(kind, userId);
    await held.release();
  }

  /**
   * Run the request, see it wait on the held transaction, release at once (the
   * lock budget is 3 s), and return how it settled. Releases even when the
   * wait is never observed, so a failing cell leaves no open transaction.
   */
  async function runBlockedBy(held: HeldWriter, send: () => Promise<Response>): Promise<Response> {
    const pending = send();
    pending.catch(() => {});
    try {
      await race.waitForBackendBlockedBy(held.pid);
    } finally {
      await held.release();
    }
    return pending;
  }

  async function login(userId: string): Promise<string> {
    mockAuth.mockResolvedValue({ user: { id: userId, email: await emailOf(userId), name: "Actor" } });
    return seedSession(ctx, userId, tenantId);
  }

  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  async function serviceAccount(createdBy: string, isActive = true): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO service_accounts (id, tenant_id, name, is_active, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, now(), now())`,
      id, tenantId, `gate-sa-${id.slice(0, 8)}`, isActive, createdBy,
    );
    return id;
  }

  async function mcpClientRow(createdBy: string, isActive: boolean): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, '', $4, ARRAY['https://example.com/cb']::text[], 'credentials:list', $5, $6::uuid, now(), now())`,
      id, tenantId, `cli-${id.slice(0, 16)}`, `gate-client-${id.slice(0, 8)}`, isActive, createdBy,
    );
    return id;
  }

  async function dcrClient(): Promise<{ id: string; clientId: string }> {
    const id = randomUUID();
    const clientId = `mcpc_${id.replace(/-/g, "").slice(0, 24)}`;
    await sql(
      `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, is_dcr, dcr_expires_at, created_at, updated_at)
       VALUES ($1::uuid, NULL, $2, '', $3, ARRAY['https://example.com/callback']::text[], 'credentials:list', true, true, now() + interval '15 minutes', now(), now())`,
      id, clientId, `gate-dcr-${id.slice(0, 8)}`,
    );
    dcrClientIds.push(id);
    return { id, clientId };
  }

  async function resetRow(opts: { initiatedBy: string; target: string }): Promise<string> {
    const id = randomUUID();
    const token = hex(32);
    const targetEmail = await emailOf(opts.target);
    const encryptedToken = encryptResetToken(token, { tenantId, resetId: id, targetEmailAtInitiate: targetEmail });
    await sql(
      `INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, token_hash, encrypted_token, target_email_at_initiate, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '23 hours', now())`,
      id, tenantId, opts.target, opts.initiatedBy, hex(32), encryptedToken, targetEmail,
    );
    return id;
  }

  async function personalEntry(userId: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag, key_version, aad_version, entry_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 1, 1, 'LOGIN', now(), now())`,
      id, userId, tenantId, hex(32), hex(12), hex(16), hex(32), hex(12), hex(16),
    );
    return id;
  }

  /** A team entry the actor can read: they are a MEMBER of a team another user owns. */
  async function teamEntryReadableBy(actorId: string): Promise<string> {
    const owner = await member("OWNER");
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      teamId, tenantId, `gate-team-${teamId.slice(0, 8)}`,
    );
    for (const [userId, role] of [[owner, "OWNER"], [actorId, "MEMBER"]]) {
      await sql(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
        randomUUID(), teamId, userId, tenantId, role,
      );
    }
    const entryId = randomUUID();
    await sql(
      `INSERT INTO team_password_entries (id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version, entry_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, 1, 0, 'LOGIN', now(), now())`,
      entryId, teamId, tenantId, owner, hex(32), hex(12), hex(16), hex(32), hex(12), hex(16),
    );
    return entryId;
  }

  async function deliveryTargetRow(createdBy: string, isActive: boolean): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO audit_delivery_targets (id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag, master_key_version, is_active, created_by_id, created_at)
       VALUES ($1::uuid, $2::uuid, 'WEBHOOK', $3, $4, $5, 1, $6, $7::uuid, now())`,
      id, tenantId, hex(32), hex(12), hex(16), isActive, createdBy,
    );
    return id;
  }

  const sharesBy = (actorId: string) => count("password_shares", "created_by_id = $1::uuid", actorId);

  const consentForm = (clientId: string) =>
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://example.com/callback",
      scope: "credentials:list",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      state: "gate-state",
    });

  // ─── The C5 sites ─────────────────────────────────────────────────────

  const SITES: Site[] = [
    {
      name: "SA token mint",
      heldChange: "demotion",
      okStatus: 201,
      seed: async (env) => ({ sa: await serviceAccount(env.actorId) }),
      invoke: (cookie, _env, s) =>
        mintSaToken(
          requestWithSession(cookie, `${BASE}/api/tenant/service-accounts/${s.sa}/tokens`, {
            body: { name: "t", scope: ["passwords:read"], expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
          }),
          idParams(s.sa),
        ),
      assertNoWrite: async (_e, s) => expect(await count("service_account_tokens", "service_account_id = $1::uuid", s.sa)).toBe(0),
      assertWritten: async (e, s) =>
        expect(await count("service_account_tokens", "service_account_id = $1::uuid AND created_by_id = $2::uuid", s.sa, e.actorId)).toBe(1),
    },
    {
      name: "JIT access-request approve",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => {
        const requester = await member("OWNER");
        const sa = await serviceAccount(requester);
        const request = randomUUID();
        await sql(
          `INSERT INTO access_requests (id, tenant_id, service_account_id, requested_scope, status, requester_user_id, expires_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'passwords:read', 'PENDING', $4::uuid, now() + interval '1 hour', now())`,
          request, env.tenantId, sa, requester,
        );
        return { sa, request };
      },
      invoke: (cookie, _env, s) =>
        approveAccessRequest(
          requestWithSession(cookie, `${BASE}/api/tenant/access-requests/${s.request}/approve`),
          idParams(s.request),
        ),
      assertNoWrite: async (_e, s) => {
        expect(await count("service_account_tokens", "service_account_id = $1::uuid", s.sa)).toBe(0);
        expect(await count("access_requests", "id = $1::uuid AND status = 'PENDING'", s.request)).toBe(1);
      },
      assertWritten: async (e, s) =>
        expect(await count("service_account_tokens", "service_account_id = $1::uuid AND created_by_id = $2::uuid", s.sa, e.actorId)).toBe(1),
    },
    {
      name: "reset-vault initiate",
      heldChange: "demotion",
      okStatus: 200,
      seed: async () => ({ target: await member("MEMBER") }),
      invoke: (cookie, _env, s) =>
        initiateReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${s.target}/reset-vault`), {
          params: Promise.resolve({ userId: s.target }),
        }),
      assertNoWrite: async (e) => expect(await count("admin_vault_resets", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e, s) =>
        expect(await count("admin_vault_resets", "tenant_id = $1::uuid AND initiated_by_id = $2::uuid AND target_user_id = $3::uuid", e.tenantId, e.actorId, s.target)).toBe(1),
    },
    {
      name: "reset-vault approve",
      heldChange: "demotion",
      okStatus: 200,
      seed: async () => {
        const initiator = await member("ADMIN");
        const target = await member("MEMBER");
        return { initiator, target, reset: await resetRow({ initiatedBy: initiator, target }) };
      },
      invoke: (cookie, _env, s) =>
        approveReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${s.target}/reset-vault/${s.reset}/approve`), {
          params: Promise.resolve({ userId: s.target, resetId: s.reset }),
        }),
      assertNoWrite: async (_e, s) => expect(await count("admin_vault_resets", "id = $1::uuid AND approved_at IS NULL", s.reset)).toBe(1),
      assertWritten: async (e, s) =>
        expect(await count("admin_vault_resets", "id = $1::uuid AND approved_by_id = $2::uuid", s.reset, e.actorId)).toBe(1),
    },
    {
      name: "tenant webhook create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({}),
      invoke: (cookie) =>
        createTenantWebhook(
          requestWithSession(cookie, `${BASE}/api/tenant/webhooks`, {
            body: { url: "https://example.com/hook", events: ["ADMIN_VAULT_RESET_INITIATE"] },
          }),
        ),
      assertNoWrite: async (e) => expect(await count("tenant_webhooks", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("tenant_webhooks", "tenant_id = $1::uuid AND created_by_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "SCIM token create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({}),
      invoke: (cookie) => createScimToken(requestWithSession(cookie, `${BASE}/api/tenant/scim-tokens`, { body: { description: "gate" } })),
      assertNoWrite: async (e) => expect(await count("scim_tokens", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("scim_tokens", "tenant_id = $1::uuid AND created_by_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "MCP client create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({}),
      invoke: (cookie) =>
        createMcpClient(
          requestWithSession(cookie, `${BASE}/api/tenant/mcp-clients`, {
            body: { name: "gate-client", redirectUris: ["https://example.com/callback"], allowedScopes: ["credentials:list"] },
          }),
        ),
      assertNoWrite: async (e) => expect(await count("mcp_clients", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("mcp_clients", "tenant_id = $1::uuid AND created_by_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "service account create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({}),
      invoke: (cookie) => createServiceAccount(requestWithSession(cookie, `${BASE}/api/tenant/service-accounts`, { body: { name: "gate-sa" } })),
      assertNoWrite: async (e) => expect(await count("service_accounts", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("service_accounts", "tenant_id = $1::uuid AND created_by_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "service account re-activation (PUT isActive: true)",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => ({ sa: await serviceAccount(env.actorId, false) }),
      invoke: (cookie, _env, s) =>
        updateServiceAccount(requestWithSession(cookie, `${BASE}/api/tenant/service-accounts/${s.sa}`, { method: "PUT", body: { isActive: true } }), idParams(s.sa)),
      assertNoWrite: async (_e, s) => expect(await count("service_accounts", "id = $1::uuid AND is_active = false", s.sa)).toBe(1),
      assertWritten: async (_e, s) => expect(await count("service_accounts", "id = $1::uuid AND is_active = true", s.sa)).toBe(1),
    },
    {
      name: "MCP client re-activation (PUT isActive: true)",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => ({ client: await mcpClientRow(env.actorId, false) }),
      invoke: (cookie, _env, s) =>
        updateMcpClient(requestWithSession(cookie, `${BASE}/api/tenant/mcp-clients/${s.client}`, { method: "PUT", body: { isActive: true } }), idParams(s.client)),
      assertNoWrite: async (_e, s) => expect(await count("mcp_clients", "id = $1::uuid AND is_active = false", s.client)).toBe(1),
      assertWritten: async (_e, s) => expect(await count("mcp_clients", "id = $1::uuid AND is_active = true", s.client)).toBe(1),
    },
    {
      name: "MCP client scope widening (PUT allowedScopes)",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => ({ client: await mcpClientRow(env.actorId, true) }),
      invoke: (cookie, _env, s) =>
        updateMcpClient(requestWithSession(cookie, `${BASE}/api/tenant/mcp-clients/${s.client}`, { method: "PUT", body: { allowedScopes: ["credentials:list", "credentials:use"] } }), idParams(s.client)),
      assertNoWrite: async (_e, s) => expect(await count("mcp_clients", "id = $1::uuid AND allowed_scopes = 'credentials:list,credentials:use'", s.client)).toBe(0),
      assertWritten: async (_e, s) => expect(await count("mcp_clients", "id = $1::uuid AND allowed_scopes = 'credentials:list,credentials:use'", s.client)).toBe(1),
    },
    {
      name: "DCR claim in the consent route",
      heldChange: "deactivation",
      okStatus: 302,
      seed: async () => {
        const client = await dcrClient();
        return { client: client.id, clientId: client.clientId };
      },
      invoke: (cookie, _env, s) =>
        consent(requestWithSession(cookie, `${BASE}/api/mcp/authorize/consent`, { form: consentForm(s.clientId) })),
      // The claim is the write: it sets tenant_id and created_by_id on the unclaimed client.
      assertNoWrite: async (_e, s) =>
        expect(await count("mcp_clients", "id = $1::uuid AND tenant_id IS NULL AND created_by_id IS NULL", s.client)).toBe(1),
      assertWritten: async (e, s) =>
        expect(await count("mcp_clients", "id = $1::uuid AND tenant_id = $2::uuid AND created_by_id = $3::uuid", s.client, e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "breakglass grant create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({ target: await member("MEMBER") }),
      invoke: (cookie, _env, s) =>
        createBreakglassGrant(
          requestWithSession(cookie, `${BASE}/api/tenant/breakglass`, {
            body: { targetUserId: s.target, reason: "Security incident investigation INC-001" },
          }),
        ),
      assertNoWrite: async (e) => expect(await count("personal_log_access_grants", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("personal_log_access_grants", "tenant_id = $1::uuid AND requester_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "emergency-access grant create",
      heldChange: "deactivation",
      okStatus: 201,
      // withUserTenantRls resolves the owner's active tenant before the callback runs.
      controlRejects: "TENANT_NOT_RESOLVED",
      seed: async () => ({}),
      invoke: (cookie) =>
        createEmergencyGrant(
          requestWithSession(cookie, `${BASE}/api/emergency-access`, { body: { granteeEmail: `grantee-${hex(4)}@example.com`, waitDays: 7 } }),
        ),
      assertNoWrite: async (e) => expect(await count("emergency_access_grants", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("emergency_access_grants", "tenant_id = $1::uuid AND owner_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    // A share or Send is a foothold the creator's departure must stop; a
    // demotion changes nothing the gate reads (permission: null), so the held
    // change is a deactivation, as for emergency-access grants.
    {
      name: "share link create (personal entry)",
      heldChange: "deactivation",
      okStatus: 201,
      controlRejects: "TENANT_NOT_RESOLVED",
      seed: async (env) => ({ entry: await personalEntry(env.actorId) }),
      invoke: (cookie, _env, s) =>
        createShareLink(
          requestWithSession(cookie, `${BASE}/api/share-links`, {
            body: { passwordEntryId: s.entry, data: { title: "t", password: "p" }, expiresIn: "1d" },
          }),
        ),
      assertNoWrite: async (e) => expect(await sharesBy(e.actorId)).toBe(0),
      assertWritten: async (e) => expect(await sharesBy(e.actorId)).toBe(1),
    },
    {
      name: "share link create (team entry)",
      heldChange: "deactivation",
      okStatus: 201,
      controlRejects: "TENANT_NOT_RESOLVED",
      seed: async (env) => ({ entry: await teamEntryReadableBy(env.actorId) }),
      invoke: (cookie, _env, s) =>
        createShareLink(
          requestWithSession(cookie, `${BASE}/api/share-links`, {
            body: {
              teamPasswordEntryId: s.entry,
              encryptedShareData: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
              entryType: "LOGIN",
              expiresIn: "1d",
            },
          }),
        ),
      assertNoWrite: async (e) => expect(await sharesBy(e.actorId)).toBe(0),
      assertWritten: async (e) => expect(await sharesBy(e.actorId)).toBe(1),
    },
    {
      name: "text Send create",
      heldChange: "deactivation",
      okStatus: 201,
      controlRejects: "TENANT_NOT_RESOLVED",
      seed: async () => ({}),
      invoke: (cookie) =>
        createSend(requestWithSession(cookie, `${BASE}/api/sends`, { body: { name: "gate", text: "hello", expiresIn: "1d" } })),
      assertNoWrite: async (e) => expect(await sharesBy(e.actorId)).toBe(0),
      assertWritten: async (e) => expect(await sharesBy(e.actorId)).toBe(1),
    },
    {
      name: "file Send create",
      heldChange: "deactivation",
      okStatus: 201,
      controlRejects: "TENANT_NOT_RESOLVED",
      seed: async () => ({}),
      invoke: async (cookie) => {
        const form = new FormData();
        form.append("name", "gate");
        form.append("expiresIn", "1d");
        form.append("file", new File(["hello world"], "gate.txt", { type: "text/plain" }));
        return createFileSend(
          await createMultipartRequest(`${BASE}/api/sends/file`, form, {
            headers: { cookie: `${configuredSessionCookieName()}=${cookie}`, origin: BASE },
          }),
        );
      },
      assertNoWrite: async (e) => expect(await sharesBy(e.actorId)).toBe(0),
      assertWritten: async (e) => expect(await sharesBy(e.actorId)).toBe(1),
    },
    {
      name: "audit delivery target create",
      heldChange: "demotion",
      okStatus: 201,
      seed: async () => ({}),
      invoke: (cookie) =>
        createDeliveryTarget(
          requestWithSession(cookie, `${BASE}/api/tenant/audit-delivery-targets`, {
            body: { kind: "WEBHOOK", url: "https://example.com/hook", secret: "gate-secret" },
          }),
        ),
      assertNoWrite: async (e) => expect(await count("audit_delivery_targets", "tenant_id = $1::uuid", e.tenantId)).toBe(0),
      assertWritten: async (e) =>
        expect(await count("audit_delivery_targets", "tenant_id = $1::uuid AND created_by_id = $2::uuid", e.tenantId, e.actorId)).toBe(1),
    },
    {
      name: "audit delivery target re-activation (PATCH isActive: true)",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => ({ target: await deliveryTargetRow(env.actorId, false) }),
      invoke: (cookie, _env, s) =>
        patchDeliveryTarget(
          requestWithSession(cookie, `${BASE}/api/tenant/audit-delivery-targets/${s.target}`, { method: "PATCH", body: { isActive: true } }),
          idParams(s.target),
        ),
      assertNoWrite: async (_e, s) => expect(await count("audit_delivery_targets", "id = $1::uuid AND is_active = false", s.target)).toBe(1),
      assertWritten: async (_e, s) => expect(await count("audit_delivery_targets", "id = $1::uuid AND is_active = true", s.target)).toBe(1),
    },
    {
      // Deactivating a SIEM target removes visibility: not a pure narrowing, so gated too.
      name: "audit delivery target deactivation (PATCH isActive: false)",
      heldChange: "demotion",
      okStatus: 200,
      seed: async (env) => ({ target: await deliveryTargetRow(env.actorId, true) }),
      invoke: (cookie, _env, s) =>
        patchDeliveryTarget(
          requestWithSession(cookie, `${BASE}/api/tenant/audit-delivery-targets/${s.target}`, { method: "PATCH", body: { isActive: false } }),
          idParams(s.target),
        ),
      assertNoWrite: async (_e, s) => expect(await count("audit_delivery_targets", "id = $1::uuid AND is_active = true", s.target)).toBe(1),
      assertWritten: async (_e, s) => expect(await count("audit_delivery_targets", "id = $1::uuid AND is_active = false", s.target)).toBe(1),
    },
  ];

  /** A fresh OWNER actor (a demotion of an OWNER to MEMBER is what the held change reads). */
  async function newCell(site: Site) {
    const actorId = await member("OWNER");
    const env: Env = { tenantId, actorId };
    const seeded = await site.seed(env);
    const cookie = await login(actorId);
    return { env, seeded, cookie };
  }

  describe.each(SITES)("$name", (site) => {
    it("control (pre-check only): a committed change is refused by the route's own check", async () => {
      const { env, seeded, cookie } = await newCell(site);
      await commitChange(site.heldChange, env.actorId);

      if (site.controlRejects) {
        await expect(site.invoke(cookie, env, seeded)).rejects.toThrow(site.controlRejects);
      } else {
        const res = await site.invoke(cookie, env, seeded);
        expect(res.status).toBe(403);
      }
      await site.assertNoWrite(env, seeded);
    });

    it(`held ${site.heldChange} of the actor: the route waits on it, then refuses with 403 and writes nothing`, async () => {
      const { env, seeded, cookie } = await newCell(site);
      const held = await holdChange(site.heldChange, env.actorId);

      const res = await runBlockedBy(held, () => site.invoke(cookie, env, seeded));
      expect(res.status).toBe(403);
      if (site.name.startsWith("DCR claim")) expect((await res.json()).error).toBe("access_denied");
      await site.assertNoWrite(env, seeded);
    });

    it("session row deleted: 401 and no write", async () => {
      const { env, seeded, cookie } = await newCell(site);
      await deleteSession(ctx, cookie);

      const res = await site.invoke(cookie, env, seeded);
      expect(res.status).toBe(401);
      await site.assertNoWrite(env, seeded);
    });

    it("allow: the actor holds the authority and a live session — the write commits", async () => {
      const { env, seeded, cookie } = await newCell(site);

      const res = await site.invoke(cookie, env, seeded);
      expect(res.status).toBe(site.okStatus);
      await site.assertWritten(env, seeded);
    });
  });

  // ─── Re-activation's counterpart: the revoke stays ungated (T7-2) ─────

  describe.each([
    ["service account", "service_accounts", (a: string) => serviceAccount(a, true), (c: string, id: string) =>
      updateServiceAccount(requestWithSession(c, `${BASE}/api/tenant/service-accounts/${id}`, { method: "PUT", body: { isActive: false } }), idParams(id))],
    ["MCP client", "mcp_clients", (a: string) => mcpClientRow(a, true), (c: string, id: string) =>
      updateMcpClient(requestWithSession(c, `${BASE}/api/tenant/mcp-clients/${id}`, { method: "PUT", body: { isActive: false } }), idParams(id))],
  ])("deactivating a %s", (_label, table, seed, put) => {
    it("completes under the same held demotion without blocking (200)", async () => {
      const actorId = await member("OWNER");
      const id = await seed(actorId);
      const cookie = await login(actorId);
      const held = await holdChange("demotion", actorId);
      let res: Response;
      try {
        const work = (put as (c: string, id: string) => Promise<Response>)(cookie, id);
        // Observed while the held change is still open: the request settles
        // instead of waiting on it.
        expect(await race.settledOrBlocked(work, held.pid, held.pid)).toBe("settled");
        res = await work;
      } finally {
        await held.release();
      }
      expect(res.status).toBe(200);
      expect(await count(table as string, "id = $1::uuid AND is_active = false", id)).toBe(1);
    });
  });

  // ─── The reset routes also lock the users they read ───────────────────

  describe("reset routes lock the other users they decide on", () => {
    it("initiate: a target deactivated under a held change is refused after the wait (404), nothing created", async () => {
      const actorId = await member("OWNER");
      const target = await member("MEMBER");
      const cookie = await login(actorId);
      const held = await holdChange("deactivation", target);

      const res = await runBlockedBy(held, () =>
        initiateReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${target}/reset-vault`), { params: Promise.resolve({ userId: target }) }),
      );
      expect(res.status).toBe(404);
      expect(await count("admin_vault_resets", "tenant_id = $1::uuid", tenantId)).toBe(0);
    });

    it("approve: an initiator deactivated under a held change makes the reset not approvable (409 RESET_NOT_APPROVABLE)", async () => {
      const actorId = await member("OWNER");
      const initiator = await member("ADMIN");
      const target = await member("MEMBER");
      const reset = await resetRow({ initiatedBy: initiator, target });
      const cookie = await login(actorId);
      const held = await holdChange("deactivation", initiator);

      const res = await runBlockedBy(held, () =>
        approveReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${target}/reset-vault/${reset}/approve`), {
          params: Promise.resolve({ userId: target, resetId: reset }),
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("RESET_NOT_APPROVABLE");
      expect(await count("admin_vault_resets", "id = $1::uuid AND approved_at IS NULL", reset)).toBe(1);
    });

    it("approve: a target deactivated under a held change is refused after the wait (404)", async () => {
      const actorId = await member("OWNER");
      const initiator = await member("ADMIN");
      const target = await member("MEMBER");
      const reset = await resetRow({ initiatedBy: initiator, target });
      const cookie = await login(actorId);
      const held = await holdChange("deactivation", target);

      const res = await runBlockedBy(held, () =>
        approveReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${target}/reset-vault/${reset}/approve`), {
          params: Promise.resolve({ userId: target, resetId: reset }),
        }),
      );
      expect(res.status).toBe(404);
      expect(await count("admin_vault_resets", "id = $1::uuid AND approved_at IS NULL", reset)).toBe(1);
    });

    it.each([
      ["demoted", `UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`],
      ["deactivated", `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`],
    ])("approve: a committed %s initiator is refused with 409 RESET_NOT_APPROVABLE, approved_at unwritten", async (_label, change) => {
      const actorId = await member("OWNER");
      const initiator = await member("ADMIN");
      const target = await member("MEMBER");
      const reset = await resetRow({ initiatedBy: initiator, target });
      await sql(change, tenantId, initiator);
      const cookie = await login(actorId);

      const res = await approveReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${target}/reset-vault/${reset}/approve`), {
        params: Promise.resolve({ userId: target, resetId: reset }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("RESET_NOT_APPROVABLE");
      expect(await count("admin_vault_resets", "id = $1::uuid AND approved_at IS NULL", reset)).toBe(1);
    });
  });

  // ─── Departure race (T3-1) and the containment fence ──────────────────

  describe("departure and containment race the mint through the real production writers", () => {
    const departure = { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } };

    it("SA token mint: the actor's departure holds the tenant row; the mint waits, then 403, no token", async () => {
      // An ADMIN: departFromTenant never departs an OWNER.
      const actorId = await member("ADMIN");
      const sa = await serviceAccount(actorId);
      const cookie = await login(actorId);
      const held = await holdPrismaWriter(
        ctx.su.prisma,
        async (tx) => {
          await setBypassRlsGucs(tx);
          await departFromTenant(tx, tenantId, [actorId], departure);
        },
        HELD_TX_TIMEOUT_MS,
      );

      const res = await runBlockedBy(held, () =>
        mintSaToken(
          requestWithSession(cookie, `${BASE}/api/tenant/service-accounts/${sa}/tokens`, {
            body: { name: "t", scope: ["passwords:read"], expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
          }),
          idParams(sa),
        ),
      );
      expect(res.status).toBe(403);
      expect(await count("service_account_tokens", "service_account_id = $1::uuid", sa)).toBe(0);
    });

    it("reset approve: the initiator's departure holds their row; approve waits, then 409 RESET_NOT_APPROVABLE, approved_at unwritten", async () => {
      const actorId = await member("OWNER");
      const initiator = await member("ADMIN");
      const target = await member("MEMBER");
      const reset = await resetRow({ initiatedBy: initiator, target });
      const cookie = await login(actorId);
      const held = await holdPrismaWriter(
        ctx.su.prisma,
        async (tx) => {
          await setBypassRlsGucs(tx);
          await departFromTenant(tx, tenantId, [initiator], departure);
        },
        HELD_TX_TIMEOUT_MS,
      );

      // The departure also revokes the pending reset (C4); the blocked
      // observation before release is what shows the gate ordered the approve.
      const res = await runBlockedBy(held, () =>
        approveReset(requestWithSession(cookie, `${BASE}/api/tenant/members/${target}/reset-vault/${reset}/approve`), {
          params: Promise.resolve({ userId: target, resetId: reset }),
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("RESET_NOT_APPROVABLE");
      expect(await count("admin_vault_resets", "id = $1::uuid AND approved_at IS NULL", reset)).toBe(1);
    });

    it("containment fence: a revocation holding the actor's credential lock parks the mint; after it commits the mint answers 401, no token", async () => {
      const actorId = await member("ADMIN");
      const sa = await serviceAccount(actorId);
      const cookie = await login(actorId);
      const held = await holdPrismaWriter(
        ctx.su.prisma,
        async (tx) => {
          await setBypassRlsGucs(tx);
          // The primitive containment runs under the credential lock.
          await revokeUsersAuthArtifactsInTx(tx, [actorId], { tenantFilter: {} });
        },
        HELD_TX_TIMEOUT_MS,
      );

      const res = await runBlockedBy(held, () =>
        mintSaToken(
          requestWithSession(cookie, `${BASE}/api/tenant/service-accounts/${sa}/tokens`, {
            body: { name: "t", scope: ["passwords:read"], expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
          }),
          idParams(sa),
        ),
      );
      expect(res.status).toBe(401);
      expect(await count("service_account_tokens", "service_account_id = $1::uuid", sa)).toBe(0);
    });
  });
});
