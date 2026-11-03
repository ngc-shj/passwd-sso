/**
 * Integration test (real DB): a membership SCIM admits (created, or a
 * deactivated row brought back) stays PENDING — no team access, no key —
 * until an active key-holding team OWNER/ADMIN approves it or the team
 * rejects it (docs/archive/review/scim-team-admission-approval-plan.md).
 *
 * Covers A1-A10, A12, A13 and A11's GET half. Production routes and services
 * run under their real RLS contexts on the app role; only auth, step-up,
 * rate-limit and the SCIM-token boundary are mocked. Races are parked on a
 * row lock held by a test "blocker" transaction and witnessed through
 * pg_blocking_pids (race-helpers.ts).
 *
 * Run: docker compose up -d db && npm run test:integration -- scim-team-admission-approval
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  assertRlsApplies,
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import type { Prisma } from "@prisma/client";

const { scimTenant } = vi.hoisted(() => ({ scimTenant: { id: "" } }));
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
const mockAuth = vi.fn();
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

import { PUT as scimGroupPutRoute, PATCH as scimGroupPatchRoute, GET as scimGroupGetRoute } from "@/app/api/scim/v2/Groups/[id]/route";
import { GET as scimGroupsListRoute, POST as scimGroupsPostRoute } from "@/app/api/scim/v2/Groups/route";
import { PATCH as scimUserPatchRoute, DELETE as scimUserDeleteRoute } from "@/app/api/scim/v2/Users/[id]/route";
import { POST as approveRoute } from "@/app/api/teams/[teamId]/members/[memberId]/approve/route";
import { POST as rejectRoute } from "@/app/api/teams/[teamId]/members/[memberId]/reject/route";
import { POST as confirmKeyRoute } from "@/app/api/teams/[teamId]/members/[memberId]/confirm-key/route";
import { GET as listMembersRoute } from "@/app/api/teams/[teamId]/members/route";
import { PUT as changeRoleRoute } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { GET as getTeamRoute } from "@/app/api/teams/[teamId]/route";
import { GET as listTeamPasswordsRoute } from "@/app/api/teams/[teamId]/passwords/route";
import { GET as pendingKeyDistributionsRoute } from "@/app/api/teams/pending-key-distributions/route";
import { prisma } from "@/lib/prisma";

const hex = (n: number) => randomBytes(n).toString("hex");

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function keyMaterial(keyVersion: number) {
  return {
    encryptedTeamKey: hex(32),
    teamKeyIv: hex(12),
    teamKeyAuthTag: hex(16),
    ephemeralPublicKey: hex(32),
    hkdfSalt: hex(32),
    keyVersion,
    wrapVersion: 1,
  };
}

describe("scim-team-admission-approval — real-DB integration", () => {
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
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    scimTenant.id = tenantId;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
    vi.unstubAllEnvs();
  });

  // ── Raw-SQL helpers ──────────────────────────────────────────

  async function asSuperuser<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return fn(tx);
    });
  }

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return asSuperuser((tx) => tx.$queryRawUnsafe<T[]>(text, ...params));
  }

  async function member(tenant = tenantId): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  async function setTenantRole(userId: string, role: string) {
    await sql(`UPDATE tenant_members SET role = $2 WHERE user_id = $1::uuid`, userId, role);
  }

  async function setEcdhKey(userId: string) {
    await sql(`UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, userId, hex(32));
  }

  async function team(owner: string, tenant = tenantId): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, tenant, `team-${id.slice(0, 8)}`,
    );
    await addMemberRow(id, owner, { role: "OWNER", tenant, keyDistributed: true });
    await seedKey(id, owner, tenant);
    return id;
  }

  async function seedKey(teamId: string, userId: string, tenant = tenantId, keyVersion = 1) {
    await sql(
      `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
      randomUUID(), teamId, tenant, userId, hex(32), hex(12), hex(16), hex(32), hex(32), keyVersion,
    );
  }

  /** General-purpose team_members row insert — every field explicit, no production default relied on. */
  async function addMemberRow(
    teamId: string,
    userId: string,
    opts: {
      role: string;
      tenant?: string;
      deactivated?: boolean;
      deactivatedByTenant?: boolean;
      scimManaged?: boolean;
      scimApprovalPending?: boolean;
      keyDistributed?: boolean;
    },
  ): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, deactivated_by_tenant,
         scim_managed, scim_approval_pending, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", ${opts.deactivated ? "now()" : "NULL"},
         $6, $7, $8, $9, now(), now())`,
      rowId, teamId, userId, opts.tenant ?? tenantId, opts.role,
      opts.deactivatedByTenant ?? false, opts.scimManaged ?? false, opts.scimApprovalPending ?? false,
      opts.keyDistributed ?? false,
    );
    return rowId;
  }

  async function activeMember(teamId: string, userId: string, role: string, opts: { keyDistributed?: boolean; tenant?: string } = {}) {
    return addMemberRow(teamId, userId, { role, deactivated: false, keyDistributed: opts.keyDistributed ?? false, tenant: opts.tenant });
  }

  async function pendingMember(teamId: string, userId: string, role: string, tenant = tenantId) {
    return addMemberRow(teamId, userId, { role, deactivated: true, scimManaged: true, scimApprovalPending: true, tenant });
  }

  async function departedMember(teamId: string, userId: string, role: string, tenant = tenantId) {
    return addMemberRow(teamId, userId, { role, deactivated: true, deactivatedByTenant: true, scimManaged: true, tenant });
  }

  async function mapGroup(teamId: string, role: string, tenant = tenantId): Promise<string> {
    const externalGroupId = `grp-${randomUUID().slice(0, 8)}`;
    await sql(
      `INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"TeamRole", now(), now())`,
      randomUUID(), tenant, teamId, externalGroupId, role,
    );
    return externalGroupId;
  }

  async function membership(teamId: string, userId: string) {
    const [row] = await sql<{
      id: string; deactivated_at: Date | null; deactivated_by_tenant: boolean;
      key_distributed: boolean; scim_managed: boolean; scim_approval_pending: boolean; role: string;
    }>(
      `SELECT id, deactivated_at, deactivated_by_tenant, key_distributed, scim_managed, scim_approval_pending, role
         FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
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

  async function tenantDeactivatedAt(tenant: string, userId: string): Promise<Date | null> {
    const [row] = await sql<{ deactivated_at: Date | null }>(
      `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenant, userId,
    );
    return row?.deactivated_at ?? null;
  }

  async function auditRows(action: string, opts: { teamId?: string } = {}): Promise<{ targetId: string; scope: string; actorType: string; userId: string; metadata: Record<string, unknown> }[]> {
    const rows = await sql<{ payload: {
      targetId: string; metadata: Record<string, unknown>; teamId?: string;
      scope: string; actorType: string; userId: string;
    } }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = ANY($1::uuid[]) AND payload->>'action' = $2 ORDER BY created_at ASC`,
      [tenantId, otherTenantId], action,
    );
    return rows
      .map((r) => r.payload)
      .filter((p) => opts.teamId === undefined || p.teamId === opts.teamId)
      .map((p) => ({ targetId: p.targetId, scope: p.scope, actorType: p.actorType, userId: p.userId, metadata: p.metadata }));
  }

  /**
   * (T2) Every SCIM-emitted audit row shares the same actor: the SCIM token
   * under test, mocked to act as SYSTEM, scoped to TEAM (never the SCIM
   * group's own TENANT scope — C4). Checked on every row, not just the first.
   */
  function expectScimTeamAuditRows(rows: { scope: string; actorType: string; userId: string; metadata: Record<string, unknown> }[]) {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.scope).toBe(AUDIT_SCOPE.TEAM);
      expect(row.actorType).toBe(ACTOR_TYPE.SYSTEM);
      expect(row.userId).toBe(SYSTEM_ACTOR_ID);
      expect(row.metadata).toMatchObject({ scimTokenId: "token-under-test" });
    }
  }

  // ── Entry points ─────────────────────────────────────────────

  function scimPatch(externalGroupId: string, ops: { add?: string[]; remove?: string[] }) {
    const Operations: unknown[] = [];
    if (ops.add?.length) Operations.push({ op: "add", path: "members", value: ops.add.map((v) => ({ value: v })) });
    for (const id of ops.remove ?? []) Operations.push({ op: "remove", path: `members[value eq "${id}"]` });
    return scimGroupPatchRoute(
      jsonRequest(`http://localhost/api/scim/v2/Groups/${externalGroupId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations,
      }),
      { params: Promise.resolve({ id: externalGroupId }) },
    );
  }

  function scimPut(externalGroupId: string, displayName: string, memberUserIds: string[]) {
    return scimGroupPutRoute(
      jsonRequest(`http://localhost/api/scim/v2/Groups/${externalGroupId}`, "PUT", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName,
        members: memberUserIds.map((v) => ({ value: v })),
      }),
      { params: Promise.resolve({ id: externalGroupId }) },
    );
  }

  function scimGroupGet(externalGroupId: string) {
    return scimGroupGetRoute(new NextRequest(`http://localhost/api/scim/v2/Groups/${externalGroupId}`), {
      params: Promise.resolve({ id: externalGroupId }),
    });
  }

  function scimGroupsList() {
    return scimGroupsListRoute(new NextRequest("http://localhost/api/scim/v2/Groups"));
  }

  function scimGroupsPost(displayName: string, externalId: string) {
    return scimGroupsPostRoute(
      jsonRequest("http://localhost/api/scim/v2/Groups", "POST", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName,
        externalId,
      }),
    );
  }

  function scimUserActive(userId: string, active: boolean) {
    return scimUserPatchRoute(
      jsonRequest(`http://localhost/api/scim/v2/Users/${userId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  function scimUserDelete(userId: string) {
    return scimUserDeleteRoute(new NextRequest(`http://localhost/api/scim/v2/Users/${userId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: userId }),
    });
  }

  function approve(teamId: string, memberId: string, actorUserId: string, expectedRole: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return approveRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/approve`, "POST", { expectedRole }),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function reject(teamId: string, memberId: string, actorUserId: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return rejectRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/reject`, "POST"),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function confirmKeyCall(teamId: string, memberId: string, actorUserId: string, keyVersion: number) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return confirmKeyRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/confirm-key`, "POST", keyMaterial(keyVersion)),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function membersGet(teamId: string, actorUserId: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return listMembersRoute(new NextRequest(`http://localhost/api/teams/${teamId}/members`), {
      params: Promise.resolve({ teamId }),
    });
  }

  function changeRole(teamId: string, memberId: string, actorUserId: string, role: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return changeRoleRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}`, "PUT", { role }),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function teamGet(teamId: string, actorUserId: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return getTeamRoute(new NextRequest(`http://localhost/api/teams/${teamId}`), { params: Promise.resolve({ teamId }) });
  }

  function teamPasswordsGet(teamId: string, actorUserId: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return listTeamPasswordsRoute(new NextRequest(`http://localhost/api/teams/${teamId}/passwords`), {
      params: Promise.resolve({ teamId }),
    });
  }

  function pendingKeyDistributionsGet(actorUserId: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return (pendingKeyDistributionsRoute as unknown as (req: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/teams/pending-key-distributions"),
    );
  }

  // ── A1 ───────────────────────────────────────────────────────

  it("A1: SCIM PATCH adds a tenant ADMIN to a team pending, with no access and no key, while an active undistributed member still appears", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const teamAdmin = await ctx.createUser(tenantId);
    await activeMember(teamId, teamAdmin, "ADMIN", { keyDistributed: true });
    await seedKey(teamId, teamAdmin);
    const undistributed = await member();
    await setEcdhKey(undistributed.id);
    const undistributedRow = await activeMember(teamId, undistributed.id, "MEMBER", { keyDistributed: false });

    const tenantAdmin = await member();
    await setTenantRole(tenantAdmin.id, "ADMIN");
    await setEcdhKey(tenantAdmin.id);
    const groupId = await mapGroup(teamId, "ADMIN");

    const res = await scimPatch(groupId, { add: [tenantAdmin.id] });

    expect(res.status).toBe(200);
    expect(await membership(teamId, tenantAdmin.id)).toMatchObject({
      role: "ADMIN", key_distributed: false, scim_managed: true, scim_approval_pending: true,
    });
    expect((await membership(teamId, tenantAdmin.id))?.deactivated_at).not.toBeNull();
    const [row] = await sql<{ ecdh: string | null }>(`SELECT ecdh_public_key AS ecdh FROM users WHERE id = $1::uuid`, tenantAdmin.id);
    expect(row.ecdh).not.toBeNull();

    expect((await teamGet(teamId, tenantAdmin.id)).status).toBe(404);
    expect((await teamPasswordsGet(teamId, tenantAdmin.id)).status).toBe(404);

    const pendingAdminRow = await membership(teamId, tenantAdmin.id);
    const pending = (await (await pendingKeyDistributionsGet(teamAdmin)).json()) as { memberId: string }[];
    const pendingIds = pending.map((p) => p.memberId);
    expect(pendingIds).not.toContain(pendingAdminRow!.id);
    expect(pendingIds).toContain(undistributedRow);
  });

  // ── A2 ───────────────────────────────────────────────────────

  it.each(["ADMIN", "OWNER"] as const)("A2: a key-holding team %s approves, after which key distribution and the A1 routes succeed", async (approverRole) => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const approver = approverRole === "OWNER" ? owner : await (async () => {
      const u = await ctx.createUser(tenantId);
      await activeMember(teamId, u, "ADMIN", { keyDistributed: true });
      await seedKey(teamId, u);
      return u;
    })();

    const target = await member();
    await setEcdhKey(target.id);
    const groupId = await mapGroup(teamId, "ADMIN");
    expect((await scimPatch(groupId, { add: [target.id] })).status).toBe(200);
    const row = await membership(teamId, target.id);

    const approved = await approve(teamId, row!.id, approver, "ADMIN");
    expect(approved.status).toBe(200);
    expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: false, key_distributed: false });

    const pending = (await (await pendingKeyDistributionsGet(approver)).json()) as { memberId: string }[];
    expect(pending.map((p) => p.memberId)).toContain(row!.id);

    const confirmed = await confirmKeyCall(teamId, row!.id, approver, 1);
    expect(confirmed.status).toBe(200);
    expect(await membership(teamId, target.id)).toMatchObject({ key_distributed: true });
    expect(await auditRows("TEAM_MEMBER_KEY_DISTRIBUTE", { teamId })).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: target.id })]),
    );

    expect((await teamGet(teamId, target.id)).status).toBe(200);
    expect((await teamPasswordsGet(teamId, target.id)).status).toBe(200);
  });

  // ── A3 ───────────────────────────────────────────────────────

  describe("A3: approver checks", () => {
    it("the pending member calling approve or reject on their own row gets 404, changing nothing", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      expect((await approve(teamId, rowId, target.id, "MEMBER")).status).toBe(404);
      expect((await reject(teamId, rowId, target.id)).status).toBe(404);
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId })).toEqual([]);
    });

    it("a tenant ADMIN outside the team gets 404 on approve and reject, changing nothing", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");
      const outsider = await member();
      await setTenantRole(outsider.id, "ADMIN");

      expect((await approve(teamId, rowId, outsider.id, "MEMBER")).status).toBe(404);
      expect((await reject(teamId, rowId, outsider.id)).status).toBe(404);
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId })).toEqual([]);
    });

    it("an active team ADMIN without the key gets 403; the same caller's reject gets 200", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const keylessAdmin = await ctx.createUser(tenantId);
      await activeMember(teamId, keylessAdmin, "ADMIN", { keyDistributed: false });
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      expect((await approve(teamId, rowId, keylessAdmin, "MEMBER")).status).toBe(403);
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);

      expect((await reject(teamId, rowId, keylessAdmin)).status).toBe(200);
      expect(await membership(teamId, target.id)).toBeNull();
    });
  });

  // ── A4 ───────────────────────────────────────────────────────

  it("A4: PUT omitting a pending user withdraws it; a repeated PUT listing it is a no-op; PATCH remove withdraws too; PUT listing a departed member is a no-op", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");
    const [{ team: teamSlug }] = await sql<{ team: string }>(`SELECT slug AS team FROM teams WHERE id = $1::uuid`, teamId);

    const target = await member();
    expect((await scimPatch(groupId, { add: [target.id] })).status).toBe(200);
    expect(await auditRows("TEAM_MEMBER_SCIM_PENDING", { teamId })).toHaveLength(1);

    // A repeated PUT listing the same pending user: no-op.
    const noop = await scimPut(groupId, `${teamSlug}:MEMBER`, [target.id]);
    expect(noop.status).toBe(200);
    expect((await noop.json()).members).toBeDefined();
    expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
    expect(await auditRows("TEAM_MEMBER_SCIM_PENDING", { teamId })).toHaveLength(1);
    // (T3) The no-op's own SCIM_GROUP_UPDATE row (the most recent one so
    // far) carries added: 0 — no transition, so nothing to count.
    const noopUpdate = await auditRows("SCIM_GROUP_UPDATE", { teamId });
    expect(noopUpdate.at(-1)?.metadata).toMatchObject({ added: 0 });

    // A PUT omitting the user withdraws the pending row.
    const withdrawn = await scimPut(groupId, `${teamSlug}:MEMBER`, []);
    expect(withdrawn.status).toBe(200);
    expect(await membership(teamId, target.id)).toBeNull();
    expect(await auditRows("TEAM_MEMBER_SCIM_PENDING_WITHDRAW", { teamId })).toEqual([
      expect.objectContaining({ targetId: target.id }),
    ]);

    // PATCH remove withdraws too.
    const target2 = await member();
    expect((await scimPatch(groupId, { add: [target2.id] })).status).toBe(200);
    expect((await scimPatch(groupId, { remove: [target2.id] })).status).toBe(200);
    expect(await membership(teamId, target2.id)).toBeNull();

    // A PUT listing a departed member is a no-op.
    const departed = await member();
    const departedRowId = await departedMember(teamId, departed.id, "MEMBER");
    const departedNoop = await scimPut(groupId, `${teamSlug}:MEMBER`, [departed.id]);
    expect(departedNoop.status).toBe(200);
    expect(await membership(teamId, departed.id)).toMatchObject({ id: departedRowId, deactivated_by_tenant: true });
  });

  // ── A5 ───────────────────────────────────────────────────────

  it("A5: pending -> removed -> re-added ends pending again; stale keys are cleared", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");

    const cycled = await member();
    expect((await scimPatch(groupId, { add: [cycled.id] })).status).toBe(200);
    expect((await scimPatch(groupId, { remove: [cycled.id] })).status).toBe(200);
    expect(await membership(teamId, cycled.id)).toBeNull();
    expect((await scimPatch(groupId, { add: [cycled.id] })).status).toBe(200);
    expect(await membership(teamId, cycled.id)).toMatchObject({ scim_approval_pending: true, deactivated_at: expect.any(Date) });

    const withKeys = await member();
    await activeMember(teamId, withKeys.id, "MEMBER", { keyDistributed: true });
    await seedKey(teamId, withKeys.id);
    expect(await keyCount(teamId, withKeys.id)).toBeGreaterThan(0);

    expect((await scimPatch(groupId, { remove: [withKeys.id] })).status).toBe(200);
    expect((await scimPatch(groupId, { add: [withKeys.id] })).status).toBe(200);
    expect(await membership(teamId, withKeys.id)).toMatchObject({ scim_approval_pending: true, key_distributed: false });
    expect(await keyCount(teamId, withKeys.id)).toBe(0);
  });

  // ── A5b ──────────────────────────────────────────────────────

  it("A5b: reject, then a PATCH remove of that absent user plus an active member affects only the active one", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");

    const rejected = await member();
    expect((await scimPatch(groupId, { add: [rejected.id] })).status).toBe(200);
    const rejectedRow = await membership(teamId, rejected.id);
    expect((await reject(teamId, rejectedRow!.id, owner)).status).toBe(200);
    expect(await membership(teamId, rejected.id)).toBeNull();

    const active = await member();
    await activeMember(teamId, active.id, "MEMBER");

    const res = await scimPatch(groupId, { remove: [rejected.id, active.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(JSON.stringify(body)).not.toContain(rejected.id);
    expect(await membership(teamId, active.id)).toMatchObject({ deactivated_at: expect.any(Date) });
    expect(await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId })).toEqual([
      expect.objectContaining({ targetId: active.id }),
    ]);
    // (T3) The absent user is a no-op, not a transition: SCIM_GROUP_UPDATE
    // counts only the active member actually removed.
    const scimUpdate = await auditRows("SCIM_GROUP_UPDATE", { teamId });
    expect(scimUpdate.at(-1)?.metadata).toMatchObject({ removed: 1 });
  });

  it("A5b: SCIM DELETE /Users of a pending user removes tenant and team rows; a later PATCH remove is a no-op for them", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");

    const deleted = await member();
    expect((await scimPatch(groupId, { add: [deleted.id] })).status).toBe(200);
    expect(await membership(teamId, deleted.id)).toMatchObject({ scim_approval_pending: true });

    expect((await scimUserDelete(deleted.id)).status).toBe(204);
    expect(await sql(`SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, deleted.id)).toEqual([]);
    expect(await membership(teamId, deleted.id)).toBeNull();

    const active = await member();
    await activeMember(teamId, active.id, "MEMBER");
    const res = await scimPatch(groupId, { remove: [deleted.id, active.id] });
    expect(res.status).toBe(200);
    expect(await membership(teamId, active.id)).toMatchObject({ deactivated_at: expect.any(Date) });
    const removeAudits = await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId });
    expect(removeAudits.map((a) => a.targetId)).toEqual([active.id]);
    // (T3) Same as above: the already-deleted user is a no-op, not a removal.
    const scimUpdate = await auditRows("SCIM_GROUP_UPDATE", { teamId });
    expect(scimUpdate.at(-1)?.metadata).toMatchObject({ removed: 1 });
  });

  // ── A5c: departure vs SCIM remove (race) ──────────────────────

  it("A5c: a departure parked at its team lock races a SCIM PATCH remove; the removal unmarks the row; a later return does not restore it", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");
    const u = await member();
    await activeMember(teamId, u.id, "MEMBER", { keyDistributed: true });
    await seedKey(teamId, u.id);

    const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
    let departing: Promise<Response> | undefined;
    let removing: Promise<Response> | undefined;
    try {
      departing = scimUserActive(u.id, false);
      const departPid = await race.waitForBackendBlockedBy(blocker.pid);
      removing = scimPatch(groupId, { remove: [u.id] });
      expect(await race.settledOrBlocked(removing, departPid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      expect((await departing).status).toBe(200);
      expect((await removing).status).toBe(200);
    } finally {
      await blocker.release();
      await Promise.allSettled([departing, removing]);
    }

    expect(await membership(teamId, u.id)).toMatchObject({ deactivated_by_tenant: false, scim_approval_pending: false });
    expect((await membership(teamId, u.id))?.deactivated_at).not.toBeNull();
    expect(await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId })).toEqual([
      expect.objectContaining({ targetId: u.id, metadata: expect.objectContaining({ departed: true }) }),
    ]);

    expect((await scimUserActive(u.id, true)).status).toBe(200);
    expect(await tenantDeactivatedAt(tenantId, u.id)).toBeNull();
    // T's row was NOT restored: the removal already unmarked it.
    expect(await membership(teamId, u.id)).toMatchObject({ deactivated_by_tenant: false });
    expect((await membership(teamId, u.id))?.deactivated_at).not.toBeNull();
  });

  // ── A6: approval vs a tenant departure racing a 2nd team's lock ──

  describe("A6", () => {
    it("approval refuses a target who already left the tenant", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");
      // (T8) The precondition this test refuses on: the departure itself
      // committed, and the tenant row actually shows it.
      expect((await scimUserActive(target.id, false)).status).toBe(200);
      expect(await tenantDeactivatedAt(tenantId, target.id)).not.toBeNull();

      const res = await approve(teamId, rowId, owner, "MEMBER");
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SCIM_APPROVAL_TARGET_INACTIVE");
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      // (T4) The refusal writes no approval.
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
    });

    it("races a departure parked on a second team's lock while holding the target's advisory lock", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");
      const team2 = await team(owner);
      await activeMember(team2, target.id, "MEMBER");

      const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [team2]);
      let departing: Promise<Response> | undefined;
      let approving: Promise<Response> | undefined;
      try {
        departing = scimUserActive(target.id, false);
        const departPid = await race.waitForBackendBlockedBy(blocker.pid);
        approving = approve(teamId, rowId, owner, "MEMBER");
        expect(await race.settledOrBlocked(approving, departPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await departing).status).toBe(200);
        const approvingRes = await approving;
        expect(approvingRes.status).toBe(409);
        expect((await approvingRes.json()).error).toBe("SCIM_APPROVAL_TARGET_INACTIVE");
      } finally {
        await blocker.release();
        await Promise.allSettled([departing, approving]);
      }
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      // (T4) The raced-out approval writes no approval.
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
    });
  });

  // ── A7: concurrent approvals ───────────────────────────────────

  it("A7: two concurrent approvals of the same pending row — one 200, one 404, one approve audit row", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const approver2 = await ctx.createUser(tenantId);
    await activeMember(teamId, approver2, "ADMIN", { keyDistributed: true });
    await seedKey(teamId, approver2);
    const target = await member();
    const rowId = await pendingMember(teamId, target.id, "MEMBER");

    const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
    let approving1: Promise<Response> | undefined;
    let approving2: Promise<Response> | undefined;
    try {
      approving1 = approve(teamId, rowId, owner, "MEMBER");
      const approve1Pid = await race.waitForBackendBlockedBy(blocker.pid);
      approving2 = approve(teamId, rowId, approver2, "MEMBER");
      expect(await race.settledOrBlocked(approving2, approve1Pid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      const statuses = [(await approving1).status, (await approving2).status].sort();
      expect(statuses).toEqual([200, 404]);
    } finally {
      await blocker.release();
      await Promise.allSettled([approving1, approving2]);
    }
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([
      expect.objectContaining({ targetId: target.id }),
    ]);
  });

  // ── A7b: approve/reject vs SCIM withdraw ──────────────────────

  describe("A7b", () => {
    it.each(["PATCH", "PUT"] as const)("approve parked at the team lock, then a SCIM %s removes the now-active member (no WITHDRAW)", async (verb) => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const groupId = await mapGroup(teamId, "MEMBER");
      const [{ team: teamSlug }] = await sql<{ team: string }>(`SELECT slug AS team FROM teams WHERE id = $1::uuid`, teamId);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let approving: Promise<Response> | undefined;
      let scimming: Promise<Response> | undefined;
      try {
        approving = approve(teamId, rowId, owner, "MEMBER");
        const approvePid = await race.waitForBackendBlockedBy(blocker.pid);
        scimming = verb === "PATCH" ? scimPatch(groupId, { remove: [target.id] }) : scimPut(groupId, `${teamSlug}:MEMBER`, []);
        expect(await race.settledOrBlocked(scimming, approvePid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await approving).status).toBe(200);
        expect((await scimming).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([approving, scimming]);
      }
      expect(await membership(teamId, target.id)).toMatchObject({ deactivated_at: expect.any(Date) });
      expect(await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId })).toEqual([
        expect.objectContaining({ targetId: target.id }),
      ]);
      expect(await auditRows("TEAM_MEMBER_SCIM_PENDING_WITHDRAW", { teamId })).toEqual([]);
    });

    it.each(["PATCH", "PUT"] as const)("reject parked at the team lock, then a SCIM %s removes nothing (no WITHDRAW)", async (verb) => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const groupId = await mapGroup(teamId, "MEMBER");
      const [{ team: teamSlug }] = await sql<{ team: string }>(`SELECT slug AS team FROM teams WHERE id = $1::uuid`, teamId);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
      let rejecting: Promise<Response> | undefined;
      let scimming: Promise<Response> | undefined;
      try {
        rejecting = reject(teamId, rowId, owner);
        const rejectPid = await race.waitForBackendBlockedBy(blocker.pid);
        scimming = verb === "PATCH" ? scimPatch(groupId, { remove: [target.id] }) : scimPut(groupId, `${teamSlug}:MEMBER`, []);
        expect(await race.settledOrBlocked(scimming, rejectPid, blocker.pid)).toBe("blocked-on-parked");
        await blocker.release();
        expect((await rejecting).status).toBe(200);
        expect((await scimming).status).toBe(200);
      } finally {
        await blocker.release();
        await Promise.allSettled([rejecting, scimming]);
      }
      expect(await membership(teamId, target.id)).toBeNull();
      expect(await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_PENDING_WITHDRAW", { teamId })).toEqual([]);
    });
  });

  // ── A7c: PUT vs a concurrent add outside the locked set ───────

  it("A7c: a PUT parked on a requested user's advisory lock does not withdraw an add that commits meanwhile", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");
    const [{ team: teamSlug }] = await sql<{ team: string }>(`SELECT slug AS team FROM teams WHERE id = $1::uuid`, teamId);
    const r = await member();
    await activeMember(teamId, r.id, "MEMBER");
    const x = await member();

    const blocker = await race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`tenant-member:${tenantId}:${r.id}`]);
    let putting: Promise<Response> | undefined;
    let adding: Promise<Response> | undefined;
    try {
      putting = scimPut(groupId, `${teamSlug}:MEMBER`, [r.id]);
      await race.waitForBackendBlockedBy(blocker.pid);
      adding = scimPatch(groupId, { add: [x.id] });
      expect((await adding).status).toBe(200);
      await blocker.release();
      expect((await putting).status).toBe(200);
    } finally {
      await blocker.release();
      await Promise.allSettled([putting, adding]);
    }
    expect(await membership(teamId, x.id)).toMatchObject({ scim_approval_pending: true });
    expect(await auditRows("TEAM_MEMBER_SCIM_PENDING_WITHDRAW", { teamId })).toEqual([]);
  });

  // ── A7d: SCIM role CAS vs a concurrent ownership transfer ─────

  it("A7d: an ownership transfer committed after SCIM's pre-read leaves the role CAS a no-op", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "ADMIN");
    const x = await member();
    await activeMember(teamId, x.id, "MEMBER");
    const xRow = await membership(teamId, x.id);
    const y = await member(); // brand-new add target, used only to park SCIM mid-transaction

    const blocker = await race.holdRowLock(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [y.id]);
    let scimming: Promise<Response> | undefined;
    let transferring: Promise<Response> | undefined;
    try {
      scimming = scimPatch(groupId, { add: [y.id, x.id] });
      await race.waitForBackendBlockedBy(blocker.pid);
      transferring = changeRole(teamId, xRow!.id, owner, "OWNER");
      expect((await transferring).status).toBe(200);
      await blocker.release();
      expect((await scimming).status).toBe(200);
    } finally {
      await blocker.release();
      await Promise.allSettled([scimming, transferring]);
    }

    expect(await membership(teamId, x.id)).toMatchObject({ role: "OWNER" });
    expect(await auditRows("TEAM_MEMBER_SCIM_ROLE_UPDATE", { teamId })).toEqual([]);
    expect(await membership(teamId, y.id)).toMatchObject({ scim_approval_pending: true, role: "ADMIN" });
  });

  // ── A8 ───────────────────────────────────────────────────────

  describe("A8", () => {
    it("reject deletes the row and audits it; approve after reject answers 404", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      expect((await reject(teamId, rowId, owner)).status).toBe(200);
      expect(await membership(teamId, target.id)).toBeNull();
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId })).toEqual([
        expect.objectContaining({ targetId: target.id }),
      ]);

      expect((await approve(teamId, rowId, owner, "MEMBER")).status).toBe(404);
    });

    it("reject and approve of an active member, and of a departure-marked row, both answer 404 and leave the row intact", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const active = await member();
      const activeRow = await activeMember(teamId, active.id, "MEMBER");
      const departed = await member();
      const departedRow = await departedMember(teamId, departed.id, "MEMBER");

      for (const [rowId, userId] of [[activeRow, active.id], [departedRow, departed.id]] as const) {
        const before = await membership(teamId, userId);
        expect((await reject(teamId, rowId, owner)).status).toBe(404);
        expect((await approve(teamId, rowId, owner, "MEMBER")).status).toBe(404);
        expect(await membership(teamId, userId)).toEqual(before);
      }
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
    });

    it("a member of another team (same memberId, other teamId) answers 404", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const otherTeamId = await team(owner);
      const target = await member();
      const rowId = await pendingMember(teamId, target.id, "MEMBER");

      expect((await approve(otherTeamId, rowId, owner, "MEMBER")).status).toBe(404);
      expect((await reject(otherTeamId, rowId, owner)).status).toBe(404);
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      // (T4) Neither mismatched call writes anything — checked under both
      // teamIds, since a bug could write the audit row scoped to the team the
      // (wrong) route param named rather than to no team at all.
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId: otherTeamId })).toEqual([]);
      expect(await auditRows("TEAM_MEMBER_SCIM_REJECT", { teamId: otherTeamId })).toEqual([]);
    });
  });

  // ── A9 ───────────────────────────────────────────────────────

  describe("A9: CHECK constraints on scim_approval_pending", () => {
    async function insertRaw(fields: Partial<Record<
      "deactivated_at" | "deactivated_by_tenant" | "scim_managed" | "role", string
    >>) {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const u = await member();
      const base = {
        deactivated_at: "now()",
        deactivated_by_tenant: "false",
        scim_managed: "true",
        role: "'MEMBER'",
        ...fields,
      };
      return side.pool.query(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, deactivated_by_tenant,
           scim_managed, scim_approval_pending, key_distributed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, ${base.role}, ${base.deactivated_at}, ${base.deactivated_by_tenant},
           ${base.scim_managed}, true, false, now(), now())`,
        [randomUUID(), teamId, u.id, tenantId],
      );
    }

    it("a valid pending row inserts (positive control)", async () => {
      await expect(insertRaw({})).resolves.toBeDefined();
    });

    it("an active pending row (not deactivated) breaks team_members_scim_pending_deactivated", async () => {
      await expect(insertRaw({ deactivated_at: "NULL" })).rejects.toMatchObject({
        code: "23514", constraint: "team_members_scim_pending_deactivated",
      });
    });

    it("a departure-marked pending row breaks team_members_scim_pending_not_departure", async () => {
      await expect(insertRaw({ deactivated_by_tenant: "true" })).rejects.toMatchObject({
        code: "23514", constraint: "team_members_scim_pending_not_departure",
      });
    });

    it("a non-scim_managed pending row breaks team_members_scim_pending_scim_managed", async () => {
      await expect(insertRaw({ scim_managed: "false" })).rejects.toMatchObject({
        code: "23514", constraint: "team_members_scim_pending_scim_managed",
      });
    });

    it("a pending OWNER row breaks team_members_scim_pending_not_owner", async () => {
      await expect(insertRaw({ role: "'OWNER'" })).rejects.toMatchObject({
        code: "23514", constraint: "team_members_scim_pending_not_owner",
      });
    });

    it("a departure and return of a user pending in T and active in T2: T2's row is marked then restored; T stays pending and unmarked", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const team2 = await team(owner);
      const u = await member();
      await pendingMember(teamId, u.id, "MEMBER");
      await activeMember(team2, u.id, "MEMBER");

      expect((await scimUserActive(u.id, false)).status).toBe(200);
      expect(await membership(team2, u.id)).toMatchObject({ deactivated_by_tenant: true });
      expect(await membership(teamId, u.id)).toMatchObject({ scim_approval_pending: true, deactivated_by_tenant: false });

      expect((await scimUserActive(u.id, true)).status).toBe(200);
      expect(await membership(team2, u.id)).toMatchObject({ deactivated_at: null, deactivated_by_tenant: false });
      expect(await membership(teamId, u.id)).toMatchObject({ scim_approval_pending: true, deactivated_by_tenant: false });
      expect((await membership(teamId, u.id))?.deactivated_at).not.toBeNull();
    });
  });

  // ── A10: TEAM-scope audit coverage, each transition via PUT and PATCH ──

  it.each(["PUT", "PATCH"] as const)("A10: every SCIM transition kind through %s writes the matching TEAM-scope audit row", async (verb) => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");
    const [{ team: teamSlug }] = await sql<{ team: string }>(`SELECT slug AS team FROM teams WHERE id = $1::uuid`, teamId);

    const a = await member(); // becomes pending (create)
    const b = await member(); // pending role raised VIEWER -> MEMBER
    await pendingMember(teamId, b.id, "VIEWER");
    const c = await member(); // active role changed VIEWER -> MEMBER
    await activeMember(teamId, c.id, "VIEWER");
    const d = await member(); // pending withdrawn
    await pendingMember(teamId, d.id, "MEMBER");
    const e = await member(); // active removed
    await activeMember(teamId, e.id, "MEMBER");
    const f = await member(); // departed unmarked
    await departedMember(teamId, f.id, "MEMBER");

    const res = verb === "PUT"
      ? await scimPut(groupId, `${teamSlug}:MEMBER`, [a.id, b.id, c.id])
      : await scimPatch(groupId, { add: [a.id, b.id, c.id], remove: [d.id, e.id, f.id] });
    expect(res.status).toBe(200);

    expect(await membership(teamId, a.id)).toMatchObject({ scim_approval_pending: true, role: "MEMBER" });
    expect(await membership(teamId, b.id)).toMatchObject({ scim_approval_pending: true, role: "MEMBER" });
    expect(await membership(teamId, c.id)).toMatchObject({ role: "MEMBER", deactivated_at: null });
    expect(await membership(teamId, d.id)).toBeNull();
    expect(await membership(teamId, e.id)).toMatchObject({ deactivated_at: expect.any(Date) });
    expect(await membership(teamId, f.id)).toMatchObject({ deactivated_by_tenant: false });

    const pending = await auditRows("TEAM_MEMBER_SCIM_PENDING", { teamId });
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: a.id, metadata: expect.objectContaining({ role: "MEMBER", scimTokenId: "token-under-test" }) }),
      expect.objectContaining({ targetId: b.id, metadata: expect.objectContaining({ role: "MEMBER", previousRole: "VIEWER" }) }),
    ]));
    expect(pending).toHaveLength(2);
    expectScimTeamAuditRows(pending);

    const roleUpdated = await auditRows("TEAM_MEMBER_SCIM_ROLE_UPDATE", { teamId });
    expect(roleUpdated).toEqual([
      expect.objectContaining({ targetId: c.id, metadata: expect.objectContaining({ role: "MEMBER", previousRole: "VIEWER" }) }),
    ]);
    expectScimTeamAuditRows(roleUpdated);

    const withdrawn = await auditRows("TEAM_MEMBER_SCIM_PENDING_WITHDRAW", { teamId });
    expect(withdrawn).toEqual([
      expect.objectContaining({ targetId: d.id, metadata: expect.objectContaining({ role: "MEMBER" }) }),
    ]);
    expectScimTeamAuditRows(withdrawn);

    const removed = await auditRows("TEAM_MEMBER_SCIM_REMOVE", { teamId });
    expect(removed).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: e.id, metadata: expect.not.objectContaining({ departed: true }) }),
      expect.objectContaining({ targetId: f.id, metadata: expect.objectContaining({ departed: true }) }),
    ]));
    expect(removed).toHaveLength(2);
    expectScimTeamAuditRows(removed);
  });

  it("A10: SCIM POST /Groups mapping creation is audited at TEAM scope", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const [{ teamSlug }] = await sql<{ teamSlug: string }>(`SELECT slug AS "teamSlug" FROM teams WHERE id = $1::uuid`, teamId);
    const externalId = `grp-${randomUUID().slice(0, 8)}`;

    const res = await scimGroupsPost(`${teamSlug}:MEMBER`, externalId);
    expect(res.status).toBe(201);

    const mappingCreate = await auditRows("SCIM_GROUP_MAPPING_CREATE", { teamId });
    expect(mappingCreate).toEqual([
      expect.objectContaining({ targetId: teamId }),
    ]);
    expectScimTeamAuditRows(mappingCreate);
  });

  it("A10: confirm-key's refused branches (already distributed, member gone) emit no TEAM_MEMBER_KEY_DISTRIBUTE", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const target = await member();
    const rowId = await pendingMember(teamId, target.id, "MEMBER");
    await setEcdhKey(target.id);
    expect((await approve(teamId, rowId, owner, "MEMBER")).status).toBe(200);

    expect((await confirmKeyCall(teamId, rowId, owner, 1)).status).toBe(200);
    expect(await auditRows("TEAM_MEMBER_KEY_DISTRIBUTE", { teamId })).toHaveLength(1);

    // Already distributed.
    expect((await confirmKeyCall(teamId, rowId, owner, 1)).status).toBe(409);
    expect(await auditRows("TEAM_MEMBER_KEY_DISTRIBUTE", { teamId })).toHaveLength(1);

    // Member gone: confirm-key's pre-read finds no row at all (not a CAS
    // count 0 — the CAS never runs), so it 404s before touching the key.
    const gone = await member();
    const goneRowId = await pendingMember(teamId, gone.id, "MEMBER");
    await setEcdhKey(gone.id);
    expect((await approve(teamId, goneRowId, owner, "MEMBER")).status).toBe(200);
    await sql(`DELETE FROM team_members WHERE id = $1::uuid`, goneRowId);
    expect((await confirmKeyCall(teamId, goneRowId, owner, 1)).status).toBe(404);
    expect(await auditRows("TEAM_MEMBER_KEY_DISTRIBUTE", { teamId })).toHaveLength(1);
  });

  // ── A11 (GET half) ───────────────────────────────────────────

  it("A11: members GET shows a pending row to an ADMIN, not to a MEMBER or VIEWER", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const admin = await ctx.createUser(tenantId);
    await activeMember(teamId, admin, "ADMIN", { keyDistributed: true });
    const plainMember = await ctx.createUser(tenantId);
    await activeMember(teamId, plainMember, "MEMBER");
    const viewer = await ctx.createUser(tenantId);
    await activeMember(teamId, viewer, "VIEWER");
    const pending = await member();
    await pendingMember(teamId, pending.id, "MEMBER");

    const asAdmin = (await (await membersGet(teamId, admin)).json()) as { userId: string; pendingApproval?: boolean }[];
    expect(asAdmin.find((m) => m.userId === pending.id)).toMatchObject({ pendingApproval: true });

    for (const caller of [plainMember, viewer]) {
      const res = await membersGet(teamId, caller);
      // (T7) 200 with the owner's row present is the positive control: the
      // pending row is absent because the list filters it, not because the
      // whole call failed (which would also leave it out of an error body).
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string }[];
      expect(body.some((m) => m.userId === owner)).toBe(true);
      expect(body.some((m) => m.userId === pending.id)).toBe(false);
    }
  });

  // ── A12 ──────────────────────────────────────────────────────

  it("A12: approve with a stale expectedRole, after a second group add raised the pending role, answers 409 and leaves it pending", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const memberGroup = await mapGroup(teamId, "MEMBER");
    const adminGroup = await mapGroup(teamId, "ADMIN");
    const target = await member();

    expect((await scimPatch(memberGroup, { add: [target.id] })).status).toBe(200);
    expect((await scimPatch(adminGroup, { add: [target.id] })).status).toBe(200);
    const row = await membership(teamId, target.id);
    expect(row).toMatchObject({ role: "ADMIN", scim_approval_pending: true });

    const res = await approve(teamId, row!.id, owner, "MEMBER");
    expect(res.status).toBe(409);
    expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true, role: "ADMIN" });
    // (T4) The stale-role refusal writes no approval.
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
  });

  // ── A13 ──────────────────────────────────────────────────────

  describe("A13: SCIM readers", () => {
    it("GET /Groups and GET /Groups/{id} list a pending member and still exclude a cross-tenant guest", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const groupId = await mapGroup(teamId, "MEMBER");
      const target = await member();
      expect((await scimPatch(groupId, { add: [target.id] })).status).toBe(200);

      const guest = await ctx.createUser(otherTenantId);
      await activeMember(teamId, guest, "MEMBER", { tenant: tenantId });

      const single = (await (await scimGroupGet(groupId)).json()) as { members: { value: string }[] };
      const singleIds = single.members.map((m) => m.value);
      expect(singleIds).toContain(target.id);
      expect(singleIds).not.toContain(guest);

      const list = (await (await scimGroupsList()).json()) as { Resources: { id: string; members: { value: string }[] }[] };
      const group = list.Resources.find((g) => g.id === groupId)!;
      const listIds = group.members.map((m) => m.value);
      expect(listIds).toContain(target.id);
      expect(listIds).not.toContain(guest);
    });

    it("a pending row takes the higher role and a lower-role add never lowers it", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const memberGroup = await mapGroup(teamId, "MEMBER");
      const viewerGroup = await mapGroup(teamId, "VIEWER");
      const adminGroup = await mapGroup(teamId, "ADMIN");
      const target = await member();

      expect((await scimPatch(memberGroup, { add: [target.id] })).status).toBe(200);
      expect((await scimPatch(viewerGroup, { add: [target.id] })).status).toBe(200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: "MEMBER" });
      expect(await auditRows("TEAM_MEMBER_SCIM_PENDING", { teamId })).toHaveLength(1);

      expect((await scimPatch(adminGroup, { add: [target.id] })).status).toBe(200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: "ADMIN" });
      expect(await auditRows("TEAM_MEMBER_SCIM_PENDING", { teamId })).toEqual(
        expect.arrayContaining([expect.objectContaining({ targetId: target.id, metadata: expect.objectContaining({ previousRole: "MEMBER" }) })]),
      );
    });

    it("a PATCH add of a pending user who has since left the tenant is skipped: 200, row unchanged", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const groupId = await mapGroup(teamId, "MEMBER");
      const target = await member();
      expect((await scimPatch(groupId, { add: [target.id] })).status).toBe(200);
      const before = await membership(teamId, target.id);

      expect((await scimUserActive(target.id, false)).status).toBe(200);
      const res = await scimPatch(groupId, { add: [target.id] });

      expect(res.status).toBe(200);
      expect(await membership(teamId, target.id)).toEqual(before);
    });
  });
});
