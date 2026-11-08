/**
 * Integration test (real DB): a tenant admin lists and revokes a member's
 * passkey (#974) — `GET /api/tenant/members/[userId]/passkeys` and
 * `DELETE .../passkeys/[credentialId]`. The routes, the tenant RLS reads, the
 * session/token invalidation and the audit outbox are real; only `auth()` and
 * the step-up check are mocked.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- tenant-member-passkey-revoke
 *   docker compose start audit-outbox-worker retention-gc-worker
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));

import { GET as listPasskeys } from "@/app/api/tenant/members/[userId]/passkeys/route";
import { DELETE as revokePasskey } from "@/app/api/tenant/members/[userId]/passkeys/[credentialId]/route";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

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
    vi.clearAllMocks();
  });

  afterEach(async () => {
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
  ] as const)("%s only passkey: it is deleted, the member is signed out of the tenant, and it is audited", async (_label, actorRole, targetRole) => {
    const actor = await memberWithRole(actorRole);
    const target = await memberWithRole(targetRole);
    const credential = await passkey(target);
    const signedIn = await signedInWith(target, credential);
    // Elsewhere: the member's session in another tenant is left alone.
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
    expect(await exists("sessions", elsewhere.sessionId)).toBe(true);
    expect(await tokenRevoked(elsewhere.tokenId)).toBe(false);

    const [audit] = await sql<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload::text LIKE '%TENANT_MEMBER_PASSKEY_REVOKE%'`,
      tenantId,
    );
    expect(JSON.parse(audit.payload)).toMatchObject({
      action: "TENANT_MEMBER_PASSKEY_REVOKE",
      userId: actor,
      targetId: credential,
      metadata: { targetUserId: target, sessions: 1, extensionTokens: 1 },
    });
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

  it("an OWNER cannot reach a member of another tenant, or a passkey registered under another tenant (404)", async () => {
    const owner = await memberWithRole("OWNER");
    const foreignMember = await memberWithRole("MEMBER", otherTenantId);
    const foreignCredential = await passkey(foreignMember, otherTenantId);
    expect(await revokeAs(owner, foreignMember, foreignCredential)).toBe(404);
    expect(await exists("webauthn_credentials", foreignCredential)).toBe(true);

    // The member is in this tenant, the passkey was registered under another.
    const member = await memberWithRole("MEMBER");
    const elsewhereCredential = await passkey(member, otherTenantId);
    expect(await revokeAs(owner, member, elsewhereCredential)).toBe(404);
    expect(await exists("webauthn_credentials", elsewhereCredential)).toBe(true);
    // Another member's credential id under this member's path: 404.
    const someoneElse = await memberWithRole("MEMBER");
    const theirs = await passkey(someoneElse);
    expect(await revokeAs(owner, member, theirs)).toBe(404);
    expect(await exists("webauthn_credentials", theirs)).toBe(true);
  });
});
