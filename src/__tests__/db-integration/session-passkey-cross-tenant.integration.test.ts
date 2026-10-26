/**
 * The `auth.ts` session callback counts a passkey registered under another
 * tenant (session-api-passkey-gate plan, Testing → Integration, T13).
 *
 * `hasPasskey` is deliberately cross-tenant: a member signed in under a tenant
 * that requires a passkey, past its grace period, is not blocked when their
 * only credential row carries another tenant's id. The callback reads that
 * count through a bypass grant, so only a real database shows the grant
 * actually reaches the other tenant's row; a unit test mocks the read away.
 *
 * The callback is the production one, captured from the config `src/auth.ts`
 * hands `NextAuth(...)`. `next-auth` itself is mocked for the module-resolution
 * reason audit-sentinel-claim-denial.integration.test.ts gives; everything the
 * callback reads (users, tenant_members, tenants, webauthn_credentials) is real.
 *
 * The same cross-tenant count backs the last-passkey delete refusal (#959
 * FN-2/FN-8): `derivePasskeyState`'s `passkeyCount` reaches the other tenant's
 * row, so `DELETE /api/webauthn/credentials/[id]` lets a member delete their
 * requiring-tenant passkey while one under another tenant remains. That cell
 * drives the real route; only the session boundary (`auth()`, via the mocked
 * `next-auth`) is stubbed, and the step-up reads a real fresh Session row.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- session-passkey-cross-tenant
 *   docker compose start audit-outbox-worker retention-gc-worker
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const { nextAuthConfigs, mockAuth } = vi.hoisted(() => ({
  nextAuthConfigs: [] as unknown[],
  mockAuth: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthConfigs.push(config);
    return { handlers: {}, auth: mockAuth, signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import "@/auth";
import { MS_PER_DAY } from "@/lib/constants/time";
import { derivePasskeyState } from "@/lib/auth/policy/passkey-enforcement";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { DELETE as deleteCredential } from "@/app/api/webauthn/credentials/[id]/route";

const APP_ORIGIN = "http://localhost:3000";

type SessionCallback = (params: {
  session: { expires: string; user?: unknown };
  user: { id: string; name: string | null; email: string; image: string | null };
}) => Promise<{
  user: { hasPasskey: boolean; passkeyBlocked: boolean; passkeyStateDegraded: boolean };
}>;

function capturedSession(): SessionCallback {
  const config = nextAuthConfigs[0] as { callbacks?: { session?: SessionCallback } } | undefined;
  const session = config?.callbacks?.session;
  if (!session) throw new Error("src/auth.ts did not hand NextAuth a session callback");
  return session;
}

const GRACE_DAYS = 7;

describe("session callback: a passkey under another tenant counts (real DB)", () => {
  let ctx: TestContext;
  let tenantIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.cleanup();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    mockAuth.mockReset();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      for (const table of ["sessions", "webauthn_credentials"]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`,
          tenantIds,
        );
      }
    });
    for (const id of tenantIds) await ctx.deleteTestData(id);
    tenantIds = [];
  });

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    tenantIds.push(id);
    return id;
  }

  /** Required, grace period expired one day ago: a member with no passkey is blocked. */
  async function requirePasskeyPastGrace(tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants
            SET require_passkey = true,
                require_passkey_enabled_at = $2,
                passkey_grace_period_days = $3
          WHERE id = $1::uuid`,
        tenantId,
        new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
        GRACE_DAYS,
      );
    });
  }

  async function insertCredential(userId: string, tenantId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webauthn_credentials (
           id, user_id, tenant_id, credential_id, public_key, device_type, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'singleDevice', now())`,
        id,
        userId,
        tenantId,
        `cred-${randomUUID()}`,
        "integration-test-public-key",
      );
    });
    return id;
  }

  /** A live Session row created now (a fresh sign-in); returns the raw cookie token. */
  async function insertFreshSession(userId: string, tenantId: string): Promise<string> {
    const token = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (
           id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now(), 'google'
         )`,
        randomUUID(),
        hashSessionToken(token),
        userId,
        tenantId,
      );
    });
    return token;
  }

  async function credentialExists(id: string): Promise<boolean> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM webauthn_credentials WHERE id = $1::uuid`,
        id,
      );
      return rows.length > 0;
    });
  }

  /** The member deletes `credentialRowId` from a fresh sign-in under `tenantId`. */
  async function deleteAsMember(userId: string, tenantId: string, credentialRowId: string) {
    vi.stubEnv("AUTH_URL", APP_ORIGIN);
    vi.stubEnv("APP_URL", APP_ORIGIN);
    const token = await insertFreshSession(userId, tenantId);
    mockAuth.mockResolvedValue({ user: { id: userId } });
    const req = new NextRequest(`${APP_ORIGIN}/api/webauthn/credentials/${credentialRowId}`, {
      method: "DELETE",
      headers: { origin: APP_ORIGIN, cookie: `authjs.session-token=${token}` },
    });
    const res = await deleteCredential(req, { params: Promise.resolve({ id: credentialRowId }) });
    return { status: res.status, body: (await res.json()) as { error?: string; success?: boolean } };
  }

  /** A user whose owning tenant requires a passkey past grace, and another tenant. */
  async function seedSignedInUnderRequiringTenant() {
    const requiring = await newTenant();
    const other = await newTenant();
    await requirePasskeyPastGrace(requiring);
    const userId = await ctx.createUser(requiring);
    return { requiring, other, userId };
  }

  function runSessionCallback(userId: string) {
    return capturedSession()({
      session: { expires: new Date(Date.now() + MS_PER_DAY).toISOString() },
      user: { id: userId, name: null, email: `${userId}@example.com`, image: null },
    });
  }

  it("a credential under another tenant yields hasPasskey and no block", async () => {
    const { other, userId } = await seedSignedInUnderRequiringTenant();
    await insertCredential(userId, other);

    const { user } = await runSessionCallback(userId);

    expect(user).toMatchObject({ hasPasskey: true, passkeyBlocked: false, passkeyStateDegraded: false });
  });

  it("control: with no credential anywhere the same member is blocked", async () => {
    const { userId } = await seedSignedInUnderRequiringTenant();

    const { user } = await runSessionCallback(userId);

    expect(user).toMatchObject({ hasPasskey: false, passkeyBlocked: true, passkeyStateDegraded: false });
  });
  // ─── #959 FN-2/FN-8: the last-passkey delete refusal uses the same count ───

  describe("derivePasskeyState passkeyCount and the last-passkey delete", () => {
    it("counts a credential under another tenant: passkeyCount is 2", async () => {
      const { requiring, other, userId } = await seedSignedInUnderRequiringTenant();
      await insertCredential(userId, requiring);
      await insertCredential(userId, other);

      const state = await derivePasskeyState({ userId, tenantId: requiring });

      expect(state).toMatchObject({ passkeyCount: 2, hasPasskey: true, requirePasskey: true });
    });

    it("lets the member delete the requiring tenant's passkey while another tenant's remains", async () => {
      const { requiring, other, userId } = await seedSignedInUnderRequiringTenant();
      const home = await insertCredential(userId, requiring);
      const elsewhere = await insertCredential(userId, other);

      const { status, body } = await deleteAsMember(userId, requiring, home);

      expect({ status, body }).toEqual({ status: 200, body: { success: true } });
      expect(await credentialExists(home)).toBe(false);
      expect(await credentialExists(elsewhere)).toBe(true);
    });

    it("control: the requiring tenant's passkey alone counts 1 and its delete is refused", async () => {
      const { requiring, userId } = await seedSignedInUnderRequiringTenant();
      const home = await insertCredential(userId, requiring);

      const state = await derivePasskeyState({ userId, tenantId: requiring });
      const { status, body } = await deleteAsMember(userId, requiring, home);

      expect(state.passkeyCount).toBe(1);
      expect({ status, error: body.error }).toEqual({ status: 403, error: "CANNOT_DELETE_LAST_PASSKEY" });
      expect(await credentialExists(home)).toBe(true);
    });
  });
});
