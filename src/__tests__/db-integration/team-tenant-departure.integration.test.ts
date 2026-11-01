/**
 * Integration test (real DB): a user's departure from a tenant ends their
 * memberships of that tenant's teams, admission back needs an invitation
 * issued after the departure, and a return restores exactly what the
 * departure ended (docs/archive/review/team-tenant-departure-plan.md).
 *
 * Production routes and services run under their real RLS contexts on the
 * app role; only the auth, step-up, rate-limit and SCIM-token boundaries are
 * mocked. Races are parked on a row lock held by a test "blocker"
 * transaction and witnessed through pg_blocking_pids (race-helpers.ts).
 *
 * Run: docker compose up -d db && npm run test:integration -- team-tenant-departure
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  assertRlsApplies,
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { TEAM_KEY_LOCK_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";

const { scimTenant, stalePermission } = vi.hoisted(() => ({
  scimTenant: { id: "" },
  // When set, requireTeamPermission answers as it did BEFORE a departure
  // committed: the window between the route's permission check and its lock.
  stalePermission: { membership: null as null | { id: string; role: string } },
}));
vi.mock("@/lib/auth/access/team-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/access/team-auth")>();
  return {
    ...actual,
    requireTeamPermission: async (...args: Parameters<typeof actual.requireTeamPermission>) =>
      stalePermission.membership ?? actual.requireTeamPermission(...args),
  };
});
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

import { POST as scimPostUser } from "@/app/api/scim/v2/Users/route";
import { PATCH as scimPatchUser, DELETE as scimDeleteUser } from "@/app/api/scim/v2/Users/[id]/route";
import { POST as acceptInvitation } from "@/app/api/teams/invitations/accept/route";
import { POST as issueInvitation } from "@/app/api/teams/[teamId]/invitations/route";
import { GET as listMembers, POST as addMember } from "@/app/api/teams/[teamId]/members/route";
import { DELETE as removeMember, PUT as changeRole } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { GET as getMemberKey } from "@/app/api/teams/[teamId]/member-key/route";
import { POST as assignOwner } from "@/app/api/tenant/teams/[teamId]/owner/route";
import { POST as rotateKey } from "@/app/api/teams/[teamId]/rotate-key/route";
import { POST as confirmKey } from "@/app/api/teams/[teamId]/members/[memberId]/confirm-key/route";
import { GET as pendingDistributions } from "@/app/api/teams/pending-key-distributions/route";
import { POST as createTeam } from "@/app/api/teams/route";
import { patchScimGroup } from "@/lib/services/scim-group-service";
import { departFromTenant } from "@/lib/team/team-departure";
import { lockTenantRows, TenantMemberLockTimeoutError } from "@/lib/team/tenant-row-lock";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

const hex = (n: number) => randomBytes(n).toString("hex");

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("team membership across a tenant departure — real-DB integration", () => {
  let ctx: TestContext;
  let side: ReturnType<typeof createPrismaForRole>;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    side = createPrismaForRole("superuser");
    race = createRaceHelpers(side.pool);
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await side.prisma.$disconnect();
    await side.pool.end();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    scimTenant.id = tenantId;
    stalePermission.membership = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  async function asSuperuser<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return fn(tx);
    });
  }

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return asSuperuser((tx) => tx.$queryRawUnsafe<T[]>(text, ...params));
  }

  /** A tenant MEMBER (createUser makes OWNERs, whom a departure never touches). */
  async function member(tenant = tenantId): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  /** Add `userId` to tenant `tenant` as an active MEMBER (a guest from elsewhere). */
  async function joinTenant(userId: string, tenant: string) {
    await sql(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(), tenant, userId,
    );
  }

  /**
   * The user left this tenant for another: their row here stays deactivated
   * and they are active in `otherTenantId` (a user active nowhere cannot use
   * the app at all, so this is the state in which they accept an invitation).
   */
  async function moveAway(userId: string) {
    await joinTenant(userId, otherTenantId);
  }

  /** A user this tenant owns (users.tenant_id) who holds no membership row anywhere. */
  async function ownedWithoutRow(): Promise<{ id: string; email: string }> {
    const user = await member();
    await sql(`DELETE FROM tenant_members WHERE user_id = $1::uuid`, user.id);
    return user;
  }

  async function team(owner: string, tenant = tenantId): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, tenant, `team-${id.slice(0, 8)}`,
    );
    await addTeamMember(id, owner, "OWNER", tenant);
    return id;
  }

  async function addTeamMember(teamId: string, userId: string, role: string, tenant = tenantId): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, now(), now())`,
      rowId, teamId, userId, tenant, role,
    );
    await sql(
      `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, now(), now())`,
      randomUUID(), teamId, tenant, userId, hex(32), hex(12), hex(16), hex(32), hex(32),
    );
    return rowId;
  }

  async function membership(teamId: string, userId: string) {
    const [row] = await sql<{ id: string; deactivated_at: Date | null; deactivated_by_tenant: boolean; key_distributed: boolean; scim_managed: boolean; role: string }>(
      `SELECT id, deactivated_at, deactivated_by_tenant, key_distributed, scim_managed, role
         FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  async function tenantRow(tenant: string, userId: string) {
    const [row] = await sql<{ deactivated_at: Date | null }>(
      `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenant, userId,
    );
    return row ?? null;
  }

  async function keyCount(teamId: string, userId: string): Promise<number> {
    const [row] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row.n;
  }

  async function invitationStatus(id: string): Promise<string> {
    const [row] = await sql<{ status: string }>(`SELECT status FROM team_invitations WHERE id = $1::uuid`, id);
    return row.status;
  }

  async function auditActions(action: string, teamId?: string): Promise<{ targetId: string; metadata: unknown }[]> {
    const rows = await sql<{ payload: { targetId: string; metadata: unknown; teamId?: string } }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = ANY($1::uuid[]) AND payload->>'action' = $2`,
      [tenantId, otherTenantId], action,
    );
    return rows
      .map((r) => r.payload)
      .filter((p) => teamId === undefined || p.teamId === teamId)
      .map((p) => ({ targetId: p.targetId, metadata: p.metadata }));
  }

  // ── Entry points ─────────────────────────────────────────────

  function scimActive(userId: string, active: boolean) {
    return scimPatchUser(
      jsonRequest(`http://localhost/api/scim/v2/Users/${userId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  function scimDelete(userId: string) {
    return scimDeleteUser(
      new NextRequest(`http://localhost/api/scim/v2/Users/${userId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  async function invite(teamId: string, inviter: string, email: string): Promise<{ status: number; id?: string; token?: string }> {
    mockAuth.mockResolvedValue({ user: { id: inviter } });
    const res = await issueInvitation(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, "POST", { email, role: "MEMBER" }),
      { params: Promise.resolve({ teamId }) },
    );
    const body = res.status === 201 ? await res.json() : {};
    return { status: res.status, id: body.id, token: body.token };
  }

  function accept(user: { id: string; email: string }, token: string) {
    mockAuth.mockResolvedValue({ user: { id: user.id, email: user.email } });
    return acceptInvitation(jsonRequest("http://localhost/api/teams/invitations/accept", "POST", { token }));
  }

  // ── A1: departure ────────────────────────────────────────────

  it("A1: a SCIM deactivation ends the memberships of the tenant's teams, with the marker, and nothing elsewhere", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    // A guest: active in another tenant, a member of this tenant's team.
    const guest = await member(otherTenantId);
    const teamId = await team(owner);
    const otherTeamHere = await team(owner);
    await addTeamMember(teamId, leaver.id, "ADMIN");
    await addTeamMember(teamId, guest.id, "MEMBER");
    // The leaver's membership of a team in ANOTHER tenant (as a guest there).
    const otherOwner = await ctx.createUser(otherTenantId);
    const otherTeam = await team(otherOwner, otherTenantId);
    await addTeamMember(otherTeam, leaver.id, "MEMBER", otherTenantId);
    // An invitation the leaver issued, and one addressed to them (to a team
    // they are not in yet).
    const issued = await invite(teamId, leaver.id, `x-${randomUUID().slice(0, 6)}@example.com`);
    const addressed = await invite(otherTeamHere, owner, leaver.email);
    expect(issued.status).toBe(201);
    expect(addressed.status).toBe(201);

    expect((await scimActive(leaver.id, false)).status).toBe(200);

    const ended = await membership(teamId, leaver.id);
    expect(ended).toMatchObject({ deactivated_by_tenant: true });
    expect(ended?.deactivated_at?.getTime()).toBe((await tenantRow(tenantId, leaver.id))?.deactivated_at?.getTime());
    expect(await membership(otherTeam, leaver.id)).toMatchObject({ deactivated_at: null, deactivated_by_tenant: false });
    expect(await membership(teamId, guest.id)).toMatchObject({ deactivated_at: null });
    expect(await invitationStatus(issued.id!)).toBe("EXPIRED");
    expect(await invitationStatus(addressed.id!)).toBe("PENDING");

    mockAuth.mockResolvedValue({ user: { id: leaver.id } });
    const key = await getMemberKey(new NextRequest(`http://localhost/api/teams/${teamId}/member-key`), {
      params: Promise.resolve({ teamId }),
    });
    expect(key.status).toBe(404);

    const audits = await auditActions("TEAM_MEMBER_TENANT_DEACTIVATE", teamId);
    expect(audits).toEqual([{ targetId: leaver.id, metadata: { source: "TENANT_DEACTIVATION" } }]);
  });

  // ── A2: admission at accept ───────────────────────────────────

  describe("A2: accept decides admission against the departure", () => {
    it("refuses an invitation issued before the departure, and commits it EXPIRED", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      const inv = await invite(teamId, owner, leaver.email);
      expect(inv.status).toBe(201);
      await scimActive(leaver.id, false);
      await moveAway(leaver.id);

      const res = await accept(leaver, inv.token!);

      expect(res.status).toBe(410);
      expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
      expect(await membership(teamId, leaver.id)).toBeNull();
    });

    it("refuses an invitation issued by a user who then left (seeded PENDING, bypassing the expiry)", async () => {
      const owner = await ctx.createUser(tenantId);
      const inviter = await member();
      const invitee = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, inviter.id, "ADMIN");
      const inv = await invite(teamId, inviter.id, invitee.email);
      await scimActive(inviter.id, false);
      await sql(`UPDATE team_invitations SET status = 'PENDING' WHERE id = $1::uuid`, inv.id);

      const res = await accept(invitee, inv.token!);

      expect(res.status).toBe(410);
      expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
      expect(await membership(teamId, invitee.id)).toBeNull();
    });

    it("refuses an invitation issued at the exact instant of the departure", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await scimActive(leaver.id, false);
      await moveAway(leaver.id);
      const inv = await invite(teamId, owner, leaver.email);
      await sql(
        `UPDATE team_invitations SET created_at = (SELECT deactivated_at FROM tenant_members
           WHERE tenant_id = $2::uuid AND user_id = $3::uuid) WHERE id = $1::uuid`,
        inv.id, tenantId, leaver.id,
      );

      expect((await accept(leaver, inv.token!)).status).toBe(410);
      expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
    });

    it("admits on an invitation issued after the departure, resetting the membership", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, leaver.id, "ADMIN");
      await sql(`UPDATE team_members SET scim_managed = true WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, leaver.id);
      await scimActive(leaver.id, false);
      await moveAway(leaver.id);
      const inv = await invite(teamId, owner, leaver.email);
      expect(inv.status).toBe(201);

      const res = await accept(leaver, inv.token!);

      expect(res.status).toBe(200);
      expect(await membership(teamId, leaver.id)).toMatchObject({
        deactivated_at: null,
        deactivated_by_tenant: false,
        key_distributed: false,
        scim_managed: false,
      });
      expect(await keyCount(teamId, leaver.id)).toBe(0);
    });

    it("refuses a pre-deletion invitation after a SCIM DELETE and an SSO re-creation of the row", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      // Filed under another tenant: the email is invisible to this tenant's RLS.
      await sql(`UPDATE users SET tenant_id = $2::uuid WHERE id = $1::uuid`, leaver.id, otherTenantId);
      const teamId = await team(owner);
      const memberOf = await team(owner);
      await addTeamMember(memberOf, leaver.id, "MEMBER");
      const inv = await invite(teamId, owner, leaver.email);
      expect(inv.status).toBe(201);

      expect((await scimDelete(leaver.id)).status).toBe(204);
      expect(await membership(memberOf, leaver.id)).toBeNull();
      // The row comes back (SSO sign-in / SCIM POST): active again here.
      await joinTenant(leaver.id, tenantId);

      expect((await accept(leaver, inv.token!)).status).toBe(410);
      expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
      expect(await membership(teamId, leaver.id)).toBeNull();
      const after = await invite(teamId, owner, leaver.email);
      expect((await accept(leaver, after.token!)).status).toBe(200);
    });

    it("matches the invitee's email case-insensitively in POST and accept", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, leaver.id, "MEMBER");
      expect((await invite(teamId, owner, leaver.email.toUpperCase())).status).toBe(409);
    });
  });

  // ── A3/A4: re-deactivation and return ─────────────────────────

  it("A3: a repeated deactivation keeps the stamp and a re-admitted membership", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    await scimActive(leaver.id, false);
    await moveAway(leaver.id);
    const stampText = async () =>
      (await sql<{ t: string }>(`SELECT deactivated_at::text AS t FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, leaver.id))[0].t;
    const stamp = await stampText();
    const inv = await invite(teamId, owner, leaver.email);
    expect((await accept(leaver, inv.token!)).status).toBe(200);
    const otherTeam = await team(owner);
    const pendingAfter = await invite(otherTeam, owner, leaver.email);
    const auditsBefore = (await auditActions("TEAM_MEMBER_TENANT_DEACTIVATE")).length;

    expect((await scimActive(leaver.id, false)).status).toBe(200);

    expect(await stampText()).toBe(stamp);
    expect(await invitationStatus(pendingAfter.id!)).toBe("PENDING");
    expect(await membership(teamId, leaver.id)).toMatchObject({ deactivated_at: null });
    expect((await auditActions("TEAM_MEMBER_TENANT_DEACTIVATE")).length).toBe(auditsBefore);
  });

  it("A4: a return restores the marked memberships with their keys", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    await addTeamMember(teamId, leaver.id, "MEMBER");
    await scimActive(leaver.id, false);

    expect((await scimActive(leaver.id, true)).status).toBe(200);

    expect(await membership(teamId, leaver.id)).toMatchObject({ deactivated_at: null, deactivated_by_tenant: false, key_distributed: true });
    expect(await keyCount(teamId, leaver.id)).toBe(1);
    expect(await auditActions("TEAM_MEMBER_TENANT_RESTORE", teamId)).toEqual([
      { targetId: leaver.id, metadata: { source: "TENANT_REACTIVATION" } },
    ]);
  });

  // ── A5/A12: team-level control of departed rows ───────────────

  it("A5/A12: an admin sees a departed member flagged and removes them, so a return does not restore them", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const viewer = await member();
    const teamId = await team(owner);
    const rowId = await addTeamMember(teamId, leaver.id, "MEMBER");
    await addTeamMember(teamId, viewer.id, "VIEWER");
    await scimActive(leaver.id, false);

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const asOwner = await (await listMembers(new NextRequest(`http://localhost/api/teams/${teamId}/members`), { params: Promise.resolve({ teamId }) })).json();
    expect(asOwner.find((m: { userId: string }) => m.userId === leaver.id)?.departed).toBe(true);
    mockAuth.mockResolvedValue({ user: { id: viewer.id } });
    const asViewer = await (await listMembers(new NextRequest(`http://localhost/api/teams/${teamId}/members`), { params: Promise.resolve({ teamId }) })).json();
    expect(asViewer.some((m: { userId: string }) => m.userId === leaver.id)).toBe(false);

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const removed = await removeMember(new NextRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, { method: "DELETE" }), {
      params: Promise.resolve({ teamId, memberId: rowId }),
    });
    expect(removed.status).toBe(200);
    expect(await keyCount(teamId, leaver.id)).toBe(0);

    await scimActive(leaver.id, true);
    expect(await membership(teamId, leaver.id)).toBeNull();
  });

  it("A5: a SCIM group removal of a departed member survives a return", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    await addTeamMember(teamId, leaver.id, "MEMBER");
    await sql(
      `INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', now(), now())`,
      randomUUID(), tenantId, teamId, `grp-${teamId.slice(0, 6)}`,
    );
    await scimActive(leaver.id, false);

    await withTenantRls(prisma, tenantId, (tx) =>
      patchScimGroup(tenantId, `grp-${teamId.slice(0, 6)}`, [{ op: "remove", userId: leaver.id }], "http://localhost/api/scim/v2", tx),
    );
    expect(await membership(teamId, leaver.id)).toMatchObject({ deactivated_by_tenant: false });
    await scimActive(leaver.id, true);

    expect((await membership(teamId, leaver.id))?.deactivated_at).not.toBeNull();
  });

  // ── A7: SCIM group add ────────────────────────────────────────

  it("A7: a SCIM group add reactivates a deactivated membership in place, without stale keys", async () => {
    const owner = await ctx.createUser(tenantId);
    const user = await member();
    const teamId = await team(owner);
    await addTeamMember(teamId, user.id, "MEMBER");
    await sql(`UPDATE team_members SET deactivated_at = now(), scim_managed = true WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, user.id);
    await sql(
      `INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', now(), now())`,
      randomUUID(), tenantId, teamId, `grp-${teamId.slice(0, 6)}`,
    );

    await withTenantRls(prisma, tenantId, (tx) =>
      patchScimGroup(tenantId, `grp-${teamId.slice(0, 6)}`, [{ op: "add", userId: user.id }], "http://localhost/api/scim/v2", tx),
    );

    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_at: null, deactivated_by_tenant: false, key_distributed: false });
    expect(await keyCount(teamId, user.id)).toBe(0);
  });

  // ── A8: ownerless team ────────────────────────────────────────

  it("A8: a tenant ADMIN assigns the OWNER of a team whose owner left; one OWNER after the old owner returns", async () => {
    const admin = await ctx.createUser(tenantId);
    await sql(`UPDATE tenant_members SET role = 'ADMIN' WHERE user_id = $1::uuid`, admin);
    const oldOwner = await member();
    const successor = await member();
    const teamId = await team(oldOwner.id);
    await addTeamMember(teamId, successor.id, "MEMBER");
    await scimActive(oldOwner.id, false);

    mockAuth.mockResolvedValue({ user: { id: admin } });
    const res = await assignOwner(jsonRequest(`http://localhost/api/tenant/teams/${teamId}/owner`, "POST", { userId: successor.id }), {
      params: Promise.resolve({ teamId }),
    });
    expect(res.status).toBe(200);
    await scimActive(oldOwner.id, true);

    const owners = await sql<{ user_id: string }>(
      `SELECT user_id FROM team_members WHERE team_id = $1::uuid AND role = 'OWNER' AND deactivated_at IS NULL`,
      teamId,
    );
    expect(owners).toEqual([{ user_id: successor.id }]);
    expect(await auditActions("TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN", teamId)).toEqual([
      { targetId: expect.any(String), metadata: { targetUserId: successor.id, demotedUserIds: [oldOwner.id], selfAssigned: false } },
    ]);
  });

  it("A8: a tenant ADMIN of another tenant cannot assign (404), changing nothing", async () => {
    const outsider = await ctx.createUser(otherTenantId);
    await sql(`UPDATE tenant_members SET role = 'ADMIN' WHERE user_id = $1::uuid`, outsider);
    const oldOwner = await member();
    const successor = await member();
    const teamId = await team(oldOwner.id);
    await addTeamMember(teamId, successor.id, "MEMBER");
    await scimActive(oldOwner.id, false);

    mockAuth.mockResolvedValue({ user: { id: outsider } });
    const res = await assignOwner(jsonRequest(`http://localhost/api/tenant/teams/${teamId}/owner`, "POST", { userId: successor.id }), {
      params: Promise.resolve({ teamId }),
    });

    expect(res.status).toBe(404);
    expect(await membership(teamId, successor.id)).toMatchObject({ role: "MEMBER" });
    expect(await auditActions("TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN")).toEqual([]);
  });

  // ── A13/A14 ───────────────────────────────────────────────────

  it("A13: an ownership transfer to a member who left is refused, changing no role", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    const rowId = await addTeamMember(teamId, leaver.id, "ADMIN");
    await scimActive(leaver.id, false);

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const res = await changeRole(jsonRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, "PUT", { role: "OWNER" }), {
      params: Promise.resolve({ teamId, memberId: rowId }),
    });

    expect(res.status).toBe(404);
    expect(await membership(teamId, owner)).toMatchObject({ role: "OWNER" });
  });

  it("A14: members POST reactivates a deactivated row with the marker cleared and stale keys gone", async () => {
    const owner = await ctx.createUser(tenantId);
    const user = await member();
    const teamId = await team(owner);
    await addTeamMember(teamId, user.id, "MEMBER");
    await scimActive(user.id, false);
    await scimActive(user.id, true);
    await sql(`UPDATE team_members SET deactivated_at = now() WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, user.id);

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const res = await addMember(jsonRequest(`http://localhost/api/teams/${teamId}/members`, "POST", { userId: user.id, role: "MEMBER" }), {
      params: Promise.resolve({ teamId }),
    });

    expect(res.status).toBe(201);
    expect(await membership(teamId, user.id)).toMatchObject({ deactivated_at: null, deactivated_by_tenant: false, key_distributed: false });
    expect(await keyCount(teamId, user.id)).toBe(0);
  });

  it("A14: invitation POST expires a stale invitation issued at the instant of the departure and issues a new one", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    const stale = await invite(teamId, owner, leaver.email);
    await scimActive(leaver.id, false);
    await sql(
      `UPDATE team_invitations SET created_at = (SELECT deactivated_at FROM tenant_members
         WHERE tenant_id = $2::uuid AND user_id = $3::uuid) WHERE id = $1::uuid`,
      stale.id, tenantId, leaver.id,
    );

    const fresh = await invite(teamId, owner, leaver.email);

    expect(fresh.status).toBe(201);
    expect(await invitationStatus(stale.id!)).toBe("EXPIRED");
  });

  // ── Create-deactivated ────────────────────────────────────────

  it("a SCIM POST creating a guest's membership deactivated ends their memberships of the tenant's teams", async () => {
    const owner = await ctx.createUser(tenantId);
    // Owned by this tenant, no membership row, but a member of its team.
    const guest = await ownedWithoutRow();
    const teamId = await team(owner);
    await addTeamMember(teamId, guest.id, "MEMBER");

    const res = await scimPostUser(jsonRequest("http://localhost/api/scim/v2/Users", "POST", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: guest.email,
      active: false,
    }));

    expect(res.status).toBe(201);
    expect(await membership(teamId, guest.id)).toMatchObject({ deactivated_by_tenant: true });
  });

  // ── Schema ───────────────────────────────────────────────────

  it("schema: the invitation created_at default is clock_timestamp(), and the marker needs a deactivated row", async () => {
    const [col] = await sql<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'team_invitations' AND column_name = 'created_at'`,
    );
    expect(col.column_default).toBe("clock_timestamp()");
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    await expect(
      sql(`UPDATE team_members SET deactivated_by_tenant = true WHERE team_id = $1::uuid`, teamId),
    ).rejects.toThrow(/team_members_departure_marker_deactivated/);
  });

  // ── A9: backfill ─────────────────────────────────────────────

  it("A9: the backfill marks legacy departures, expires exactly the invitations accept would refuse, and is idempotent", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const deactivate = (userId: string) =>
      sql(`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, userId);
    const stampOf = async (userId: string) =>
      (await sql<{ t: string }>(`SELECT deactivated_at::text AS t FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, userId))[0].t;
    const setCreatedAt = (invitationId: string, at: string) =>
      sql(`UPDATE team_invitations SET created_at = $2::timestamptz WHERE id = $1::uuid`, invitationId, at);

    // Arm 1: a legacy departure (row deactivated, membership left active),
    // a membership created after the departure, and a membership elsewhere.
    const leaver = await member();
    const otherOwner = await ctx.createUser(otherTenantId);
    const elsewhere = await team(otherOwner, otherTenantId);
    await addTeamMember(elsewhere, leaver.id, "MEMBER", otherTenantId);
    // Arm 2b: invitations to the leaver before (exact and other case), at, and after the departure.
    const before = await invite(teamId, owner, leaver.email);
    const beforeUpper = await invite(await team(owner), owner, leaver.email.toUpperCase());
    const atStamp = await invite(await team(owner), owner, leaver.email);
    const after = await invite(await team(owner), owner, leaver.email);
    // Arm 2a: an inviter who later departed, with one invitation before and one after.
    const inviter = await member();
    await addTeamMember(teamId, inviter.id, "ADMIN");
    const byInviterBefore = await invite(teamId, inviter.id, `a-${randomUUID().slice(0, 6)}@example.com`);
    const byInviterAfter = await invite(teamId, inviter.id, `b-${randomUUID().slice(0, 6)}@example.com`);
    for (const inv of [before, beforeUpper, atStamp, after, byInviterBefore, byInviterAfter]) expect(inv.status).toBe(201);
    await addTeamMember(teamId, leaver.id, "MEMBER");
    await deactivate(leaver.id);
    await deactivate(inviter.id);
    const later = await member();
    await deactivate(later.id);
    await addTeamMember(teamId, later.id, "MEMBER");
    await setCreatedAt(atStamp.id!, await stampOf(leaver.id));
    await sql(`UPDATE team_invitations SET created_at = (SELECT deactivated_at + interval '1 second' FROM tenant_members
      WHERE tenant_id = $2::uuid AND user_id = $3::uuid) WHERE id = $1::uuid`, after.id, tenantId, leaver.id);
    await sql(`UPDATE team_invitations SET created_at = (SELECT deactivated_at + interval '1 second' FROM tenant_members
      WHERE tenant_id = $2::uuid AND user_id = $3::uuid) WHERE id = $1::uuid`, byInviterAfter.id, tenantId, inviter.id);
    // Arm 2c: users SCIM-deleted before this change (no row), with and without the audit row.
    const deleted = await member();
    const noAudit = await member();
    const toDeleted = await invite(await team(owner), owner, deleted.email);
    const toDeletedAfter = await invite(await team(owner), owner, deleted.email);
    const toNoAudit = await invite(await team(owner), owner, noAudit.email);
    await sql(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = ANY($2::uuid[])`, tenantId, [deleted.id, noAudit.id]);
    await sql(
      `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, target_id, created_at)
       VALUES ($1::uuid, $2::uuid, 'TENANT', 'SCIM_USER_DELETE', $3::uuid, 'SYSTEM', $4, clock_timestamp())`,
      randomUUID(), tenantId, SYSTEM_ACTOR_ID, deleted.id,
    );
    await sql(`UPDATE team_invitations SET created_at = clock_timestamp() + interval '1 second' WHERE id = $1::uuid`, toDeletedAfter.id);

    const migration = readFileSync(
      join(process.cwd(), "prisma/migrations/20261101000000_team_tenant_departure/migration.sql"),
      "utf8",
    );
    const block = /-- BEGIN BACKFILL team-tenant-departure\n([\s\S]*?)-- END BACKFILL team-tenant-departure/.exec(migration)?.[1];
    expect(block).toBeDefined();

    const client = await side.pool.connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await client.query("BEGIN");
      await client.query(block!);
      const memberships = await client.query<{ team_id: string; user_id: string; deactivated_by_tenant: boolean }>(
        `SELECT team_id, user_id, deactivated_by_tenant FROM team_members WHERE user_id = ANY($1::uuid[])`,
        [[leaver.id, later.id]],
      );
      const marked = (teamIdOf: string, userId: string) =>
        memberships.rows.find((r) => r.team_id === teamIdOf && r.user_id === userId)?.deactivated_by_tenant;
      expect(marked(teamId, leaver.id)).toBe(true);
      expect(marked(elsewhere, leaver.id)).toBe(false);
      expect(marked(teamId, later.id)).toBe(false);

      const ids = [before, beforeUpper, atStamp, after, byInviterBefore, byInviterAfter, toDeleted, toDeletedAfter, toNoAudit].map((i) => i.id);
      const inv = await client.query<{ id: string; status: string }>(`SELECT id, status FROM team_invitations WHERE id = ANY($1::uuid[])`, [ids]);
      const status = Object.fromEntries(inv.rows.map((r) => [r.id, r.status]));
      expect({
        before: status[before.id!], beforeUpper: status[beforeUpper.id!], atStamp: status[atStamp.id!], after: status[after.id!],
        byInviterBefore: status[byInviterBefore.id!], byInviterAfter: status[byInviterAfter.id!],
        toDeleted: status[toDeleted.id!], toDeletedAfter: status[toDeletedAfter.id!], toNoAudit: status[toNoAudit.id!],
      }).toEqual({
        before: "EXPIRED", beforeUpper: "EXPIRED", atStamp: "EXPIRED", after: "PENDING",
        byInviterBefore: "EXPIRED", byInviterAfter: "PENDING",
        toDeleted: "EXPIRED", toDeletedAfter: "PENDING", toNoAudit: "PENDING",
      });
      const records = await client.query(`SELECT user_id FROM tenant_member_departures WHERE tenant_id = $1::uuid`, [tenantId]);
      expect(records.rows.map((r) => r.user_id)).toEqual([deleted.id]);

      // Second run: every change count is 0 (ownerless_teams is a census, not a change).
      notices.length = 0;
      await client.query(block!);
      const report = notices.find((n) => n.startsWith("team-tenant-departure backfill:"));
      expect(report).toBeDefined();
      const counts = Object.fromEntries([...report!.matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
      const { ownerless_teams: _census, ...changes } = counts;
      expect(Object.values(changes).every((n) => n === 0)).toBe(true);
      expect(Object.keys(changes)).toHaveLength(5);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  // ── A10: races ───────────────────────────────────────────────

  describe("A10: races", () => {
    it("departure waits for an accept holding the invitee's tenant row; the accept commits first and the departure ends it", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await scimActive(leaver.id, false);
      await scimActive(leaver.id, true);
      const inv = await invite(teamId, owner, leaver.email);
      // Park the accept at its invitation claim, after its tenant-row lock.
      const blocker = await race.holdRowLock(`SELECT id FROM team_invitations WHERE id = $1::uuid FOR UPDATE`, [inv.id]);
      let accepting: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        accepting = accept(leaver, inv.token!);
        const acceptPid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(leaver.id, false);
        expect(await race.settledOrBlocked(departing, acceptPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await accepting).status).toBe(200);
        expect((await departing).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([accepting, departing]);
      }
      expect(await membership(teamId, leaver.id)).toMatchObject({ deactivated_by_tenant: true });
    });

    it("an accept of an invitation the departing user issued waits for the departure and is refused, without a deadlock", async () => {
      const owner = await ctx.createUser(tenantId);
      const inviter = await member();
      const invitee = await member(otherTenantId);
      const teamId = await team(owner);
      await addTeamMember(teamId, inviter.id, "ADMIN");
      const inv = await invite(teamId, inviter.id, invitee.email);
      // Park the departure at its team lock (step 3), holding the inviter's row.
      const standIn = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let departing: Promise<Response> | undefined;
      let accepting: Promise<Response> | undefined;
      try {
        departing = scimActive(inviter.id, false);
        const departPid = await race.waitForBackendBlockedBy(standIn.pid);
        accepting = accept(invitee, inv.token!);
        expect(await race.settledOrBlocked(accepting, departPid, standIn.pid)).toBe("blocked-on-parked");
        await standIn.release();
        expect((await departing).status).toBe(200);
        expect((await accepting).status).toBe(410);
        expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
      } finally {
        await standIn.release();
        await Promise.allSettled([departing, accepting]);
      }
      expect(await membership(teamId, invitee.id)).toBeNull();
    });

    it("a departure stamps after its locks: an invitation committed after its transaction began but before its lock is refused", async () => {
      // now() would stamp the transaction start, before this invitation; the
      // database clock read in the UPDATE after the lock stamps after it.
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      // Park the departure's transaction before its first lock, on a row
      // nothing else in the cell touches with a conflicting mode (the
      // invitation's FK takes KEY SHARE on the tenant row).
      const blocker = await race.holdRowLock(`SELECT id FROM tenants WHERE id = $1::uuid FOR NO KEY UPDATE`, [tenantId]);
      let departing: Promise<string[]> | undefined;
      try {
        departing = withTenantRls(prisma, tenantId, async (tx) => {
          await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR NO KEY UPDATE`;
          return departFromTenant(tx, tenantId, [leaver.id], { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } });
        }, { timeout: 15_000 });
        await race.waitForBackendBlockedBy(blocker.pid);
        const issued = await invite(teamId, owner, leaver.email);
        expect(issued.status).toBe(201);
        await blocker.release();
        expect(await departing).toEqual([leaver.id]);
        await moveAway(leaver.id);
        expect((await accept(leaver, issued.token!)).status).toBe(410);
        expect(await invitationStatus(issued.id!)).toBe("EXPIRED");
      } finally {
        await blocker.release();
        await Promise.allSettled([departing]);
      }
    });

    it("members POST holding the target's tenant row is waited for; the departure then ends the new membership", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const teamId = await team(owner);
      const standIn = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let adding: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: owner } });
        adding = addMember(jsonRequest(`http://localhost/api/teams/${teamId}/members`, "POST", { userId: user.id, role: "MEMBER" }), {
          params: Promise.resolve({ teamId }),
        });
        const addPid = await race.waitForBackendBlockedBy(standIn.pid);
        departing = scimActive(user.id, false);
        expect(await race.settledOrBlocked(departing, addPid, standIn.pid)).toBe("blocked-on-parked");
        await standIn.release();
        expect((await adding).status).toBe(201);
        expect((await departing).status).toBe(200);
      } finally {
        await standIn.release();
        await Promise.allSettled([adding, departing]);
      }
      expect(await membership(teamId, user.id)).toMatchObject({ deactivated_by_tenant: true });
    });

    it("a SCIM POST creating a membership deactivated waits for an admission holding the user's creation lock", async () => {
      // Through the routes this race has no admitting side: a user with no row
      // here can only act while active in another tenant, which then owns them
      // and SCIM POST refuses to create the row (deviation D4). The cell holds
      // the lock an admission takes for a row-less user (lockTenantRows' advisory
      // lock, key format of tenant-row-lock.ts) and witnesses the create waiting.
      const owner = await ctx.createUser(tenantId);
      const user = await ownedWithoutRow();
      const teamId = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER");
      const admission = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`tenant-member:${tenantId}:${user.id}`]);
      let creating: Promise<Response> | undefined;
      try {
        creating = scimPostUser(jsonRequest("http://localhost/api/scim/v2/Users", "POST", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: user.email, active: false,
        }));
        await race.waitForBackendBlockedBy(admission.pid);
        expect(await membership(teamId, user.id)).toMatchObject({ deactivated_at: null });
        await admission.release();
        expect((await creating).status).toBe(201);
      } finally {
        await admission.release();
        await Promise.allSettled([creating]);
      }
      expect(await membership(teamId, user.id)).toMatchObject({ deactivated_by_tenant: true });
    });

    it("a two-user batch departure and an accept locking the same rows in reverse order do not deadlock", async () => {
      const owner = await ctx.createUser(tenantId);
      const [a, b] = [await member(), await member()].sort((x, y) => x.id.localeCompare(y.id));
      const teamId = await team(owner);
      await addTeamMember(teamId, b.id, "ADMIN");
      // An invitation from b (inviter) to a (invitee): accept locks [a, b].
      const inv = await invite(teamId, b.id, a.email);
      const standIn = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let departing: Promise<string[]> | undefined;
      let accepting: Promise<Response> | undefined;
      try {
        departing = withTenantRls(prisma, tenantId, async (tx) => {
          const budget = createLockBudget(8_000);
          await lockTenantRows(tx, tenantId, [b.id, a.id], "update", budget);
          return departFromTenant(tx, tenantId, [b.id, a.id], {
            actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM },
            budget,
            alreadyLocked: true,
          });
        }, { timeout: 15_000 });
        const departPid = await race.waitForBackendBlockedBy(standIn.pid);
        accepting = accept(a, inv.token!);
        expect(await race.settledOrBlocked(accepting, departPid, standIn.pid)).toBe("blocked-on-parked");
        await standIn.release();
        expect(await departing).toEqual(expect.arrayContaining([a.id, b.id]));
        expect((await accepting).status).toBe(410);
        expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
      } finally {
        await standIn.release();
        await Promise.allSettled([departing, accepting]);
      }
    });
  });

  // ── A11: lock wait ───────────────────────────────────────────

  it("A11: a tenant row held past the lock wait fails the departure with the tenant-row error inside the deadline", async () => {
    const user = await member();
    const blocker = await race.holdRowLock(
      `SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid FOR SHARE`,
      [tenantId, user.id],
    );
    const releaseAfter = setTimeout(() => void blocker.release(), TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
    try {
      const started = Date.now();
      await expect(
        withTenantRls(prisma, tenantId, (tx) =>
          departFromTenant(tx, tenantId, [user.id], { actor: { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM } }),
          { timeout: 15_000 },
        ),
      ).rejects.toBeInstanceOf(TenantMemberLockTimeoutError);
      expect(Date.now() - started).toBeLessThan(TEAM_KEY_LOCK_TIMEOUT_MS + 1_500);
    } finally {
      clearTimeout(releaseAfter);
      await blocker.release();
    }
    expect((await tenantRow(tenantId, user.id))?.deactivated_at).toBeNull();
  });
  // ── Review round 1 ───────────────────────────────────────────

  function memberKeyBody(userId: string, keyVersion: number) {
    return {
      userId,
      encryptedTeamKey: hex(32),
      teamKeyIv: hex(12),
      teamKeyAuthTag: hex(16),
      ephemeralPublicKey: hex(32),
      hkdfSalt: hex(32),
      keyVersion,
      wrapVersion: 1,
    };
  }

  it("an inviter whose departure committed after the permission check cannot issue an invitation", async () => {
    const owner = await ctx.createUser(tenantId);
    const inviter = await member();
    const invitee = await member(otherTenantId);
    const teamId = await team(owner);
    const inviterRow = await addTeamMember(teamId, inviter.id, "ADMIN");
    await scimActive(inviter.id, false);
    // The route's pre-transaction check still sees the membership it had.
    stalePermission.membership = { id: inviterRow, role: "ADMIN" };

    const res = await invite(teamId, inviter.id, invitee.email);

    expect(res.status).toBe(403);
    expect(await sql(`SELECT 1 FROM team_invitations WHERE team_id = $1::uuid`, teamId)).toEqual([]);
  });

  it("an active guest ADMIN from another tenant still issues invitations", async () => {
    const owner = await ctx.createUser(tenantId);
    const guest = await member(otherTenantId);
    const teamId = await team(owner);
    await addTeamMember(teamId, guest.id, "ADMIN", tenantId);

    expect((await invite(teamId, guest.id, `x-${randomUUID().slice(0, 6)}@example.com`)).status).toBe(201);
  });

  /** The GET is typed without arguments, but withRequestLog reads the request. */
  const pendingFor = () =>
    (pendingDistributions as unknown as (req: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/teams/pending-key-distributions"),
    );

  it("A1/A4: a rotation leaves a departed member out and pending; after a return confirm-key distributes the new version", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    await sql(`UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, leaver.id, hex(32));
    const teamId = await team(owner);
    const rowId = await addTeamMember(teamId, leaver.id, "MEMBER");
    await scimActive(leaver.id, false);

    mockAuth.mockResolvedValue({ user: { id: owner } });
    const rotated = await rotateKey(
      jsonRequest(`http://localhost/api/teams/${teamId}/rotate-key`, "POST", {
        newTeamKeyVersion: 2, entries: [], memberKeys: [memberKeyBody(owner, 2)],
      }),
      { params: Promise.resolve({ teamId }) },
    );
    expect(rotated.status).toBe(200);
    expect(await membership(teamId, leaver.id)).toMatchObject({ key_distributed: false });
    const pendingWhileGone = await (await pendingFor()).json();
    expect(JSON.stringify(pendingWhileGone)).not.toContain(rowId);

    await scimActive(leaver.id, true);
    const pendingAfterReturn = await (await pendingFor()).json();
    expect(JSON.stringify(pendingAfterReturn)).toContain(rowId);
    const confirmed = await confirmKey(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${rowId}/confirm-key`, "POST", { ...memberKeyBody(leaver.id, 2), userId: undefined }),
      { params: Promise.resolve({ teamId, memberId: rowId }) },
    );
    expect(confirmed.status).toBe(200);
    expect(await membership(teamId, leaver.id)).toMatchObject({ key_distributed: true });
    const versions = await sql<{ key_version: number }>(
      `SELECT key_version FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
      teamId, leaver.id,
    );
    expect(versions.map((v) => v.key_version)).toEqual([1, 2]);
  });

  it("A2/A6: mixed-case addresses — a stale lowercase invitation is replaced by an uppercase one, accepted under a third spelling", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    const teamId = await team(owner);
    const stale = await invite(teamId, owner, leaver.email.toLowerCase());
    await scimActive(leaver.id, false);
    await moveAway(leaver.id);

    const fresh = await invite(teamId, owner, leaver.email.toUpperCase());

    expect(fresh.status).toBe(201);
    expect(await invitationStatus(stale.id!)).toBe("EXPIRED");
    const mixed = leaver.email.charAt(0).toUpperCase() + leaver.email.slice(1);
    expect((await accept({ id: leaver.id, email: mixed }, fresh.token!)).status).toBe(200);
  });

  it("A2: refuses a pre-departure invitation to a user filed under another tenant", async () => {
    const owner = await ctx.createUser(tenantId);
    const leaver = await member();
    await sql(`UPDATE users SET tenant_id = $2::uuid WHERE id = $1::uuid`, leaver.id, otherTenantId);
    const teamId = await team(owner);
    const inv = await invite(teamId, owner, leaver.email);
    await scimActive(leaver.id, false);
    await moveAway(leaver.id);

    expect((await accept(leaver, inv.token!)).status).toBe(410);
    expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
  });

  describe("A10: races (review round 1)", () => {
    it("SCIM DELETE waits for an accept holding the invitee's row; the accepted membership is then removed", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const teamId = await team(owner);
      const inv = await invite(teamId, owner, user.email);
      const blocker = await race.holdRowLock(`SELECT id FROM team_invitations WHERE id = $1::uuid FOR UPDATE`, [inv.id]);
      let accepting: Promise<Response> | undefined;
      let deleting: Promise<Response> | undefined;
      try {
        accepting = accept(user, inv.token!);
        const acceptPid = await race.waitForBackendBlockedBy(blocker.pid);
        deleting = scimDelete(user.id);
        expect(await race.settledOrBlocked(deleting, acceptPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await accepting).status).toBe(200);
        expect((await deleting).status).toBe(204);
      } finally {
        await blocker.release();
        await Promise.allSettled([accepting, deleting]);
      }
      expect(await membership(teamId, user.id)).toBeNull();
      expect(await sql(`SELECT 1 FROM tenant_member_departures WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, user.id)).toHaveLength(1);
    });

    it("SCIM DELETE first: an accept waiting on the deleted row is refused by the departure record", async () => {
      // The user left this tenant for another (active there), keeping a marked
      // membership here; a re-invitation is pending when the IdP deletes them.
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER");
      await scimActive(user.id, false);
      await moveAway(user.id);
      const inv = await invite(teamId, owner, user.email);
      expect(inv.status).toBe(201);
      // Park the deletion at its team lock, holding the user's row FOR UPDATE.
      const standIn = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let deleting: Promise<Response> | undefined;
      let accepting: Promise<Response> | undefined;
      try {
        deleting = scimDelete(user.id);
        const deletePid = await race.waitForBackendBlockedBy(standIn.pid);
        accepting = accept(user, inv.token!);
        expect(await race.settledOrBlocked(accepting, deletePid, standIn.pid)).toBe("blocked-on-parked");
        await standIn.release();
        expect((await deleting).status).toBe(204);
        expect((await accepting).status).toBe(410);
      } finally {
        await standIn.release();
        await Promise.allSettled([deleting, accepting]);
      }
      expect(await membership(teamId, user.id)).toBeNull();
      expect(await invitationStatus(inv.id!)).toBe("EXPIRED");
    });

    it("a departure waits for a team create holding the creator's row, then ends the new ownership", async () => {
      const creator = await ctx.createUser(tenantId);
      await sql(`UPDATE tenant_members SET role = 'ADMIN' WHERE user_id = $1::uuid`, creator);
      const teamId = randomUUID();
      // Park the create at its teams INSERT (FK KEY SHARE on the tenant row).
      const blocker = await race.holdRowLock(`SELECT id FROM tenants WHERE id = $1::uuid FOR UPDATE`, [tenantId]);
      let creating: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: creator } });
        creating = createTeam(jsonRequest("http://localhost/api/teams", "POST", {
          id: teamId, name: "Raced", slug: `raced-${teamId.slice(0, 6)}`,
          teamMemberKey: { ...memberKeyBody(creator, 1), userId: undefined },
        }));
        const createPid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(creator, false);
        expect(await race.settledOrBlocked(departing, createPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await creating).status).toBe(201);
      } finally {
        await blocker.release();
        await Promise.allSettled([creating, departing]);
      }
      // The creator was tenant ADMIN, not OWNER: the departure applies.
      expect((await departing!).status).toBe(200);
      expect(await membership(teamId, creator)).toMatchObject({ role: "OWNER", deactivated_by_tenant: true });
    });

    it("a departure of the target waits for an owner assignment holding their row; the team is then ownerless again", async () => {
      const admin = await ctx.createUser(tenantId);
      await sql(`UPDATE tenant_members SET role = 'ADMIN' WHERE user_id = $1::uuid`, admin);
      const oldOwner = await member();
      const successor = await member();
      const teamId = await team(oldOwner.id);
      const successorRow = await addTeamMember(teamId, successor.id, "MEMBER");
      await scimActive(oldOwner.id, false);
      // Park the assignment at its promote, after its tenant-row locks.
      const blocker = await race.holdRowLock(`SELECT id FROM team_members WHERE id = $1::uuid FOR UPDATE`, [successorRow]);
      let assigning: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: admin } });
        assigning = assignOwner(jsonRequest(`http://localhost/api/tenant/teams/${teamId}/owner`, "POST", { userId: successor.id }), {
          params: Promise.resolve({ teamId }),
        });
        const assignPid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(successor.id, false);
        expect(await race.settledOrBlocked(departing, assignPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await assigning).status).toBe(200);
        expect((await departing).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([assigning, departing]);
      }
      expect(await membership(teamId, successor.id)).toMatchObject({ role: "OWNER", deactivated_by_tenant: true });
    });

    it("an invitation POST to a departing user waits for the departure, then issues a post-departure invitation", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      const otherTeam = await team(owner);
      await addTeamMember(otherTeam, leaver.id, "MEMBER");
      const standIn = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [otherTeam]);
      let departing: Promise<Response> | undefined;
      let issuing: Promise<{ status: number; id?: string; token?: string }> | undefined;
      try {
        departing = scimActive(leaver.id, false);
        const departPid = await race.waitForBackendBlockedBy(standIn.pid);
        issuing = invite(teamId, owner, leaver.email);
        expect(await race.settledOrBlocked(issuing, departPid, standIn.pid)).toBe("blocked-on-parked");
        await standIn.release();
        expect((await departing).status).toBe(200);
        expect((await issuing).status).toBe(201);
      } finally {
        await standIn.release();
        await Promise.allSettled([departing, issuing]);
      }
      await moveAway(leaver.id);
      expect((await accept(leaver, (await issuing!).token!)).status).toBe(200);
    });

    it("a departure waits for an in-flight rotation of the user's team; the user ends deactivated", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, leaver.id, "MEMBER");
      // Park the rotation at its member-key insert (FK KEY SHARE on the owner's users row).
      const blocker = await race.holdRowLock(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [owner]);
      let rotating: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: owner } });
        rotating = rotateKey(
          jsonRequest(`http://localhost/api/teams/${teamId}/rotate-key`, "POST", {
            newTeamKeyVersion: 2, entries: [], memberKeys: [memberKeyBody(owner, 2), memberKeyBody(leaver.id, 2)],
          }),
          { params: Promise.resolve({ teamId }) },
        );
        const rotatePid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(leaver.id, false);
        expect(await race.settledOrBlocked(departing, rotatePid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await rotating).status).toBe(200);
        expect((await departing).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([rotating, departing]);
      }
      expect(await membership(teamId, leaver.id)).toMatchObject({ deactivated_by_tenant: true });
    });
  });
});
