/**
 * Directory sync against users filed under another tenant — the real database,
 * the app role, RLS in force.
 *
 * The engine's unit cells mock the Prisma client, and for this user they mocked
 * rows the database never returns: inside the syncing tenant's context, a user
 * whose owning column names another tenant is invisible. Measured before the fix,
 * the create path's lookup found nobody and the create that followed collided on
 * `users_email_key` (P2002), the name sync failed with P2025, and the load phase
 * dereferenced a null `user`. Each rolled the whole run back, so the refusal arms
 * written for exactly this user could not be reached. These cells run the engine
 * itself against rows seeded in two real tenants.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const { mockFetchOktaUsers } = vi.hoisted(() => ({ mockFetchOktaUsers: vi.fn() }));

vi.mock("@/lib/directory-sync/okta", () => ({ fetchOktaUsers: mockFetchOktaUsers }));
vi.mock("@/lib/directory-sync/credentials", () => ({
  decryptCredentials: () => JSON.stringify({ orgUrl: "https://example.okta.com", apiToken: "token" }),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchTenantWebhook: vi.fn() }));

import { runDirectorySync } from "@/lib/directory-sync/engine";

function oktaUser(id: string, email: string, displayName: string, active: boolean) {
  return {
    id,
    profile: { email, displayName, firstName: "First", lastName: "Last" },
    status: active ? "ACTIVE" : "SUSPENDED",
  };
}

describe("directory sync — users filed under another tenant (real DB)", () => {
  let ctx: TestContext;
  let syncing: string;
  let owning: string;
  let configId: string;

  async function asSuperuser<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return fn(tx);
    });
  }

  async function userRow(userId: string) {
    const [row] = await asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ email: string; name: string; tenant_id: string }[]>(
        `SELECT email, name, tenant_id FROM users WHERE id = $1::uuid`,
        userId,
      ),
    );
    return row;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    mockFetchOktaUsers.mockReset();
    syncing = await ctx.createTenant();
    owning = await ctx.createTenant();
    configId = randomUUID();
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO directory_sync_configs
           (id, tenant_id, provider, display_name, enabled, sync_interval_minutes,
            encrypted_credentials, credentials_iv, credentials_auth_tag, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'OKTA'::"DirectorySyncProvider", 'test-config', true, 60,
            'cipher', 'iv', 'tag', 'IDLE'::"DirectorySyncStatus", now(), now())`,
        configId,
        syncing,
      ),
    );
  });

  afterEach(async () => {
    await ctx.deleteTestData(syncing);
    await ctx.deleteTestData(owning);
  });

  it("files a deactivated membership under a user active in another tenant, instead of colliding on their email", async () => {
    const userId = await ctx.createUser(owning); // with an ACTIVE membership there
    const { email } = await userRow(userId);
    mockFetchOktaUsers.mockResolvedValue([oktaUser("ext-1", email, "Moved User", true)]);

    const result = await runDirectorySync({ configId, tenantId: syncing });

    expect(result).toMatchObject({ success: true, usersCreated: 1, usersRefused: 1 });
    const memberships = await asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ deactivated: boolean }[]>(
        `SELECT deactivated_at IS NOT NULL AS deactivated FROM tenant_members
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        syncing,
        userId,
      ),
    );
    expect(memberships).toEqual([{ deactivated: true }]);
    const [{ n }] = await asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`,
        email,
      ),
    );
    expect(n).toBe(1);
  });

  it("activates a user who is active nowhere and moves their owning column, recording it for both tenants", async () => {
    const userId = await ctx.createUser(owning);
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        owning,
        userId,
      ),
    );
    const { email } = await userRow(userId);
    mockFetchOktaUsers.mockResolvedValue([oktaUser("ext-2", email, "Returning User", true)]);

    const result = await runDirectorySync({ configId, tenantId: syncing });

    expect(result).toMatchObject({ success: true, usersCreated: 1, usersRefused: 0 });
    // Without the move the member's own requests could not see their own row,
    // and this tenant could not read them either.
    expect((await userRow(userId)).tenant_id).toBe(syncing);
    const recorded = await asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM audit_outbox
          WHERE payload->>'action' = 'USER_TENANT_REALIGNED' AND tenant_id IN ($1::uuid, $2::uuid)`,
        syncing,
        owning,
      ),
    );
    expect(recorded.map((r) => r.tenant_id).sort()).toEqual([syncing, owning].sort());
  });

  it("syncs a mapped member whose users row it cannot see, leaving their name to the tenant that owns it", async () => {
    const userId = await ctx.createUser(owning);
    const { email, name } = await userRow(userId);
    // A departed member here, still mapped to the IdP user.
    await asSuperuser(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
        randomUUID(),
        syncing,
        userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO scim_external_mappings (id, tenant_id, external_id, resource_type, internal_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'ext-3', 'User', $3, now(), now())`,
        randomUUID(),
        syncing,
        userId,
      );
    });
    mockFetchOktaUsers.mockResolvedValue([oktaUser("ext-3", email, "Renamed By This IdP", false)]);

    const result = await runDirectorySync({ configId, tenantId: syncing });

    expect(result).toMatchObject({ success: true, usersUpdated: 0 });
    expect((await userRow(userId)).name).toBe(name);
  });
});
