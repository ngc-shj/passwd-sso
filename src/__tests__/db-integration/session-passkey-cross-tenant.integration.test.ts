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
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- session-passkey-cross-tenant
 *   docker compose start audit-outbox-worker retention-gc-worker
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { nextAuthConfigs } = vi.hoisted(() => ({ nextAuthConfigs: [] as unknown[] }));

vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthConfigs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import "@/auth";
import { MS_PER_DAY } from "@/lib/constants/time";

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
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM webauthn_credentials WHERE tenant_id = ANY($1::uuid[])`,
        tenantIds,
      );
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

  async function insertCredential(userId: string, tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webauthn_credentials (
           id, user_id, tenant_id, credential_id, public_key, device_type, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'singleDevice', now())`,
        randomUUID(),
        userId,
        tenantId,
        `cred-${randomUUID()}`,
        "integration-test-public-key",
      );
    });
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
});
