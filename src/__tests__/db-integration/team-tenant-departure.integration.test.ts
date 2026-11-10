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
import type pg from "pg";
import {
  appConnectionString,
  assertRlsApplies,
  BYPASS_ROLE_KIND,
  collectNotices,
  createPrismaForRole,
  createTestContext,
  enterBypassRole,
  expectBypassNotices,
  gucSentinels,
  parseNoticeCounts,
  readBackfillBlock,
  readGucs,
  RLS_BACKFILL_RERUN_DIR,
  setBypassRlsGucs,
  setGucs,
  setTestBypass,
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
import { departFromTenant, TENANT_MEMBERSHIP_SOURCE } from "@/lib/team/team-departure";
import { advisoryKey, lockTenantRows, TenantMemberLockTimeoutError } from "@/lib/team/tenant-row-lock";
import { createPool } from "@/lib/db/pool-factory";
import { buildOutboxPayload } from "@/lib/audit/audit-payload";
import { deliverRow, type AuditOutboxRow } from "@/workers/audit-outbox-worker";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";

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
    // SCIM responses build their location from the app origin; CI sets none.
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    scimTenant.id = tenantId;
    stalePermission.membership = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
    vi.unstubAllEnvs();
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
    const [row] = await sql<{ id: string; deactivated_at: Date | null; deactivated_by_tenant: boolean; key_distributed: boolean; scim_managed: boolean; scim_approval_pending: boolean; role: string }>(
      `SELECT id, deactivated_at, deactivated_by_tenant, key_distributed, scim_managed, scim_approval_pending, role
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

  it("A7: a SCIM group add leaves a deactivated membership PENDING team approval, without stale keys (scim-team-admission-approval)", async () => {
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

    // No longer reactivated in place: pending team approval (scim-team-admission-approval, C2).
    expect(await membership(teamId, user.id)).toMatchObject({
      deactivated_by_tenant: false, key_distributed: false, scim_approval_pending: true,
    });
    expect((await membership(teamId, user.id))?.deactivated_at).not.toBeNull();
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

    // Outcome only: lockTenantRows sorts its ids, so the order passed here
    // cannot cross; the no-deadlock rule (one tenant-row call before any team
    // lock) is pinned by check-team-rotation-input-lock rule 4.
    it("a two-user departure orders an accept of an invitation between them behind it; the accept is refused", async () => {
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

  it("restores the transaction's statement_timeout after a bounded wait", async () => {
    const user = await member();
    const [before, after] = await withTenantRls(prisma, tenantId, async (tx) => {
      const [b] = await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('statement_timeout') AS s`;
      await lockTenantRows(tx, tenantId, [user.id], "share", createLockBudget());
      const [a] = await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('statement_timeout') AS s`;
      return [b.s, a.s];
    });
    expect(after).toBe(before);
  });

  it("two advisory locks each held for less than the wait still refuse within the budget as a whole", async () => {
    // lock_timeout applies per lock: held 2s then 4s, each wait alone fits in
    // 3s but the statement would wait 4s. statement_timeout bounds it whole.
    // Sorted: the locks are taken in key order, so the shorter hold comes
    // first and each single wait stays under lock_timeout.
    const [a, b] = [await member(), await member()].sort((x, y) => x.id.localeCompare(y.id));
    const holdA = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`tenant-member:${tenantId}:${a.id}`]);
    const holdB = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`tenant-member:${tenantId}:${b.id}`]);
    const releaseA = setTimeout(() => void holdA.release(), 2_000);
    const releaseB = setTimeout(() => void holdB.release(), 4_000);
    try {
      const started = Date.now();
      await expect(
        withTenantRls(prisma, tenantId, (tx) => lockTenantRows(tx, tenantId, [a.id, b.id], "share", createLockBudget()), { timeout: 15_000 }),
      ).rejects.toBeInstanceOf(TenantMemberLockTimeoutError);
      expect(Date.now() - started).toBeLessThan(TEAM_KEY_LOCK_TIMEOUT_MS + 500);
    } finally {
      clearTimeout(releaseA);
      clearTimeout(releaseB);
      await holdA.release();
      await holdB.release();
    }
  });

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

    it("a departure of the acting tenant ADMIN waits for the owner assignment they are making", async () => {
      // The actor need not be a member of the team, so the team lock does not
      // see their departure: only the actor's tenant row, held FOR SHARE, does.
      const admin = await ctx.createUser(tenantId);
      await sql(`UPDATE tenant_members SET role = 'ADMIN' WHERE user_id = $1::uuid`, admin);
      const oldOwner = await member();
      const successor = await member();
      const teamId = await team(oldOwner.id);
      const successorRow = await addTeamMember(teamId, successor.id, "MEMBER");
      await scimActive(oldOwner.id, false);
      const blocker = await race.holdRowLock(`SELECT id FROM team_members WHERE id = $1::uuid FOR UPDATE`, [successorRow]);
      let assigning: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: admin } });
        assigning = assignOwner(jsonRequest(`http://localhost/api/tenant/teams/${teamId}/owner`, "POST", { userId: successor.id }), {
          params: Promise.resolve({ teamId }),
        });
        const assignPid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(admin, false);
        expect(await race.settledOrBlocked(departing, assignPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await assigning).status).toBe(200);
        expect((await departing).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([assigning, departing]);
      }
      // The assignment committed before the actor's departure, and stands.
      expect(await membership(teamId, successor.id)).toMatchObject({ role: "OWNER", deactivated_at: null });
      expect(await membership(teamId, oldOwner.id)).toMatchObject({ role: "ADMIN" });
      expect((await tenantRow(tenantId, admin))?.deactivated_at).not.toBeNull();
    });

    it("a departure of the target waits for an owner assignment holding the team; the team is then ownerless again", async () => {
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
  describe("A10: the acting member's departure waits for their members request", () => {
    /** An admin (team ADMIN, tenant MEMBER) acting on `target` in their team. */
    async function setup() {
      const owner = await ctx.createUser(tenantId);
      const actor = await member();
      const target = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, actor.id, "ADMIN");
      return { teamId, actor, target };
    }

    async function raceActorDeparture(blockSql: string, params: unknown[], request: () => Promise<Response>, actorId: string) {
      const blocker = await race.holdRowLock(blockSql, params);
      let requesting: Promise<Response> | undefined;
      let departing: Promise<Response> | undefined;
      try {
        mockAuth.mockResolvedValue({ user: { id: actorId } });
        requesting = request();
        const requestPid = await race.waitForBackendBlockedBy(blocker.pid);
        departing = scimActive(actorId, false);
        const reached = await race.settledOrBlocked(departing, requestPid, blocker.pid);
        await blocker.release();
        return { reached, request: await requesting, departure: await departing };
      } finally {
        await blocker.release();
        await Promise.allSettled([requesting, departing]);
      }
    }

    it("members POST", async () => {
      const { teamId, actor, target } = await setup();
      // Parked at the membership insert (FK KEY SHARE on the target's users row).
      const res = await raceActorDeparture(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [target.id], () =>
        addMember(jsonRequest(`http://localhost/api/teams/${teamId}/members`, "POST", { userId: target.id, role: "MEMBER" }), {
          params: Promise.resolve({ teamId }),
        }), actor.id);
      expect(res.reached).toBe("blocked-on-parked");
      expect(res.request.status).toBe(201);
      expect(res.departure.status).toBe(200);
    });

    it("members DELETE", async () => {
      const { teamId, actor, target } = await setup();
      const rowId = await addTeamMember(teamId, target.id, "MEMBER");
      // Parked at the delete of the target's row.
      const res = await raceActorDeparture(`SELECT id FROM team_members WHERE id = $1::uuid FOR UPDATE`, [rowId], () =>
        removeMember(new NextRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, { method: "DELETE" }), {
          params: Promise.resolve({ teamId, memberId: rowId }),
        }), actor.id);
      expect(res.reached).toBe("blocked-on-parked");
      expect(res.request.status).toBe(200);
      expect(res.departure.status).toBe(200);
      expect(await membership(teamId, target.id)).toBeNull();
      expect(await membership(teamId, actor.id)).toMatchObject({ deactivated_by_tenant: true });
    });

    it("members PUT (role change)", async () => {
      const { teamId, actor, target } = await setup();
      const rowId = await addTeamMember(teamId, target.id, "VIEWER");
      // Parked at the role update of the target's row.
      const res = await raceActorDeparture(`SELECT id FROM team_members WHERE id = $1::uuid FOR UPDATE`, [rowId], () =>
        changeRole(jsonRequest(`http://localhost/api/teams/${teamId}/members/${rowId}`, "PUT", { role: "MEMBER" }), {
          params: Promise.resolve({ teamId, memberId: rowId }),
        }), actor.id);
      expect(res.reached).toBe("blocked-on-parked");
      expect(res.request.status).toBe(200);
      expect(res.departure.status).toBe(200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: "MEMBER" });
      expect(await membership(teamId, actor.id)).toMatchObject({ deactivated_by_tenant: true });
    });
  });

  // ── C1: 20261110000000_rls_backfill_rerun, departure block ───

  describe("C1: rls_backfill_rerun — team-tenant-departure-rerun", () => {
    const ORIGINAL_DIR = "20261101000000_team_tenant_departure";
    const DEACTIVATE = "TEAM_MEMBER_TENANT_DEACTIVATE";
    /** Every table the departure block references (its app.bypass_tables literal). */
    const BLOCK_TABLES = [
      "tenant_members", "tenant_member_departures", "teams", "team_invitations",
      "team_members", "users", "audit_logs", "audit_outbox",
    ] as const;
    /** The tables the original block references (no audit_outbox). */
    const ORIGINAL_TABLES = BLOCK_TABLES.filter((t) => t !== "audit_outbox");
    const SECOND = 1000;

    let appPool: pg.Pool;
    beforeAll(() => {
      appPool = createPool({ connectionString: appConnectionString(), max: 3 });
    });
    afterAll(async () => {
      await appPool.end();
    });

    type Fx = {
      stamp: Date;
      at: (ms: number) => string;
      teamX: string;
      teamY: string;
      ownerId: string;
      rows: Record<string, { rowId: string; userId: string }>;
      invitations: Record<string, string>;
      deletedUsers: Record<string, string>;
    };

    /**
     * Committed through the superuser helper. Every synthetic timestamp is the
     * departure stamp -1 s / = / +1 s; the one membership built through the real
     * routes (readmitOutbox) keeps its own clocks.
     */
    async function seedFixtures(): Promise<Fx> {
      const stamp = new Date(Math.floor(Date.now() / SECOND) * SECOND - 2 * 3_600_000);
      const at = (ms: number) => new Date(stamp.getTime() + ms).toISOString();
      const ownerId = await ctx.createUser(tenantId);
      const teamX = await team(ownerId);
      const teamY = await team(ownerId);
      const rows: Fx["rows"] = {};
      const invitations: Fx["invitations"] = {};
      const deletedUsers: Fx["deletedUsers"] = {};

      /** A MEMBER of the tenant whose row departed at the stamp. */
      async function departed(): Promise<{ id: string; email: string }> {
        const u = await member();
        await sql(
          `UPDATE tenant_members SET deactivated_at = $3::timestamptz WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
          tenantId, u.id, stamp.toISOString(),
        );
        return u;
      }
      async function membershipAt(name: string, teamId: string, userId: string, createdAt: string, tenant = tenantId) {
        const rowId = await addTeamMember(teamId, userId, "MEMBER", tenant);
        await sql(`UPDATE team_members SET created_at = $2::timestamptz WHERE id = $1::uuid`, rowId, createdAt);
        rows[name] = { rowId, userId };
      }
      /** A departed member with an active membership of team X created `offset` ms from the stamp. */
      async function leaked(name: string, offset = -SECOND): Promise<string> {
        const u = await departed();
        await membershipAt(name, teamX, u.id, at(offset));
        return u.id;
      }
      const logsRecord = (o: { action?: string; targetId: string; tenant?: string; teamId?: string; createdAt?: string }) =>
        sql(
          `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, team_id, target_type, target_id, created_at)
           VALUES ($1::uuid, $2::uuid, 'TEAM', $3::"AuditAction", $4::uuid, 'SYSTEM', $5::uuid, 'TeamMember', $6, COALESCE($7::timestamptz, now()))`,
          randomUUID(), o.tenant ?? tenantId, o.action ?? DEACTIVATE, SYSTEM_ACTOR_ID, o.teamId ?? teamX, o.targetId, o.createdAt ?? null,
        );
      const outboxRecord = (o: { action?: string; targetId: string; tenant?: string; teamId?: string; status?: string; createdAt?: string }) =>
        sql(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, sent_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::"AuditOutboxStatus", COALESCE($5::timestamptz, now()),
                   CASE WHEN $4 = 'SENT' THEN now() END)`,
          randomUUID(), o.tenant ?? tenantId,
          JSON.stringify({
            scope: "TEAM", action: o.action ?? DEACTIVATE, userId: SYSTEM_ACTOR_ID, actorType: "SYSTEM", serviceAccountId: null,
            teamId: o.teamId ?? teamX, targetType: "TeamMember", targetId: o.targetId, metadata: { source: "TENANT_DEACTIVATION" }, ip: null, userAgent: null,
          }),
          o.status ?? "PENDING", o.createdAt ?? null,
        );
      const invitationAt = async (name: string, teamId: string, inviterId: string, email: string, createdAt: string, status = "PENDING") => {
        const id = randomUUID();
        await sql(
          `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token, expires_at, invited_by_id, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', $5::"InvitationStatus", $6, now() + interval '7 days', $7::uuid, $8::timestamptz, now())`,
          id, teamId, tenantId, email, status, hex(16), inviterId, createdAt,
        );
        invitations[name] = id;
      };

      // Memberships. "leak": the defect's subject; "late": created after the departure.
      const leakUser = await leaked("leak");
      await leaked("late", SECOND);
      // The leaked user's membership of another tenant's team: its tenant row there is active.
      await joinTenant(leakUser, otherTenantId);
      const otherOwner = await ctx.createUser(otherTenantId);
      const otherTeam = await team(otherOwner, otherTenantId);
      await membershipAt("leakElsewhere", otherTeam, leakUser, at(-SECOND), otherTenantId);

      // Re-admission through the real routes: the app ended the membership at the departure
      // (its record is the PENDING outbox row), the user returned elsewhere, and accept re-admitted them.
      const readmit = await member();
      await addTeamMember(teamX, readmit.id, "MEMBER");
      expect((await scimActive(readmit.id, false)).status).toBe(200);
      await moveAway(readmit.id);
      const reinvite = await invite(teamX, ownerId, readmit.email);
      expect((await accept(readmit, reinvite.token!)).status).toBe(200);
      rows.readmitOutbox = { rowId: (await membership(teamX, readmit.id))!.id, userId: readmit.id };

      // Evidence arms, each with a membership created before the departure.
      const recLogs = await leaked("recLogs");
      await logsRecord({ targetId: recLogs });
      const recSent = await leaked("recSent");
      await outboxRecord({ targetId: recSent, status: "SENT" });
      const spareRecorded = await leaked("spareRecorded", SECOND);
      await outboxRecord({ targetId: spareRecorded });
      const recOtherTeamLogs = await leaked("recOtherTeamLogs");
      await logsRecord({ targetId: recOtherTeamLogs, teamId: teamY });
      const recOtherTeamOutbox = await leaked("recOtherTeamOutbox");
      await outboxRecord({ targetId: recOtherTeamOutbox, teamId: teamY });
      const recTimeLogs = await leaked("recTimeLogs");
      await logsRecord({ targetId: recTimeLogs, createdAt: at(-SECOND) });
      const recTimeOutbox = await leaked("recTimeOutbox");
      await outboxRecord({ targetId: recTimeOutbox, createdAt: at(-SECOND) });

      // An ACCEPTED post-departure invitation is not evidence.
      const accepted = await departed();
      await membershipAt("accepted", teamX, accepted.id, at(-SECOND));
      await invitationAt("acceptedInvitation", teamX, ownerId, accepted.email, at(SECOND), "ACCEPTED");

      // Negative records, one per arm: a different action, a different target user, another tenant.
      const stranger = (await member()).id;
      for (const arm of ["Logs", "Outbox"] as const) {
        const record = arm === "Logs" ? logsRecord : outboxRecord;
        const action = await leaked(`negAction${arm}`);
        await record({ targetId: action, action: "TEAM_MEMBER_TENANT_RESTORE" });
        const target = await leaked(`negTarget${arm}`);
        await record({ targetId: stranger });
        expect(target).not.toBe(stranger);
        const tenantOnly = await leaked(`negTenant${arm}`);
        await record({ targetId: tenantOnly, tenant: otherTenantId });
      }

      // Invitations around the stamp, by an inviter who departed and to an invitee who departed.
      const inviter = await departed();
      for (const [name, offset] of [["byBefore", -SECOND], ["byAt", 0], ["byAfter", SECOND]] as const) {
        await invitationAt(name, teamX, inviter.id, `${name}-${hex(4)}@example.com`, at(offset));
      }
      const invitee = await departed();
      for (const [name, offset] of [["toBefore", -SECOND], ["toAt", 0], ["toAfter", SECOND]] as const) {
        await invitationAt(name, teamX, ownerId, invitee.email, at(offset));
      }
      await invitationAt("toBeforeUpper", teamY, ownerId, invitee.email.toUpperCase(), at(-SECOND));

      // SCIM-deleted users (no tenant row): with an audit row, without, and with an
      // existing record earlier than its audit row.
      const deleted = await member();
      const noAudit = await member();
      const kept = await member();
      await sql(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = ANY($2::uuid[])`, tenantId, [deleted.id, noAudit.id, kept.id]);
      for (const user of [deleted, kept]) {
        await sql(
          `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, target_id, created_at)
           VALUES ($1::uuid, $2::uuid, 'TENANT', 'SCIM_USER_DELETE', $3::uuid, 'SYSTEM', $4, $5::timestamptz)`,
          randomUUID(), tenantId, SYSTEM_ACTOR_ID, user.id, at(0),
        );
      }
      await sql(
        `INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES ($1::uuid, $2::uuid, $3::timestamptz)`,
        tenantId, kept.id, at(-2 * SECOND),
      );
      await invitationAt("toDeletedBefore", teamX, ownerId, deleted.email, at(-SECOND));
      await invitationAt("toDeletedAfter", teamY, ownerId, deleted.email, at(SECOND));
      await invitationAt("toNoAudit", teamX, ownerId, noAudit.email, at(-SECOND));
      await invitationAt("toKept", teamX, ownerId, kept.email, at(-SECOND));
      Object.assign(deletedUsers, { deleted: deleted.id, noAudit: noAudit.id, kept: kept.id });
      return { stamp, at, teamX, teamY, ownerId, rows, invitations, deletedUsers };
    }

    type State = {
      memberships: Record<string, string>;
      invitations: Record<string, string>;
      records: Record<string, string | null>;
    };

    /** Reads every fixture back; the client must see all rows (superuser, or a test bypass). */
    async function readState(client: pg.PoolClient, fx: Fx): Promise<State> {
      const names = Object.keys(fx.rows);
      const m = await client.query<{ id: string; deactivated_at: Date | null; deactivated_by_tenant: boolean; stamp: Date | null }>(
        `SELECT tm.id, tm.deactivated_at, tm.deactivated_by_tenant, tmb.deactivated_at AS stamp
           FROM team_members tm LEFT JOIN tenant_members tmb ON tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
          WHERE tm.id = ANY($1::uuid[])`,
        [names.map((n) => fx.rows[n].rowId)],
      );
      const byRow = new Map(m.rows.map((r) => [r.id, r]));
      const memberships = Object.fromEntries(names.map((n) => {
        const r = byRow.get(fx.rows[n].rowId)!;
        if (r.deactivated_at === null && !r.deactivated_by_tenant) return [n, "active"];
        if (r.deactivated_by_tenant && r.stamp && r.deactivated_at?.getTime() === r.stamp.getTime()) return [n, "ended"];
        return [n, "odd"];
      }));
      const iNames = Object.keys(fx.invitations);
      const inv = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM team_invitations WHERE id = ANY($1::uuid[])`, [iNames.map((n) => fx.invitations[n])],
      );
      const status = new Map(inv.rows.map((r) => [r.id, r.status]));
      const rec = await client.query<{ user_id: string; departed_at: Date }>(
        `SELECT user_id, departed_at FROM tenant_member_departures WHERE tenant_id = $1::uuid`, [tenantId],
      );
      const departedAt = new Map(rec.rows.map((r) => [r.user_id, r.departed_at.toISOString()]));
      return {
        memberships,
        invitations: Object.fromEntries(iNames.map((n) => [n, status.get(fx.invitations[n])!])),
        records: Object.fromEntries(Object.entries(fx.deletedUsers).map(([n, id]) => [n, departedAt.get(id) ?? null])),
      };
    }

    const ACTIVE_NAMES = [
      "leak", "late", "leakElsewhere", "readmitOutbox", "recLogs", "recSent", "spareRecorded", "recOtherTeamLogs",
      "recOtherTeamOutbox", "recTimeLogs", "recTimeOutbox", "accepted",
      "negActionLogs", "negTargetLogs", "negTenantLogs", "negActionOutbox", "negTargetOutbox", "negTenantOutbox",
    ];
    const ENDED_NAMES = [
      "leak", "accepted", "negActionLogs", "negTargetLogs", "negTenantLogs", "negActionOutbox", "negTargetOutbox", "negTenantOutbox",
    ];
    const membershipStates = (ended: readonly string[]) =>
      Object.fromEntries(ACTIVE_NAMES.map((n) => [n, ended.includes(n) ? "ended" : "active"]));

    /** Before any block: nothing is ended, and the invitations and records are as seeded. */
    function preState(fx: Fx): State {
      return {
        memberships: membershipStates([]),
        invitations: {
          acceptedInvitation: "ACCEPTED",
          byBefore: "PENDING", byAt: "PENDING", byAfter: "PENDING",
          toBefore: "PENDING", toAt: "PENDING", toAfter: "PENDING", toBeforeUpper: "PENDING",
          toDeletedBefore: "PENDING", toDeletedAfter: "PENDING", toNoAudit: "PENDING", toKept: "PENDING",
        },
        records: { deleted: null, noAudit: null, kept: fx.at(-2 * SECOND) },
      };
    }

    /** After the C1 departure block (or any role that applies it). */
    function postState(fx: Fx): State {
      return {
        memberships: membershipStates(ENDED_NAMES),
        invitations: {
          acceptedInvitation: "ACCEPTED",
          byBefore: "EXPIRED", byAt: "EXPIRED", byAfter: "PENDING",
          toBefore: "EXPIRED", toAt: "EXPIRED", toAfter: "PENDING", toBeforeUpper: "EXPIRED",
          toDeletedBefore: "EXPIRED", toDeletedAfter: "PENDING", toNoAudit: "PENDING", toKept: "PENDING",
        },
        // "kept" keeps the app's record (DO NOTHING); "deleted" is seeded from its audit row.
        records: { deleted: fx.at(0), noAudit: null, kept: fx.at(-2 * SECOND) },
      };
    }

    /** The orderings the fixtures rely on, read back from the database: -1 before the stamp, 0 at it, 1 after. */
    async function assertOrdering(fx: Fx) {
      const sign = (n: number) => Math.sign(n);
      const stamp = fx.stamp.getTime();
      const m = await sql<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM team_members WHERE id = ANY($1::uuid[])`, [Object.values(fx.rows).map((r) => r.rowId)],
      );
      const created = new Map(m.map((r) => [r.id, r.created_at.getTime()]));
      expect(Object.fromEntries(["leak", "late", "leakElsewhere", "recLogs", "spareRecorded", "accepted", "negTenantLogs"].map(
        (n) => [n, sign(created.get(fx.rows[n].rowId)! - stamp)],
      ))).toEqual({ leak: -1, late: 1, leakElsewhere: -1, recLogs: -1, spareRecorded: 1, accepted: -1, negTenantLogs: -1 });
      const inv = await sql<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM team_invitations WHERE id = ANY($1::uuid[])`, [Object.values(fx.invitations)],
      );
      const invAt = new Map(inv.map((r) => [r.id, r.created_at.getTime()]));
      expect(Object.fromEntries(["byBefore", "byAt", "byAfter", "toBefore", "toAt", "toAfter"].map(
        (n) => [n, sign(invAt.get(fx.invitations[n])! - stamp)],
      ))).toEqual({ byBefore: -1, byAt: 0, byAfter: 1, toBefore: -1, toAt: 0, toAfter: 1 });
      // The real-flow re-admission: a candidate but for its record.
      const [readmit] = await sql<{ created_before_departure: boolean; has_record: boolean }>(
        `SELECT tm.created_at < tmb.deactivated_at AS created_before_departure,
                EXISTS (SELECT 1 FROM audit_outbox o WHERE o.tenant_id = tm.tenant_id AND o.payload->>'action' = $2
                          AND o.payload->>'targetId' = tm.user_id::text AND o.status = 'PENDING') AS has_record
           FROM team_members tm JOIN tenant_members tmb ON tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
          WHERE tm.id = $1::uuid AND tm.deactivated_at IS NULL AND tmb.deactivated_at IS NOT NULL`,
        fx.rows.readmitOutbox.rowId, DEACTIVATE,
      );
      expect(readmit).toEqual({ created_before_departure: true, has_record: true });
    }

    async function asApp<T>(fn: (client: pg.PoolClient, notices: string[]) => Promise<T>): Promise<T> {
      const client = await appPool.connect();
      const collected = collectNotices(client);
      try {
        const [principal] = (await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        )).rows;
        expect(principal).toEqual({ rolsuper: false, rolbypassrls: false });
        await client.query("BEGIN");
        return await fn(client, collected.messages);
      } finally {
        collected.stop();
        await client.query("ROLLBACK");
        client.release();
      }
    }

    /** Runs the block with the settings sentinels in place and asserts it left them as found (I3). */
    async function runBlock(client: pg.PoolClient, block: string): Promise<void> {
      const sentinels = gucSentinels();
      await setGucs(client, sentinels);
      await client.query(block);
      expect(await readGucs(client)).toEqual(sentinels);
    }

    /** updated_at of every fixture membership and invitation; the client must see all rows. */
    async function readUpdatedAt(client: pg.PoolClient, fx: Fx) {
      const read = async (table: "team_members" | "team_invitations", ids: Record<string, string>) => {
        const { rows } = await client.query<{ id: string; updated_at: Date }>(
          `SELECT id, updated_at FROM ${table} WHERE id = ANY($1::uuid[])`, [Object.values(ids)],
        );
        const byId = new Map(rows.map((r) => [r.id, r.updated_at.getTime()]));
        return Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, byId.get(id)!]));
      };
      return {
        memberships: await read("team_members", Object.fromEntries(Object.entries(fx.rows).map(([n, r]) => [n, r.rowId]))),
        invitations: await read("team_invitations", fx.invitations),
      };
    }

    const movedBetween = (before: Record<string, number>, after: Record<string, number>) =>
      Object.fromEntries(Object.keys(before).map((n) => [n, after[n] > before[n] ? "moved" : after[n] === before[n] ? "unchanged" : "earlier"]));

    async function stateUnderTestBypass(client: pg.PoolClient, fx: Fx): Promise<State> {
      await setTestBypass(client, BLOCK_TABLES);
      return readState(client, fx);
    }

    const reportOf = (messages: string[], prefix: string) => {
      const line = messages.filter((m) => m.startsWith(prefix));
      expect(line).toHaveLength(1);
      return parseNoticeCounts(line[0]);
    };

    const rerunDeparture = () => readBackfillBlock(RLS_BACKFILL_RERUN_DIR, "team-tenant-departure-rerun");
    const RERUN_REPORT = "team-tenant-departure-rerun backfill:";

    /** Outbox rows C1 enqueued in this tenant, by target user. */
    async function enqueued(client: pg.PoolClient): Promise<{ targetId: string; teamId: string; payload: unknown }[]> {
      const { rows } = await client.query<{ payload: { targetId: string; teamId: string } }>(
        `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->'metadata'->>'backfill' = $2`,
        [tenantId, RLS_BACKFILL_RERUN_DIR],
      );
      return rows.map((r) => ({ targetId: r.payload.targetId, teamId: r.payload.teamId, payload: r.payload }));
    }

    let fx: Fx;
    beforeEach(async () => {
      fx = await seedFixtures();
      await assertOrdering(fx);
    });

    it("control: the ORIGINAL block as passwd_app changes nothing and reports zero everywhere; under a test bypass it ends the fixtures", async () => {
      await asApp(async (client, notices) => {
        const original = readBackfillBlock(ORIGINAL_DIR, "team-tenant-departure");
        expect(await stateUnderTestBypass(client, fx)).toEqual(preState(fx));

        await runBlock(client, original);
        const counts = reportOf(notices, "team-tenant-departure backfill:");
        expect(Object.values(counts).every((n) => n === 0)).toBe(true);
        expect(Object.keys(counts)).toHaveLength(6);
        expect(await stateUnderTestBypass(client, fx)).toEqual(preState(fx));

        // Positive control: the same block with the bypass it lacked changes them.
        await setTestBypass(client, ORIGINAL_TABLES);
        notices.length = 0;
        await client.query(original);
        expect(reportOf(notices, "team-tenant-departure backfill:").memberships).toBeGreaterThanOrEqual(ENDED_NAMES.length);
        const after = await stateUnderTestBypass(client, fx);
        expect(after.memberships.leak).toBe("ended");
        expect(after.invitations.byBefore).toBe("EXPIRED");
      });
    });

    it("C1 as passwd_app ends exactly the memberships no record explains, expires the voided invitations, keeps the app's records (literal map)", async () => {
      await asApp(async (client) => {
        await setTestBypass(client, BLOCK_TABLES);
        const updatedBefore = await readUpdatedAt(client, fx);
        await runBlock(client, rerunDeparture());
        expect(await stateUnderTestBypass(client, fx)).toEqual(postState(fx));
        // updated_at follows endTeamMemberships and the invitation expiry: moved on what the block changed, nothing else.
        const updatedAfter = await readUpdatedAt(client, fx);
        expect(movedBetween(updatedBefore.memberships, updatedAfter.memberships)).toEqual(
          Object.fromEntries(Object.keys(fx.rows).map((n) => [n, ENDED_NAMES.includes(n) ? "moved" : "unchanged"])),
        );
        expect(movedBetween(updatedBefore.invitations, updatedAfter.invitations)).toEqual({
          acceptedInvitation: "unchanged",
          byBefore: "moved", byAt: "moved", byAfter: "unchanged",
          toBefore: "moved", toAt: "moved", toAfter: "unchanged", toBeforeUpper: "moved",
          toDeletedBefore: "moved", toDeletedAfter: "unchanged", toNoAudit: "unchanged", toKept: "unchanged",
        });
        const rows = await enqueued(client);
        expect(Object.fromEntries(rows.map((r) => [r.targetId, r.teamId]))).toEqual(
          Object.fromEntries(ENDED_NAMES.map((n) => [fx.rows[n].userId, fx.teamX])),
        );
        expect(rows).toHaveLength(ENDED_NAMES.length);
      });
      // Nothing a block changes is committed.
      const committed = await sql(`SELECT 1 FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->'metadata'->>'backfill' = $2`, tenantId, RLS_BACKFILL_RERUN_DIR);
      expect(committed).toEqual([]);
    });

    it("I1: a second run in the same transaction changes no row and enqueues nothing", async () => {
      await asApp(async (client, notices) => {
        await runBlock(client, rerunDeparture());
        const first = reportOf(notices, RERUN_REPORT);
        const afterFirst = await stateUnderTestBypass(client, fx);
        const outboxBefore = (await client.query(`SELECT count(*)::int AS n FROM audit_outbox WHERE payload->'metadata'->>'backfill' = $1`, [RLS_BACKFILL_RERUN_DIR])).rows[0].n;
        expect(first.memberships).toBeGreaterThanOrEqual(ENDED_NAMES.length);

        notices.length = 0;
        await runBlock(client, rerunDeparture());
        const second = reportOf(notices, RERUN_REPORT);
        const { ownerless_teams: secondCensus, ...changes } = second;
        expect(secondCensus).toBe(first.ownerless_teams);
        expect(Object.values(changes).every((n) => n === 0)).toBe(true);
        expect(Object.keys(changes)).toHaveLength(6);
        expect(await stateUnderTestBypass(client, fx)).toEqual(afterFirst);
        const outboxAfter = (await client.query(`SELECT count(*)::int AS n FROM audit_outbox WHERE payload->'metadata'->>'backfill' = $1`, [RLS_BACKFILL_RERUN_DIR])).rows[0].n;
        expect(outboxAfter).toBe(outboxBefore);
      });
    });

    it("the ownerless census follows the database: removing a fixture team's OWNER adds one", async () => {
      await asApp(async (client, notices) => {
        await runBlock(client, rerunDeparture());
        const before = reportOf(notices, RERUN_REPORT).ownerless_teams;
        await setTestBypass(client, BLOCK_TABLES);
        const owner = await client.query(
          `UPDATE team_members SET deactivated_at = now() WHERE team_id = $1::uuid AND role = 'OWNER' AND deactivated_at IS NULL`, [fx.teamX],
        );
        expect(owner.rowCount).toBe(1);
        notices.length = 0;
        await runBlock(client, rerunDeparture());
        expect(reportOf(notices, RERUN_REPORT).ownerless_teams).toBe(before + 1);
      });
    });

    it("each enqueued outbox row is the payload buildOutboxPayload gives endTeamMemberships' call, and the worker delivers it as an audit row", async () => {
      const leakUserId = fx.rows.leak.userId;
      const stampIso = fx.stamp.toISOString();
      const expected = buildOutboxPayload({
        scope: AUDIT_SCOPE.TEAM,
        action: AUDIT_ACTION.TEAM_MEMBER_TENANT_DEACTIVATE,
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        serviceAccountId: null,
        teamId: fx.teamX,
        targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
        targetId: leakUserId,
        metadata: { source: TENANT_MEMBERSHIP_SOURCE.TENANT_DEACTIVATION, backfill: RLS_BACKFILL_RERUN_DIR, departedAt: stampIso },
        ip: null,
        userAgent: null,
      });
      let payload: unknown;
      await asApp(async (client) => {
        await runBlock(client, rerunDeparture());
        await setTestBypass(client, BLOCK_TABLES);
        const rows = (await enqueued(client)).filter((r) => r.targetId === leakUserId);
        expect(rows).toHaveLength(1);
        payload = rows[0].payload;
        expect(payload).toEqual(expected);
      });

      // A committed copy, delivered by the worker's own function.
      const outboxId = randomUUID();
      await sql(`INSERT INTO audit_outbox (id, tenant_id, payload) VALUES ($1::uuid, $2::uuid, $3::jsonb)`, outboxId, tenantId, JSON.stringify(payload));
      const [row] = await sql<AuditOutboxRow>(
        `SELECT id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at, sent_at, last_error
           FROM audit_outbox WHERE id = $1::uuid`, outboxId,
      );
      expect((await deliverRow(ctx.su.prisma, row, row.payload as AuditOutboxPayload)).inserted).toBe(true);
      expect(await sql(
        `SELECT action::text, actor_type::text, user_id::text, team_id::text, target_type, target_id FROM audit_logs WHERE outbox_id = $1::uuid`, outboxId,
      )).toEqual([{
        action: DEACTIVATE, actor_type: "SYSTEM", user_id: SYSTEM_ACTOR_ID, team_id: fx.teamX, target_type: "TeamMember", target_id: leakUserId,
      }]);
    });

    it.each(BLOCK_TABLES)("table-list control: with %s removed from app.bypass_tables the block reports it under system_maintenance", async (removed) => {
      const block = rerunDeparture();
      const literal = /'(tenant_members,[a-z_,]+)'/.exec(block);
      expect(literal).not.toBeNull();
      const mutated = block.replace(literal![1], literal![1].split(",").filter((t) => t !== removed).join(","));
      expect(mutated).not.toBe(block);
      const notices = await expectBypassNotices(() => asApp(async (client) => {
        await runBlock(client, mutated);
      }));
      expect(notices).toContainEqual({ table: removed, purpose: "system_maintenance" });
    });

    describe("I2: a migrate role that bypasses RLS", () => {
      const SKIP = /^team-tenant-departure-rerun skipped: .*; (\d+) departed member\(s\) still hold active memberships/;
      const bypassKinds = [BYPASS_ROLE_KIND.MIGRATION_SUPERUSER, BYPASS_ROLE_KIND.BYPASSRLS_ROLE, BYPASS_ROLE_KIND.SUPERUSER_ROLE];

      async function inRolledBackTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
        const client = await ctx.su.pool.connect();
        try {
          await client.query("BEGIN");
          return await fn(client);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }

      it.each(bypassKinds)("%s: the block skips with a warning counting the candidates, changes no fixture, and the count follows the candidate set", async (kind) => {
        await inRolledBackTx(async (client) => {
          const role = await enterBypassRole(client, kind);
          const collected = collectNotices(client);
          try {
            const skipCount = () => {
              const found = collected.messages.map((m) => SKIP.exec(m)).filter((m) => m !== null);
              expect(found).toHaveLength(1);
              const n = Number(found[0]![1]);
              collected.messages.length = 0;
              return n;
            };
            await client.query(rerunDeparture());
            const first = skipCount();
            await client.query("RESET ROLE");
            expect(await readState(client, fx)).toEqual(preState(fx));
            expect((await enqueued(client)).length).toBe(0);

            // One more leaked candidate ("late" made older than the stamp), and one more
            // membership whose user has an outbox record (an excluded one): count + 1.
            await client.query(`UPDATE team_members SET created_at = $2::timestamptz WHERE id = ANY($1::uuid[])`,
              [[fx.rows.late.rowId, fx.rows.spareRecorded.rowId], fx.at(-SECOND)]);
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query(rerunDeparture());
            expect(skipCount()).toBe(first + 1);
            await client.query("RESET ROLE");
            expect((await readState(client, fx)).memberships).toEqual(membershipStates([]));
          } finally {
            collected.stop();
          }
        });
      });

      it("passwd_app entered with SET LOCAL ROLE (session_user bypasses, current_user does not): the block applies", async () => {
        await inRolledBackTx(async (client) => {
          await enterBypassRole(client, BYPASS_ROLE_KIND.APP_ROLE);
          const collected = collectNotices(client);
          try {
            await client.query(rerunDeparture());
            expect(collected.messages.some((m) => m.startsWith("team-tenant-departure-rerun skipped"))).toBe(false);
          } finally {
            collected.stop();
          }
          await client.query("RESET ROLE");
          expect(await readState(client, fx)).toEqual(postState(fx));
        });
      });
    });

    describe("locks: each one held alone makes the block fail on that statement with 55P03", () => {
      async function blockedBy(holder: string, params: unknown[], statementText: string): Promise<void> {
        const a = await ctx.su.pool.connect();
        const b = await appPool.connect();
        try {
          await a.query("BEGIN");
          await a.query(holder, params);
          await b.query("BEGIN");
          await b.query("SET LOCAL lock_timeout = '1500ms'");
          await setGucs(b, gucSentinels());
          const error = await b.query(rerunDeparture()).then(() => null, (e: unknown) => e as { code?: string; where?: string });
          expect(error?.code).toBe("55P03");
          expect(error?.where).toContain(statementText);
        } finally {
          await b.query("ROLLBACK").catch(() => {});
          await a.query("ROLLBACK").catch(() => {});
          b.release();
          a.release();
        }
      }

      it("the advisory lock of a candidate (tenant, user), key built by the app's helper", async () => {
        await blockedBy(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [advisoryKey(tenantId, fx.rows.leak.userId)], "pg_advisory_xact_lock");
      });

      it("the advisory lock of a 2c subject (SCIM-deleted, no tenant row), key built by the app's helper", async () => {
        await blockedBy(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [advisoryKey(tenantId, fx.deletedUsers.deleted)], "pg_advisory_xact_lock");
      });

      it("a candidate's tenant_members row", async () => {
        await blockedBy(
          `SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
          [tenantId, fx.rows.leak.userId], "FOR SHARE OF tmb",
        );
      });

      it("a team row (teams FOR SHARE over all teams)", async () => {
        await blockedBy(`SELECT 1 FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [fx.teamX], "FROM teams ORDER BY id FOR SHARE");
      });
    });
  });
});
