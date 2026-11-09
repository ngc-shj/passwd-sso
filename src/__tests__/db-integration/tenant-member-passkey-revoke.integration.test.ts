/**
 * Integration test (real DB): a tenant admin lists and revokes a member's
 * passkey (#974) — `GET /api/tenant/members/[userId]/passkeys` and
 * `DELETE .../passkeys/[credentialId]` — and contains a member (#1016): revoke-
 * all with no passkeys, and the optional body that unlinks accounts and revokes
 * the footholds the member created. The routes, the tenant RLS reads, the
 * session/token invalidation and the audit outbox are real; only `auth()`, the
 * step-up check, mail and the rate limiters are mocked.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- tenant-member-passkey-revoke
 *   docker compose start audit-outbox-worker retention-gc-worker
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { appConnectionString, createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createPool } from "@/lib/db/pool-factory";

const { mockAuth, mockSendEmail, stepUp } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSendEmail: vi.fn(),
  // When set, the step-up check refuses with this status.
  stepUp: { refuseWith: null as number | null },
}));
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
// No real mail from a test run; the send is asserted instead.
vi.mock("@/lib/email", () => ({ sendEmail: (...args: unknown[]) => mockSendEmail(...args) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireRecentCurrentAuthMethod: async () =>
      stepUp.refuseWith === null
        ? null
        : NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: stepUp.refuseWith }),
  };
});

import { GET as listPasskeys } from "@/app/api/tenant/members/[userId]/passkeys/route";
import { DELETE as revokePasskey } from "@/app/api/tenant/members/[userId]/passkeys/[credentialId]/route";
import { DELETE as revokeAllPasskeys } from "@/app/api/tenant/members/[userId]/passkeys/route";
import { POST as approveAccessRequest } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { POST as requestEmergencyAccess } from "@/app/api/emergency-access/[id]/request/route";
import { GET as readEmergencyVault } from "@/app/api/emergency-access/[id]/vault/route";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { hashToken } from "@/lib/crypto/crypto-server";
import { validateServiceAccountToken } from "@/lib/auth/tokens/service-account-token";
import { validateMcpToken } from "@/lib/mcp/oauth-server";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

describe("tenant admin revokes a member's passkey — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    stepUp.refuseWith = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Rows one tenant's user created under the other tenant hold RESTRICT FKs
    // to that user (service_accounts, mcp_clients, break-glass requester), so
    // they go before either tenant's users.
    for (const table of [
      "mcp_refresh_tokens", "mcp_access_tokens", "mcp_clients", "service_account_tokens", "service_accounts",
      "personal_log_access_grants", "scim_tokens", "emergency_access_key_pairs", "emergency_access_grants", "accounts",
    ]) {
      await sql(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenantId, otherTenantId]);
    }
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A tenant member (createUser makes OWNERs). */
  async function memberWithRole(role: "OWNER" | "ADMIN" | "MEMBER", tenant = tenantId): Promise<string> {
    const id = await ctx.createUser(tenant);
    if (role !== "OWNER") await sql(`UPDATE tenant_members SET role = $2::"TenantRole" WHERE user_id = $1::uuid`, id, role);
    return id;
  }

  async function passkey(userId: string, tenant = tenantId): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO webauthn_credentials (id, user_id, tenant_id, credential_id, public_key, device_type, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pk', 'singleDevice', now())`,
      id, userId, tenant, `cred-${randomUUID()}`,
    );
    return id;
  }

  /** A session signed in with the passkey, and an extension token minted from it. */
  async function signedInWith(userId: string, credentialId: string | null, tenant = tenantId): Promise<{ sessionId: string; tokenId: string }> {
    const sessionId = randomUUID();
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider, auth_credential_id)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now(), 'webauthn', $5::uuid)`,
      sessionId, hashSessionToken(randomUUID()), userId, tenant, credentialId,
    );
    const tokenId = randomUUID();
    await sql(
      `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, created_at, family_id, family_created_at, cnf_jkt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'passwords:read', now() + interval '1 day', now(), $5::uuid, now(), $6)`,
      tokenId, userId, tenant, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), randomUUID(), "j".repeat(43),
    );
    return { sessionId, tokenId };
  }

  async function revokeAs(actor: string, userId: string, credentialId: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await revokePasskey(
      new NextRequest(`http://localhost/api/tenant/members/${userId}/passkeys/${credentialId}`, { method: "DELETE" }),
      { params: Promise.resolve({ userId, credentialId }) },
    );
    return res.status;
  }

  async function listAs(actor: string, userId: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await listPasskeys(new NextRequest(`http://localhost/api/tenant/members/${userId}/passkeys`), {
      params: Promise.resolve({ userId }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as { passkeys?: { id: string }[] } | null };
  }

  async function exists(table: "webauthn_credentials" | "sessions", id: string): Promise<boolean> {
    const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1::uuid`, id);
    return row.n === 1;
  }

  async function tokenRevoked(id: string): Promise<boolean> {
    const [row] = await sql<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM extension_tokens WHERE id = $1::uuid`, id);
    return row.revoked;
  }

  it.each([
    ["an OWNER revokes a MEMBER's", "OWNER", "MEMBER"],
    ["an OWNER revokes an ADMIN's", "OWNER", "ADMIN"],
    ["an ADMIN revokes a MEMBER's", "ADMIN", "MEMBER"],
    ["an OWNER revokes another OWNER's", "OWNER", "OWNER"],
  ] as const)("%s only passkey: it is deleted, the member is signed out of every tenant, and it is audited", async (_label, actorRole, targetRole) => {
    const actor = await memberWithRole(actorRole);
    const target = await memberWithRole(targetRole);
    const credential = await passkey(target);
    const signedIn = await signedInWith(target, credential);
    // Elsewhere: the passkey is user-global, so the member's session and token
    // under another tenant end too.
    await sql(`INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`, randomUUID(), otherTenantId, target);
    const elsewhere = await signedInWith(target, null, otherTenantId);

    const listed = await listAs(actor, target);
    expect(listed.status).toBe(200);
    expect(listed.body?.passkeys?.map((p) => p.id)).toEqual([credential]);

    expect(await revokeAs(actor, target, credential)).toBe(200);

    expect(await exists("webauthn_credentials", credential)).toBe(false);
    expect(await exists("sessions", signedIn.sessionId)).toBe(false);
    expect(await tokenRevoked(signedIn.tokenId)).toBe(true);
    expect(await exists("sessions", elsewhere.sessionId)).toBe(false);
    expect(await tokenRevoked(elsewhere.tokenId)).toBe(true);

    const [audit] = await sql<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload::text LIKE '%TENANT_MEMBER_PASSKEY_REVOKE%'`,
      tenantId,
    );
    const [{ credential_id: publicId }] = await sql<{ credential_id: string }>(
      `SELECT payload->'metadata'->>'credentialId' AS credential_id FROM audit_outbox WHERE tenant_id = $1::uuid AND payload::text LIKE '%TENANT_MEMBER_PASSKEY_REVOKE%'`,
      tenantId,
    );
    expect(publicId).toMatch(/^cred-/);
    expect(JSON.parse(audit.payload)).toMatchObject({
      action: "TENANT_MEMBER_PASSKEY_REVOKE",
      userId: actor,
      targetId: credential,
      metadata: { targetUserId: target, registeredInTenant: true, sessions: 2, extensionTokens: 2 },
    });
    // The member is told (the notification is written after the response, so
    // poll for it).
    await vi.waitFor(async () => {
      const notices = await sql<{ type: string }>(
        `SELECT type::text FROM notifications WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        target, tenantId,
      );
      expect(notices).toEqual([{ type: "SECURITY_ALERT" }]);
    }, { timeout: 5000 });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("revoking all of a member's passkeys deletes every one, in every tenant, signs them out everywhere, and is audited once", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const here = await passkey(target);
    // One registered under a previous tenant: user-global, so it goes too.
    await sql(`INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`, randomUUID(), otherTenantId, target);
    const there = await passkey(target, otherTenantId);
    const signedIn = await signedInWith(target, here);
    const elsewhere = await signedInWith(target, there, otherTenantId);
    // Another member's passkey is not touched.
    const bystander = await passkey(await memberWithRole("MEMBER"));

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const res = await revokeAllPasskeys(
      new NextRequest(`http://localhost/api/tenant/members/${target}/passkeys`, {
        method: "DELETE",
        // The admin's request metadata, which the other tenant's row must not carry.
        headers: { "user-agent": "admin-agent/1.0" },
      }),
      { params: Promise.resolve({ userId: target }) },
    );
    expect(res.status).toBe(200);

    expect(await exists("webauthn_credentials", here)).toBe(false);
    expect(await exists("webauthn_credentials", there)).toBe(false);
    expect(await exists("webauthn_credentials", bystander)).toBe(true);
    expect(await exists("sessions", signedIn.sessionId)).toBe(false);
    expect(await exists("sessions", elsewhere.sessionId)).toBe(false);
    expect(await tokenRevoked(signedIn.tokenId)).toBe(true);
    expect(await tokenRevoked(elsewhere.tokenId)).toBe(true);

    const audits = await sql<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload::text LIKE '%TENANT_MEMBER_PASSKEY_REVOKE%'`,
      tenantId,
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].payload)).toMatchObject({ userId: owner, userAgent: "admin-agent/1.0" });
    expect(JSON.parse(audits[0].payload)).toMatchObject({
      action: "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
      userId: owner,
      targetId: target,
      metadata: { targetUserId: target, passkeys: 2, sessions: 2, extensionTokens: 2 },
    });
    expect(JSON.parse(audits[0].payload).metadata.credentialIds).toHaveLength(2);
    // The tenant the other passkey was registered under sees it in its own log.
    const elsewhereAudits = await sql<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload::text LIKE '%TENANT_MEMBER_PASSKEY_REVOKE_ALL%'`,
      otherTenantId,
    );
    expect(elsewhereAudits).toHaveLength(1);
    // (Selected by the row's tenant_id; the payload does not repeat it.)
    const elsewhere0 = JSON.parse(elsewhereAudits[0].payload);
    expect(elsewhere0).toMatchObject({
      action: "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
      userId: SYSTEM_ACTOR_ID,
      actorType: "SYSTEM",
      ip: null,
      userAgent: null,
      metadata: { targetUserId: target, passkeys: 1, revokedFromTenantId: tenantId },
    });
    // None of the revoking tenant's view: not its admin, not counts across tenants.
    expect(elsewhere0.metadata.sessions).toBeUndefined();
    expect(elsewhere0.metadata.credentialIds).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("a stale session's step-up refusal stops the revoke: the passkey and the sessions stay", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const credential = await passkey(target);
    const signedIn = await signedInWith(target, credential);
    stepUp.refuseWith = 403;

    expect(await revokeAs(owner, target, credential)).toBe(403);

    expect(await exists("webauthn_credentials", credential)).toBe(true);
    expect(await exists("sessions", signedIn.sessionId)).toBe(true);
    expect(await tokenRevoked(signedIn.tokenId)).toBe(false);
  });

  it("a passkey the member registered under a previous tenant is listed (marked) and revocable", async () => {
    const owner = await memberWithRole("OWNER");
    const member = await memberWithRole("MEMBER");
    const here = await passkey(member);
    const previous = await passkey(member, otherTenantId);

    const listed = await listAs(owner, member);
    expect(listed.status).toBe(200);
    expect(
      Object.fromEntries((listed.body?.passkeys as { id: string; registeredInTenant: boolean }[]).map((p) => [p.id, p.registeredInTenant])),
    ).toEqual({ [here]: true, [previous]: false });

    expect(await revokeAs(owner, member, previous)).toBe(200);
    expect(await exists("webauthn_credentials", previous)).toBe(false);
    expect(await exists("webauthn_credentials", here)).toBe(true);
  });

  it.each([
    ["an ADMIN on another ADMIN", "ADMIN", "ADMIN", 403],
    ["an ADMIN on the OWNER", "ADMIN", "OWNER", 403],
    ["a MEMBER on another MEMBER", "MEMBER", "MEMBER", 403],
    ["an OWNER on themselves", "OWNER", "SELF", 403],
  ] as const)("refuses %s; the passkey and the sessions stay", async (_label, actorRole, targetRole, status) => {
    const actor = await memberWithRole(actorRole);
    const target = targetRole === "SELF" ? actor : await memberWithRole(targetRole);
    const credential = await passkey(target);
    const signedIn = await signedInWith(target, credential);

    expect(await revokeAs(actor, target, credential)).toBe(status);
    expect((await listAs(actor, target)).status).toBe(status);

    expect(await exists("webauthn_credentials", credential)).toBe(true);
    expect(await exists("sessions", signedIn.sessionId)).toBe(true);
  });

  it("an OWNER cannot reach a member of another tenant (404 on list and revoke), nor another member's passkey by id", async () => {
    const owner = await memberWithRole("OWNER");
    const foreignMember = await memberWithRole("MEMBER", otherTenantId);
    const foreignCredential = await passkey(foreignMember, otherTenantId);
    expect(await revokeAs(owner, foreignMember, foreignCredential)).toBe(404);
    expect((await listAs(owner, foreignMember)).status).toBe(404);
    expect(await exists("webauthn_credentials", foreignCredential)).toBe(true);

    const member = await memberWithRole("MEMBER");
    // Another member's credential id under this member's path: 404.
    const someoneElse = await memberWithRole("MEMBER");
    const theirs = await passkey(someoneElse);
    expect(await revokeAs(owner, member, theirs)).toBe(404);
    expect(await exists("webauthn_credentials", theirs)).toBe(true);
  });

  it("the per-credential revoke still answers its own response, with no `contained`", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const credential = await passkey(target);
    await signedInWith(target, credential);
    mockAuth.mockResolvedValue({ user: { id: owner } });

    const res = await revokePasskey(
      new NextRequest(`http://localhost/api/tenant/members/${target}/passkeys/${credential}`, { method: "DELETE" }),
      { params: Promise.resolve({ userId: target, credentialId: credential }) },
    );
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 1, cacheTombstoneFailures: 0 });
  });

  // ─── Containment (#1016) ──────────────────────────────────

  const hex = () => randomBytes(32).toString("hex");

  async function oidcSignIn(userId: string, tenant = tenantId): Promise<{ sessionId: string; tokenId: string }> {
    const sessionId = randomUUID();
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now(), 'oidc')`,
      sessionId, hashSessionToken(randomUUID()), userId, tenant,
    );
    const tokenId = randomUUID();
    await sql(
      `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, created_at, family_id, family_created_at, cnf_jkt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'passwords:read', now() + interval '1 day', now(), $5::uuid, now(), $6)`,
      tokenId, userId, tenant, hex(), randomUUID(), "j".repeat(43),
    );
    return { sessionId, tokenId };
  }

  async function account(userId: string, tenant = tenantId, provider = "google"): Promise<{ id: string; providerAccountId: string; accessToken: string; refreshToken: string }> {
    const row = { id: randomUUID(), providerAccountId: `pai-${randomUUID()}`, accessToken: `at-${hex()}`, refreshToken: `rt-${hex()}` };
    await sql(
      `INSERT INTO accounts (id, user_id, tenant_id, type, provider, provider_account_id, access_token, refresh_token)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'oidc', $4, $5, $6, $7)`,
      row.id, userId, tenant, provider, row.providerAccountId, row.accessToken, row.refreshToken,
    );
    return row;
  }

  type Liveness = "live" | "dead";

  async function scimToken(creator: string | null, tenant = tenantId, state: Liveness | "expired" = "live"): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO scim_tokens (id, tenant_id, token_hash, created_by_id, expires_at, revoked_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid,
               CASE WHEN $5 = 'expired' THEN now() - interval '1 day' ELSE NULL END,
               CASE WHEN $5 = 'dead' THEN now() - interval '1 hour' ELSE NULL END, now())`,
      id, tenant, hex(), creator, state,
    );
    return id;
  }

  async function serviceAccount(creator: string, tenant = tenantId, state: Liveness = "live"): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, now(), now())`,
      id, tenant, `sa-${id.slice(0, 8)}`, creator, state === "live",
    );
    return id;
  }

  /** A token on `sa` (in `tenant`); returns its id and plaintext. */
  async function saToken(sa: string, creator: string | null, tenant = tenantId, state: Liveness | "expired" = "live"): Promise<{ id: string; plaintext: string }> {
    const id = randomUUID();
    const plaintext = `sa_${hex()}`;
    await sql(
      `INSERT INTO service_account_tokens (id, service_account_id, tenant_id, token_hash, prefix, name, scope, expires_at, revoked_at, created_by_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'passwords:read',
               CASE WHEN $7 = 'expired' THEN now() - interval '1 day' ELSE now() + interval '1 day' END,
               CASE WHEN $7 = 'dead' THEN now() - interval '1 hour' ELSE NULL END, $8::uuid, now())`,
      id, sa, tenant, hashToken(plaintext), plaintext.slice(0, 7), `tok-${id.slice(0, 8)}`, state, creator,
    );
    return { id, plaintext };
  }

  async function mcpClient(creator: string, tenant = tenantId, state: Liveness = "live"): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, '', $4, ARRAY['http://localhost/cb']::text[], 'credentials:list', $5, $6::uuid, now(), now())`,
      id, tenant, `cli-${id.slice(0, 16)}`, `mcp-${id.slice(0, 8)}`, state === "live", creator,
    );
    return id;
  }

  /** An access token of `client`, held by `userId` (not the member being contained). */
  async function mcpAccessToken(client: string, userId: string, tenant = tenantId): Promise<string> {
    const plaintext = `mcp_${hex()}`;
    await sql(
      `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'credentials:list', now() + interval '1 day', now())`,
      randomUUID(), hashToken(plaintext), client, tenant, userId,
    );
    return plaintext;
  }

  async function breakglassGrant(
    requester: string,
    subject: string,
    tenant = tenantId,
    state: Liveness | "expired" | "future" = "live",
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO personal_log_access_grants (id, tenant_id, requester_id, target_user_id, reason, expires_at, effective_at, revoked_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'incident review',
               CASE WHEN $5 = 'expired' THEN now() - interval '1 hour' ELSE now() + interval '1 day' END,
               CASE WHEN $5 = 'future' THEN now() + interval '1 hour' ELSE NULL END,
               CASE WHEN $5 = 'dead' THEN now() - interval '1 hour' ELSE NULL END, now())`,
      id, tenant, requester, subject, state,
    );
    return id;
  }

  async function emergencyGrant(
    owner: string,
    tenant = tenantId,
    { status = "ACCEPTED", escrow = false, grantee = null }: { status?: string; escrow?: boolean; grantee?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO emergency_access_grants (
         id, tenant_id, owner_id, grantee_id, grantee_email, status, wait_days, token_hash, token_expires_at,
         encrypted_secret_key, secret_key_iv, secret_key_auth_tag, hkdf_salt, owner_ephemeral_public_key,
         activated_at, revoked_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::"EmergencyAccessStatus", 7, $7, now() + interval '30 days',
               $8, $9, $10, $11, $12,
               CASE WHEN $6 = 'ACTIVATED' THEN now() ELSE NULL END,
               CASE WHEN $6 = 'REVOKED' THEN now() ELSE NULL END, now(), now())`,
      id, tenant, owner, grantee, `contact-${id.slice(0, 6)}@example.net`, status, hex(),
      escrow ? "esk" : null, escrow ? "a".repeat(24) : null, escrow ? "b".repeat(32) : null,
      escrow ? "c".repeat(64) : null, escrow ? "epk" : null,
    );
    if (escrow && grantee) {
      await sql(
        `INSERT INTO emergency_access_key_pairs (id, grant_id, tenant_id, encrypted_private_key, private_key_iv, private_key_auth_tag, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'epk', $4, $5, now())`,
        randomUUID(), id, tenant, "d".repeat(24), "e".repeat(32),
      );
    }
    return id;
  }

  /** The row as JSON text, to show a skipped row is byte-unchanged. */
  async function rowText(table: string, id: string): Promise<string> {
    const [row] = await sql<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM ${table} t WHERE id = $1::uuid`, id);
    return row.r;
  }

  async function auditRows(tenant: string): Promise<{ action: string; userId: string; actorType: string; targetId: string; metadata: Record<string, unknown> }[]> {
    const rows = await sql<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at, id`,
      tenant,
    );
    return rows.map((r) => JSON.parse(r.payload));
  }

  async function containAs(actor: string, userId: string, body?: unknown) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return revokeAllPasskeys(
      new NextRequest(`http://localhost/api/tenant/members/${userId}/passkeys`, {
        method: "DELETE",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ userId }) },
    );
  }

  async function listRaw(actor: string, userId: string): Promise<{ status: number; text: string }> {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await listPasskeys(new NextRequest(`http://localhost/api/tenant/members/${userId}/passkeys`), {
      params: Promise.resolve({ userId }),
    });
    return { status: res.status, text: await res.text() };
  }

  /** A member of this tenant who is also a (deactivated) member of the other. */
  async function alsoMemberElsewhere(userId: string): Promise<void> {
    await sql(`INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`, randomUUID(), otherTenantId, userId);
  }

  it("cell 1: revoke-all on an SSO-only member (no passkeys) ends their session and token, audited with passkeys 0", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const signedIn = await oidcSignIn(target);

    const res = await containAs(owner, target);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 1, cacheTombstoneFailures: 0 });
    expect(await exists("sessions", signedIn.sessionId)).toBe(false);
    expect(await tokenRevoked(signedIn.tokenId)).toBe(true);

    const [revokeAll] = (await auditRows(tenantId)).filter((r) => r.action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL");
    expect(revokeAll.metadata).toMatchObject({ targetUserId: target, passkeys: 0, credentialIds: [], sessions: 1, extensionTokens: 1 });
    await vi.waitFor(async () => {
      const notices = await sql<{ title: string }>(`SELECT title FROM notifications WHERE user_id = $1::uuid`, target);
      expect(notices).toHaveLength(1);
    }, { timeout: 5000 });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("cell 1: a member deactivated here, active and owned in another tenant, is refused 404 on GET and DELETE; nothing of theirs changes", async () => {
    const owner = await memberWithRole("OWNER");
    // Owned by the other tenant, active there; this tenant's row is deactivated.
    const departed = await ctx.createUser(otherTenantId);
    await sql(`INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADMIN', now(), now(), now())`, randomUUID(), tenantId, departed);
    const credential = await passkey(departed, otherTenantId);
    const linked = await account(departed, otherTenantId);
    const grant = await emergencyGrant(departed, otherTenantId, { status: "IDLE" });
    const session = await oidcSignIn(departed, otherTenantId);
    const before = { credential: await rowText("webauthn_credentials", credential), account: await rowText("accounts", linked.id), grant: await rowText("emergency_access_grants", grant) };

    expect((await listRaw(owner, departed)).status).toBe(404);
    const res = await containAs(owner, departed, { unlinkAccountIds: [linked.id], revoke: { emergencyAccessGrantIds: [grant] } });
    expect(res.status).toBe(404);

    expect(await rowText("webauthn_credentials", credential)).toBe(before.credential);
    expect(await rowText("accounts", linked.id)).toBe(before.account);
    expect(await rowText("emergency_access_grants", grant)).toBe(before.grant);
    expect(await exists("sessions", session.sessionId)).toBe(true);
    expect((await auditRows(tenantId)).filter((r) => r.action.startsWith("TENANT_MEMBER_PASSKEY"))).toEqual([]);
  });

  it("cell 2: GET lists exactly the target's linked accounts and live footholds, never an account's provider id or tokens", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("ADMIN");
    const bystander = await memberWithRole("ADMIN");
    await alsoMemberElsewhere(target);

    const here = await account(target);
    const there = await account(target, otherTenantId, "saml-jackson");
    await account(bystander);

    const scim = { live: await scimToken(target), bystander: await scimToken(bystander), elsewhere: await scimToken(target, otherTenantId),
      revoked: await scimToken(target, tenantId, "dead"), expired: await scimToken(target, tenantId, "expired"), unowned: await scimToken(null) };
    const sa = { live: await serviceAccount(target), bystander: await serviceAccount(bystander), elsewhere: await serviceAccount(target, otherTenantId),
      inactive: await serviceAccount(target, tenantId, "dead") };
    // Tokens the target minted on a bystander's service account count; the
    // bystander's on the target's do not.
    const saTok = { live: await saToken(sa.bystander, target), bystander: await saToken(sa.live, bystander),
      elsewhere: await saToken(sa.elsewhere, target, otherTenantId), revoked: await saToken(sa.bystander, target, tenantId, "dead"),
      expired: await saToken(sa.bystander, target, tenantId, "expired"), unowned: await saToken(sa.bystander, null) };
    const mcp = { live: await mcpClient(target), bystander: await mcpClient(bystander), elsewhere: await mcpClient(target, otherTenantId),
      inactive: await mcpClient(target, tenantId, "dead") };
    const bg = { live: await breakglassGrant(target, bystander), future: await breakglassGrant(target, bystander, tenantId, "future"),
      bystander: await breakglassGrant(bystander, target), elsewhere: await breakglassGrant(target, bystander, otherTenantId),
      revoked: await breakglassGrant(target, bystander, tenantId, "dead"), expired: await breakglassGrant(target, bystander, tenantId, "expired") };
    // Emergency-access grants are the user's: one filed under the other tenant is listed too.
    const ea = { here: await emergencyGrant(target, tenantId, { status: "IDLE", escrow: true }), there: await emergencyGrant(target, otherTenantId),
      bystander: await emergencyGrant(bystander), revoked: await emergencyGrant(target, tenantId, { status: "REVOKED" }),
      rejected: await emergencyGrant(target, tenantId, { status: "REJECTED" }) };

    const { status, text } = await listRaw(owner, target);
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.linkedAccounts).toEqual(
      expect.arrayContaining([
        { id: here.id, provider: "google", linkedInTenant: true },
        { id: there.id, provider: "saml-jackson", linkedInTenant: false },
      ]),
    );
    expect(body.linkedAccounts).toHaveLength(2);
    for (const secret of [here.providerAccountId, here.accessToken, here.refreshToken, there.providerAccountId, there.accessToken]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/providerAccountId|access_token|refresh_token|encryptedSecretKey|tokenHash/);

    const ids = (kind: string) => (body.createdFootholds[kind] as { id: string }[]).map((r) => r.id).sort();
    expect(ids("scimTokens")).toEqual([scim.live]);
    expect(ids("serviceAccounts")).toEqual([sa.live]);
    expect(ids("serviceAccountTokens")).toEqual([saTok.live.id]);
    expect(ids("mcpClients")).toEqual([mcp.live]);
    expect(ids("breakglassGrants")).toEqual([bg.live, bg.future].sort());
    expect(ids("emergencyAccessGrants")).toEqual([ea.here, ea.there].sort());
    expect(body.createdFootholds.emergencyAccessGrants.find((g: { id: string }) => g.id === ea.here)).toMatchObject({ hasEscrow: true, status: "IDLE" });
    expect(body.createdFootholds.serviceAccountTokens[0]).toMatchObject({ serviceAccount: { name: expect.any(String) } });
  });

  // Cell 3: one request per kind names a live row of the target's (revoked —
  // the positive control), a bystander's same-tenant row, the target's row in
  // another tenant (tenant-owned kinds), an already-revoked row and, for SCIM,
  // a token with no creator; only the first is written.
  type KindCase = {
    bodyKey: string;
    kind: string;
    table: string;
    action: string;
    seed: (ids: { target: string; bystander: string }) => Promise<{ live: string; skipped: string[]; dead: string }>;
    deadColumn: string;
    written: (id: string) => Promise<boolean>;
  };
  const isRevoked = (table: string) => async (id: string) =>
    (await sql<{ v: boolean }>(`SELECT revoked_at IS NOT NULL AS v FROM ${table} WHERE id = $1::uuid`, id))[0].v;
  const isInactive = (table: string) => async (id: string) =>
    (await sql<{ v: boolean }>(`SELECT NOT is_active AS v FROM ${table} WHERE id = $1::uuid`, id))[0].v;
  const KIND_CASES: KindCase[] = [
    {
      bodyKey: "scimTokenIds", kind: "scimTokens", table: "scim_tokens", action: "SCIM_TOKEN_REVOKE", deadColumn: "revoked_at",
      written: isRevoked("scim_tokens"),
      seed: async ({ target, bystander }) => ({
        live: await scimToken(target),
        skipped: [await scimToken(bystander), await scimToken(target, otherTenantId), await scimToken(null)],
        dead: await scimToken(target, tenantId, "dead"),
      }),
    },
    {
      bodyKey: "serviceAccountIds", kind: "serviceAccounts", table: "service_accounts", action: "SERVICE_ACCOUNT_UPDATE", deadColumn: "is_active",
      written: isInactive("service_accounts"),
      seed: async ({ target, bystander }) => ({
        live: await serviceAccount(target),
        skipped: [await serviceAccount(bystander), await serviceAccount(target, otherTenantId)],
        dead: await serviceAccount(target, tenantId, "dead"),
      }),
    },
    {
      bodyKey: "serviceAccountTokenIds", kind: "serviceAccountTokens", table: "service_account_tokens", action: "SERVICE_ACCOUNT_TOKEN_REVOKE", deadColumn: "revoked_at",
      written: isRevoked("service_account_tokens"),
      seed: async ({ target, bystander }) => {
        const sa = await serviceAccount(bystander);
        const elsewhereSa = await serviceAccount(bystander, otherTenantId);
        return {
          live: (await saToken(sa, target)).id,
          skipped: [(await saToken(sa, bystander)).id, (await saToken(elsewhereSa, target, otherTenantId)).id, (await saToken(sa, null)).id],
          dead: (await saToken(sa, target, tenantId, "dead")).id,
        };
      },
    },
    {
      bodyKey: "mcpClientIds", kind: "mcpClients", table: "mcp_clients", action: "MCP_CLIENT_UPDATE", deadColumn: "is_active",
      written: isInactive("mcp_clients"),
      seed: async ({ target, bystander }) => ({
        live: await mcpClient(target),
        skipped: [await mcpClient(bystander), await mcpClient(target, otherTenantId)],
        dead: await mcpClient(target, tenantId, "dead"),
      }),
    },
    {
      bodyKey: "breakglassGrantIds", kind: "breakglassGrants", table: "personal_log_access_grants", action: "PERSONAL_LOG_ACCESS_REVOKE", deadColumn: "revoked_at",
      written: isRevoked("personal_log_access_grants"),
      seed: async ({ target, bystander }) => ({
        live: await breakglassGrant(target, bystander),
        skipped: [await breakglassGrant(bystander, target), await breakglassGrant(target, bystander, otherTenantId)],
        dead: await breakglassGrant(target, bystander, tenantId, "dead"),
      }),
    },
    {
      bodyKey: "emergencyAccessGrantIds", kind: "emergencyAccessGrants", table: "emergency_access_grants", action: "EMERGENCY_ACCESS_REVOKE", deadColumn: "revoked_at",
      written: async (id) => (await sql<{ s: string }>(`SELECT status::text AS s FROM emergency_access_grants WHERE id = $1::uuid`, id))[0].s === "REVOKED",
      // The user's grants, wherever filed: no other-tenant skip row for this kind.
      seed: async ({ target, bystander }) => ({
        live: await emergencyGrant(target, tenantId, { status: "IDLE", escrow: true }),
        skipped: [await emergencyGrant(bystander, tenantId, { status: "IDLE", escrow: true })],
        dead: await emergencyGrant(target, tenantId, { status: "REVOKED" }),
      }),
    },
  ];

  it.each(KIND_CASES)("cell 3 ($kind): only the target's live row in this tenant is written; the rest are byte-unchanged and counted as skipped", async ({ bodyKey, kind, table, action, seed, deadColumn, written }) => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("ADMIN");
    const bystander = await memberWithRole("ADMIN");
    await alsoMemberElsewhere(target);
    const { live, skipped, dead } = await seed({ target, bystander });
    const before = Object.fromEntries(await Promise.all(skipped.map(async (id) => [id, await rowText(table, id)] as const)));
    const [deadBefore] = await sql<{ v: string }>(`SELECT ${deadColumn}::text AS v FROM ${table} WHERE id = $1::uuid`, dead);

    const res = await containAs(owner, target, { revoke: { [bodyKey]: [live, ...skipped, dead] } });
    expect(res.status).toBe(200);
    expect((await res.json()).contained).toEqual({ [kind]: { revoked: 1, skipped: skipped.length + 1 } });

    expect(await written(live)).toBe(true);
    for (const id of skipped) expect(await rowText(table, id)).toBe(before[id]);
    const [deadAfter] = await sql<{ v: string }>(`SELECT ${deadColumn}::text AS v FROM ${table} WHERE id = $1::uuid`, dead);
    expect(deadAfter.v).toBe(deadBefore.v);

    const rows = (await auditRows(tenantId)).filter((r) => r.action === action);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner });
    const revokeAll = (await auditRows(tenantId)).find((r) => r.action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL");
    expect(revokeAll?.metadata).toMatchObject({ [`${kind}Contained`]: 1, [`${kind}Skipped`]: skipped.length + 1 });
  });

  it("cell 3: a contained service account's tokens are refused by the production validator; a contained MCP client's access token too", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("ADMIN");
    const bystander = await memberWithRole("ADMIN");
    const sa = await serviceAccount(target);
    // Minted by a bystander: refused only because its service account is contained.
    const token = await saToken(sa, bystander);
    const client = await mcpClient(target);
    const access = await mcpAccessToken(client, bystander);
    const bearer = (t: string) => new NextRequest("http://localhost/api/v1/passwords", { headers: { authorization: `Bearer ${t}` } });
    expect((await validateServiceAccountToken(bearer(token.plaintext))).ok).toBe(true);
    expect((await validateMcpToken(access)).ok).toBe(true);

    const res = await containAs(owner, target, { revoke: { serviceAccountIds: [sa], mcpClientIds: [client] } });
    expect(res.status).toBe(200);

    expect(await validateServiceAccountToken(bearer(token.plaintext))).toMatchObject({ ok: false, error: "SA_TOKEN_REVOKED" });
    expect(await validateMcpToken(access)).toMatchObject({ ok: false, error: "token_revoked" });
    const audits = await auditRows(tenantId);
    expect(audits.find((r) => r.action === "SERVICE_ACCOUNT_UPDATE")?.metadata).toMatchObject({ isActive: false, tokensRevoked: 1 });
    expect(audits.find((r) => r.action === "MCP_CLIENT_UPDATE")?.metadata).toMatchObject({ isActive: false, tokensRevoked: 1 });
  });

  it("cell 3: unlinking removes only the named accounts of the target; the other tenant's revoke-all row counts the one filed there", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const bystander = await memberWithRole("MEMBER");
    await alsoMemberElsewhere(target);
    const here = await account(target);
    const there = await account(target, otherTenantId, "saml-jackson");
    const kept = await account(target, tenantId, "github");
    const theirs = await account(bystander);
    const theirsBefore = await rowText("accounts", theirs.id);

    const res = await containAs(owner, target, { unlinkAccountIds: [here.id, there.id, theirs.id] });
    expect((await res.json()).contained).toEqual({ accounts: { revoked: 2, skipped: 1 } });
    const remaining = await sql<{ id: string }>(`SELECT id FROM accounts WHERE user_id = $1::uuid`, target);
    expect(remaining.map((r) => r.id)).toEqual([kept.id]);
    expect(await rowText("accounts", theirs.id)).toBe(theirsBefore);

    const revokeAll = (await auditRows(tenantId)).find((r) => r.action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL");
    expect(revokeAll?.metadata).toMatchObject({ accountsContained: 2, accountsSkipped: 1, unlinkedAccountIdsOmitted: 0 });
    expect((revokeAll?.metadata.unlinkedAccountIds as string[]).sort()).toEqual([here.id, there.id].sort());
    // The other tenant, reached only through the account: one SYSTEM row, its own count.
    const elsewhere = (await auditRows(otherTenantId)).filter((r) => r.action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL");
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]).toMatchObject({
      userId: SYSTEM_ACTOR_ID,
      actorType: "SYSTEM",
      metadata: { targetUserId: target, passkeys: 0, accountsUnlinked: 1, revokedFromTenantId: tenantId },
    });
  });

  it("cell 4: a containment write that fails rolls back everything — passkeys, sessions, tokens, accounts and footholds stay; no audit, no notice, no mail", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("ADMIN");
    const credential = await passkey(target);
    const signedIn = await signedInWith(target, credential);
    const linked = await account(target);
    const scim = await scimToken(target);
    const sa = await serviceAccount(target);
    const saTok = await saToken(sa, target);
    const client = await mcpClient(target);
    const bg = await breakglassGrant(target, owner);
    const grant = await emergencyGrant(target, tenantId, { status: "IDLE", escrow: true });
    const snapshot = async () => ({
      scim: await rowText("scim_tokens", scim),
      sa: await rowText("service_accounts", sa),
      saTok: await rowText("service_account_tokens", saTok.id),
      client: await rowText("mcp_clients", client),
      bg: await rowText("personal_log_access_grants", bg),
      grant: await rowText("emergency_access_grants", grant),
      account: await rowText("accounts", linked.id),
    });
    const before = await snapshot();
    // The last write (the emergency-access grant's UPDATE) fails. NOT VALID
    // skips the existing row at ADD time; the UPDATE re-checks it. No function
    // is created.
    await sql(`ALTER TABLE emergency_access_grants ADD CONSTRAINT containment_atomicity_probe CHECK (id <> '${grant}'::uuid) NOT VALID`);
    try {
      await expect(
        containAs(owner, target, {
          unlinkAccountIds: [linked.id],
          revoke: {
            scimTokenIds: [scim], serviceAccountIds: [sa], serviceAccountTokenIds: [saTok.id], mcpClientIds: [client],
            breakglassGrantIds: [bg], emergencyAccessGrantIds: [grant],
          },
        }),
      ).rejects.toThrow();
    } finally {
      await sql(`ALTER TABLE emergency_access_grants DROP CONSTRAINT IF EXISTS containment_atomicity_probe`);
    }

    expect(await exists("webauthn_credentials", credential)).toBe(true);
    expect(await exists("sessions", signedIn.sessionId)).toBe(true);
    expect(await tokenRevoked(signedIn.tokenId)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await auditRows(tenantId)).toEqual([]);
    const notices = await sql(`SELECT id FROM notifications WHERE user_id = $1::uuid`, target);
    expect(notices).toEqual([]);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("cell 5: an ADMIN may not revoke a demoted member's break-glass grant (403, unchanged); an OWNER revokes it", async () => {
    const owner = await memberWithRole("OWNER");
    const admin = await memberWithRole("ADMIN");
    // A MEMBER still holding a grant requested before a demotion.
    const target = await memberWithRole("MEMBER");
    const grant = await breakglassGrant(target, owner);
    const before = await rowText("personal_log_access_grants", grant);

    expect((await containAs(admin, target, { revoke: { breakglassGrantIds: [grant] } })).status).toBe(403);
    expect(await rowText("personal_log_access_grants", grant)).toBe(before);

    const res = await containAs(owner, target, { revoke: { breakglassGrantIds: [grant] } });
    expect((await res.json()).contained).toEqual({ breakglassGrants: { revoked: 1, skipped: 0 } });
    expect(await isRevoked("personal_log_access_grants")(grant)).toBe(true);
    const [row] = (await auditRows(tenantId)).filter((r) => r.action === "PERSONAL_LOG_ACCESS_REVOKE");
    expect(row).toMatchObject({ userId: owner, targetId: owner, metadata: { grantId: grant, requesterId: target, revokedById: owner } });
  });

  it("cell 5: emergency access — a not-escrowed and an ACTIVATED grant are revoked, the grantee's request and vault read refused, the other tenant's grant audited there, no grantee mail", async () => {
    const owner = await memberWithRole("OWNER");
    const target = await memberWithRole("MEMBER");
    const grantee = await memberWithRole("MEMBER");
    await alsoMemberElsewhere(target);
    const notEscrowed = await emergencyGrant(target, tenantId, { status: "ACCEPTED", grantee });
    const idle = await emergencyGrant(target, tenantId, { status: "IDLE", escrow: true, grantee });
    const activated = await emergencyGrant(target, tenantId, { status: "ACTIVATED", escrow: true, grantee });
    const filedElsewhere = await emergencyGrant(target, otherTenantId, { status: "IDLE", escrow: true, grantee });

    // Positive control: the grantee reads the activated grant's vault data.
    mockAuth.mockResolvedValue({ user: { id: grantee } });
    const vaultBefore = await readEmergencyVault(new NextRequest(`http://localhost/api/emergency-access/${activated}/vault`), { params: Promise.resolve({ id: activated }) });
    expect(vaultBefore.status).toBe(200);

    const res = await containAs(owner, target, { revoke: { emergencyAccessGrantIds: [notEscrowed, idle, activated, filedElsewhere] } });
    expect((await res.json()).contained).toEqual({ emergencyAccessGrants: { revoked: 4, skipped: 0 } });

    const rows = await sql<{ id: string; status: string; esk: string | null; iv: string | null; tag: string | null; epk: string | null; salt: string | null; revoked: boolean }>(
      `SELECT id, status::text AS status, encrypted_secret_key AS esk, secret_key_iv AS iv, secret_key_auth_tag AS tag,
              owner_ephemeral_public_key AS epk, hkdf_salt AS salt, revoked_at IS NOT NULL AS revoked
         FROM emergency_access_grants WHERE owner_id = $1::uuid`,
      target,
    );
    for (const row of rows) {
      expect(row).toMatchObject({ status: "REVOKED", esk: null, iv: null, tag: null, epk: null, salt: null, revoked: true });
    }

    mockAuth.mockResolvedValue({ user: { id: grantee } });
    const request = await requestEmergencyAccess(new NextRequest(`http://localhost/api/emergency-access/${idle}/request`, { method: "POST" }), { params: Promise.resolve({ id: idle }) });
    expect(request.status).toBeGreaterThanOrEqual(400);
    const vaultAfter = await readEmergencyVault(new NextRequest(`http://localhost/api/emergency-access/${activated}/vault`), { params: Promise.resolve({ id: activated }) });
    expect(vaultAfter.status).toBeGreaterThanOrEqual(400);

    const here = (await auditRows(tenantId)).filter((r) => r.action === "EMERGENCY_ACCESS_REVOKE");
    expect(here).toHaveLength(4);
    for (const row of here) expect(row).toMatchObject({ userId: owner, metadata: { ownerId: target, permanent: true } });
    const elsewhere = (await auditRows(otherTenantId)).filter((r) => r.action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL");
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]).toMatchObject({ userId: SYSTEM_ACTOR_ID, metadata: { emergencyAccessGrantsRevoked: 1, revokedFromTenantId: tenantId } });
    // Only the member is mailed (the revoke-all notice), never the grantee.
    const [granteeEmail] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, grantee);
    expect(mockSendEmail.mock.calls.map((c) => (c[0] as { to: string }).to)).not.toContain(granteeEmail.email);
  });

  it("cell 5: a JIT approval mints its token with the approver as creator", async () => {
    const creator = await memberWithRole("OWNER");
    const approver = await memberWithRole("OWNER");
    const sa = await serviceAccount(creator);
    const requestId = randomUUID();
    await sql(
      `INSERT INTO access_requests (id, tenant_id, service_account_id, requested_scope, status, requester_user_id, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'passwords:read', 'PENDING', $4::uuid, now() + interval '1 hour', now())`,
      requestId, tenantId, sa, creator,
    );
    mockAuth.mockResolvedValue({ user: { id: approver } });
    const res = await approveAccessRequest(
      new NextRequest(`http://localhost/api/tenant/access-requests/${requestId}/approve`, { method: "POST" }),
      { params: Promise.resolve({ id: requestId }) },
    );
    expect(res.status).toBe(200);
    const [row] = await sql<{ created_by_id: string }>(
      `SELECT t.created_by_id FROM service_account_tokens t JOIN access_requests r ON r.granted_token_id = t.id WHERE r.id = $1::uuid`,
      requestId,
    );
    expect(row.created_by_id).toBe(approver);
  });

  it("migration backfill: run as the NOBYPASSRLS application role, it attributes a JIT token to its approver and leaves a direct mint NULL", async () => {
    const creator = await memberWithRole("OWNER");
    const approver = await memberWithRole("OWNER");
    const sa = await serviceAccount(creator);
    const jit = await saToken(sa, null);
    const direct = await saToken(sa, null);
    await sql(
      `INSERT INTO access_requests (id, tenant_id, service_account_id, requested_scope, status, requester_user_id, approved_by_id, approved_at, granted_token_id, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'passwords:read', 'APPROVED', $4::uuid, $5::uuid, now(), $6::uuid, now() + interval '1 hour', now())`,
      randomUUID(), tenantId, sa, creator, approver, jit.id,
    );
    const migration = readFileSync(
      join(process.cwd(), "prisma/migrations/20261109162613_service_account_token_creator/migration.sql"),
      "utf8",
    );
    const block = /-- BEGIN BACKFILL service-account-token-creator\n([\s\S]*?)-- END BACKFILL service-account-token-creator/.exec(migration)?.[1];
    expect(block).toBeDefined();

    const pool = createPool({ connectionString: appConnectionString(), max: 1 });
    try {
      const client = await pool.connect();
      try {
        // The subject is an RLS-bound principal: the rows are invisible to it
        // without a bypass, as they are to the RDS migrate role.
        const [principal] = (await client.query<{ bypass: boolean; superuser: boolean }>(
          `SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
        )).rows;
        expect(principal).toEqual({ bypass: false, superuser: false });
        await client.query("BEGIN");
        const invisible = await client.query(`SELECT id FROM service_account_tokens WHERE id = $1::uuid`, [jit.id]);
        expect(invisible.rows).toEqual([]);
        await client.query(block!);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }

    const rows = await sql<{ id: string; created_by_id: string | null }>(
      `SELECT id, created_by_id FROM service_account_tokens WHERE id = ANY($1::uuid[])`,
      [jit.id, direct.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.created_by_id]))).toEqual({ [jit.id]: approver, [direct.id]: null });
  });
});
