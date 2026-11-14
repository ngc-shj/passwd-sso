/**
 * Integration test (real DB): the directory-sync engine departs and returns
 * users through team-departure.ts, locking every tenant row it touches in one
 * call before any team lock (docs/archive/review/team-tenant-departure-plan.md
 * A10/A11). The provider and the credential decryption are mocked; the engine,
 * its transaction timeout and the locks run for real.
 *
 * Run: docker compose up -d db && npm run test:integration -- team-tenant-departure-directory-sync
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createPrismaForRole, createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { TEAM_KEY_LOCK_TIMEOUT_MS, TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

const { mockFetchOktaUsers } = vi.hoisted(() => ({ mockFetchOktaUsers: vi.fn() }));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/directory-sync/okta", () => ({ fetchOktaUsers: mockFetchOktaUsers }));
vi.mock("@/lib/directory-sync/credentials", () => ({
  decryptCredentials: () => JSON.stringify({ orgUrl: "https://example.okta.com", apiToken: "token" }),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchTenantWebhook: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: async () => ({ allowed: true, retryAfterMs: 0 }), clear: () => {} }),
}));

import { runDirectorySync } from "@/lib/directory-sync/engine";
import { departCreatedMembership } from "@/lib/team/team-departure";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { POST as acceptInvitation } from "@/app/api/teams/invitations/accept/route";
import { prisma } from "@/lib/prisma";

function oktaUser(id: string, email: string, displayName: string, active: boolean) {
  return { id, profile: { email, displayName, firstName: "First", lastName: "Last" }, status: active ? "ACTIVE" : "SUSPENDED" };
}

describe("directory sync across a tenant departure — real-DB integration", () => {
  let ctx: TestContext;
  let side: ReturnType<typeof createPrismaForRole>;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  let configId: string;

  beforeAll(async () => {
    await assertRlsApplies(prisma);
    ctx = await createTestContext();
    side = createPrismaForRole("superuser");
    race = createRaceHelpers(side.pool);
  });

  afterAll(async () => {
    await side.prisma.$disconnect();
    await side.pool.end();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    mockFetchOktaUsers.mockReset();
    tenantId = await ctx.createTenant();
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

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A mapped tenant MEMBER (the IdP's user `ext-<id>`). */
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

  async function addTeamMember(teamId: string, userId: string, role: string) {
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
      randomUUID(), teamId, userId, tenantId, role,
    );
  }

  async function membership(teamId: string, userId: string) {
    const [row] = await sql<{ deactivated_at: Date | null; deactivated_by_tenant: boolean }>(
      `SELECT deactivated_at, deactivated_by_tenant FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  async function stampText(userId: string): Promise<string | null> {
    const [row] = await sql<{ t: string | null }>(
      `SELECT deactivated_at::text AS t FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenantId, userId,
    );
    return row.t;
  }

  it("A11: a run departs the users the IdP suspends, ending their memberships of the tenant's teams", async () => {
    const owner = await ctx.createUser(tenantId);
    const user = await mapped();
    const teamId = await team(owner);
    await addTeamMember(teamId, user.id, "MEMBER");
    mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", false)]);

    const result = await runDirectorySync({ configId, tenantId, force: true });

    expect(result.success).toBe(true);
    expect(await stampText(user.id)).not.toBeNull();
    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_by_tenant: true });
  });

  it("A11: a tenant row held past the lock wait fails the run with the tenant-row error inside the deadline, changing nothing", async () => {
    const owner = await ctx.createUser(tenantId);
    const user = await mapped();
    const teamId = await team(owner);
    await addTeamMember(teamId, user.id, "MEMBER");
    mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", false)]);
    const blocker = await race.holdRowLock(
      `SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid FOR SHARE`,
      [tenantId, user.id],
    );
    // Released on its own after the lock wait would have run out but before
    // Prisma's transaction timeout: an unbounded wait would then succeed.
    const releaseAfter = setTimeout(() => void blocker.release(), TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
    try {
      const started = Date.now();
      const result = await runDirectorySync({ configId, tenantId, force: true });
      const elapsed = Date.now() - started;

      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/membership is being changed/i);
      expect(elapsed).toBeLessThan(TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
      expect(elapsed).toBeLessThan(TEAM_MEMBERSHIP_TX_TIMEOUT_MS);
    } finally {
      clearTimeout(releaseAfter);
      await blocker.release();
    }
    expect(await stampText(user.id)).toBeNull();
    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_at: null });
    const [log] = await sql<{ status: string }>(
      `SELECT status FROM directory_sync_logs WHERE config_id = $1::uuid ORDER BY started_at DESC LIMIT 1`,
      configId,
    );
    expect(log.status).toBe("ERROR");
  });

  it("A3: a rename of a user who stays suspended keeps the stamp and a membership re-admitted since", async () => {
    const owner = await ctx.createUser(tenantId);
    const user = await mapped();
    const teamId = await team(owner);
    await addTeamMember(teamId, user.id, "MEMBER");
    mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "User", false)]);
    expect((await runDirectorySync({ configId, tenantId, force: true })).success).toBe(true);
    const stamp = await stampText(user.id);
    expect(stamp).not.toBeNull();
    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_by_tenant: true });
    // Re-admitted on a post-departure invitation (as accept writes it).
    await sql(
      `UPDATE team_members SET deactivated_at = NULL, deactivated_by_tenant = false
        WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, user.id,
    );

    mockFetchOktaUsers.mockResolvedValue([oktaUser(user.ext, user.email, "Renamed User", false)]);
    expect((await runDirectorySync({ configId, tenantId, force: true })).success).toBe(true);

    expect(await stampText(user.id)).toBe(stamp);
    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_at: null });
  });

  it("A10: a run departing two users waits for an accept holding one of their rows, then ends the admission", async () => {
    // Accept locks [invitee, inviter]; the run departs both. The run waits on
    // the accept (witnessed), the accept commits its admission, and the run then
    // ends it — the outcome of a run racing an admission over the same rows.
    // What keeps such a run from deadlocking with a writer that holds a later
    // user's row and waits on a team (one tenant-row lock call, before any team
    // lock) is pinned by check-team-rotation-input-lock rule 4, not by this cell:
    // pg_blocking_pids also reports waiters queued ahead, so a lock-order
    // mutation is not distinguishable here.
    const owner = await ctx.createUser(tenantId);
    const [inviter, invitee] = [await mapped(), await mapped()].sort((x, y) => x.id.localeCompare(y.id));
    const teamId = await team(owner);
    await addTeamMember(teamId, inviter.id, "ADMIN");
    const invitationId = randomUUID();
    const token = randomBytes(32).toString("hex");
    await sql(
      `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token, expires_at, invited_by_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', 'PENDING', $5, now() + interval '1 day', $6::uuid, now())`,
      invitationId, teamId, tenantId, invitee.email, token, inviter.id,
    );
    mockFetchOktaUsers.mockResolvedValue([
      oktaUser(inviter.ext, inviter.email, "Inviter", false),
      oktaUser(invitee.ext, invitee.email, "Invitee", false),
    ]);
    // Park the accept at its invitation claim — after its tenant-row locks, on
    // a row lock outside its lock budget, so the run's setup time does not race it.
    const blocker = await race.holdRowLock(`SELECT id FROM team_invitations WHERE id = $1::uuid FOR UPDATE`, [invitationId]);
    let accepting: Promise<Response> | undefined;
    let syncing: ReturnType<typeof runDirectorySync> | undefined;
    try {
      mockAuth.mockResolvedValue({ user: { id: invitee.id, email: invitee.email } });
      accepting = acceptInvitation(new NextRequest("http://localhost/api/teams/invitations/accept", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
      }));
      const acceptPid = await race.waitForBackendBlockedBy(blocker.pid);
      syncing = runDirectorySync({ configId, tenantId, force: true });
      expect(await race.settledOrBlocked(syncing, acceptPid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      expect((await accepting).status).toBe(200);
      expect((await syncing).success).toBe(true);
    } finally {
      await blocker.release();
      await Promise.allSettled([accepting, syncing]);
    }
    // Admitted before the run's departure, then ended by it.
    expect(await membership(teamId, invitee.id)).toMatchObject({ deactivated_by_tenant: true });
  });
  /** A user this tenant owns with no membership row (a guest of its teams, say). */
  async function ownedWithoutRow(): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenantId);
    await sql(`DELETE FROM tenant_members WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  it("a run creating two users deactivated departs both, ending their memberships of the tenant's teams", async () => {
    const owner = await ctx.createUser(tenantId);
    const [a, b] = [await ownedWithoutRow(), await ownedWithoutRow()];
    const teamId = await team(owner);
    await addTeamMember(teamId, a.id, "MEMBER");
    await addTeamMember(teamId, b.id, "MEMBER");
    mockFetchOktaUsers.mockResolvedValue([
      oktaUser(`ext-${a.id.slice(0, 8)}`, a.email, "A", false),
      oktaUser(`ext-${b.id.slice(0, 8)}`, b.email, "B", false),
    ]);

    const result = await runDirectorySync({ configId, tenantId, force: true });

    expect(result.success).toBe(true);
    expect(await membership(teamId, a.id)).toMatchObject({ deactivated_by_tenant: true });
    expect(await membership(teamId, b.id)).toMatchObject({ deactivated_by_tenant: true });
  });

  it("departCreatedMembership refuses a batch with a row that is not deactivated, stamping nothing", async () => {
    const owner = await ctx.createUser(tenantId);
    const created = await mapped();
    const active = await mapped();
    const teamId = await team(owner);
    await addTeamMember(teamId, created.id, "MEMBER");
    await sql(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, created.id);
    const before = await stampText(created.id);

    await expect(
      withTenantRls(prisma, tenantId, (tx) =>
        departCreatedMembership(tx, tenantId, [created.id, active.id], { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } }),
      ),
    ).rejects.toThrow(/a created row is not deactivated/);

    expect(await stampText(created.id)).toBe(before);
    expect(await stampText(active.id)).toBeNull();
    expect(await membership(teamId, created.id)).toMatchObject({ deactivated_at: null });
  });
});
