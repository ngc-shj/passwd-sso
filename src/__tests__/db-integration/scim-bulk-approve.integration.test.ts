/**
 * Integration test (real DB): bulk approve / reject of SCIM-pending team
 * memberships (docs/archive/review/scim-bulk-approve-plan.md, cells B1-B8).
 *
 * The bulk routes run under their real RLS contexts on the app role; only
 * auth, step-up and rate-limit (and the SCIM-token boundary, for the SCIM
 * writer in B5a) are mocked. Races are parked on a lock held by a test
 * "blocker" transaction and witnessed through pg_blocking_pids
 * (race-helpers.ts). It carries its own copy of the fixture helpers, so
 * scim-team-admission-approval.integration.test.ts stays untouched.
 *
 * Run: npm run test:integration -- scim-bulk-approve
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { Client } from "pg";
import {
  assertRlsApplies,
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { TEAM_KEY_LOCK_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { SCIM_BULK_ADMISSION_MAX } from "@/lib/constants/team/scim-admission";
import type { Prisma } from "@prisma/client";

const { scimTenant, auditFault } = vi.hoisted(() => ({
  scimTenant: { id: "" },
  auditFault: {
    spy: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    real: { fn: null as null | ((...args: unknown[]) => Promise<unknown>) },
  },
}));
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
// B8 only: logAuditInTx goes through a spy whose default is the real function.
vi.mock("@/lib/audit/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit")>();
  auditFault.real.fn = actual.logAuditInTx as unknown as (...args: unknown[]) => Promise<unknown>;
  auditFault.spy.mockImplementation(auditFault.real.fn);
  return { ...actual, logAuditInTx: (...args: unknown[]) => auditFault.spy(...args) };
});

import { PATCH as scimGroupPatchRoute } from "@/app/api/scim/v2/Groups/[id]/route";
import { POST as approveRoute } from "@/app/api/teams/[teamId]/members/[memberId]/approve/route";
import { POST as bulkApproveRoute } from "@/app/api/teams/[teamId]/members/bulk-approve/route";
import { POST as bulkRejectRoute } from "@/app/api/teams/[teamId]/members/bulk-reject/route";
import { prisma } from "@/lib/prisma";

const hex = (n: number) => randomBytes(n).toString("hex");

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type ApproveEntry = { memberId: string; expectedRole: string };
type Result = { memberId: string; outcome: string };

describe("scim-bulk-approve — real-DB integration", () => {
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
    // B8 swaps in a failing implementation; every other cell wants the real one.
    auditFault.spy.mockImplementation(auditFault.real.fn!);
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

  /** `count` members, ordered by lowercase id — the byte order lockTenantRows locks in. */
  async function membersByLockOrder(count: number): Promise<{ id: string; email: string }[]> {
    const users = await Promise.all(Array.from({ length: count }, () => member()));
    return users.sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1));
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
      id: string; deactivated_at: Date | null; key_distributed: boolean; scim_approval_pending: boolean; role: string;
    }>(
      `SELECT id, deactivated_at, key_distributed, scim_approval_pending, role
         FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  /** A key-holding team ADMIN (can approve). */
  async function keyHoldingAdmin(teamId: string): Promise<string> {
    const admin = await ctx.createUser(tenantId);
    await activeMember(teamId, admin, "ADMIN", { keyDistributed: true });
    await seedKey(teamId, admin);
    return admin;
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

  /** The advisory key lockTenantRows takes for (tenant, user). */
  const holdUserLock = (userId: string) =>
    race.holdRowLock(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`tenant-member:${tenantId}:${userId.toLowerCase()}`]);

  // ── Entry points ─────────────────────────────────────────────

  function bulkApprove(teamId: string, actorUserId: string, members: ApproveEntry[]) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return bulkApproveRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/bulk-approve`, "POST", { members }),
      { params: Promise.resolve({ teamId }) },
    );
  }

  function bulkReject(teamId: string, actorUserId: string, memberIds: string[]) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return bulkRejectRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/bulk-reject`, "POST", { memberIds }),
      { params: Promise.resolve({ teamId }) },
    );
  }

  function singleApprove(teamId: string, memberId: string, actorUserId: string, expectedRole: string) {
    mockAuth.mockResolvedValue({ user: { id: actorUserId } });
    return approveRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/approve`, "POST", { expectedRole }),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function scimPatchRemove(externalGroupId: string, userIds: string[]) {
    return scimGroupPatchRoute(
      jsonRequest(`http://localhost/api/scim/v2/Groups/${externalGroupId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: userIds.map((id) => ({ op: "remove", path: `members[value eq "${id}"]` })),
      }),
      { params: Promise.resolve({ id: externalGroupId }) },
    );
  }

  async function resultsOf(res: Response): Promise<Result[]> {
    return ((await res.json()) as { results: Result[] }).results;
  }

  // ── B1 ───────────────────────────────────────────────────────

  it("B1: a mixed batch reports the right outcome per row, admits exactly the approvable ones, and audits them under one batchId", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const otherTeamId = await team(owner);

    const approvableAdmin = await member();
    const adminRow = await pendingMember(teamId, approvableAdmin.id, "ADMIN");
    const approvableMember = await member();
    const memberRow = await pendingMember(teamId, approvableMember.id, "MEMBER");
    const stale = await member();
    const staleRow = await pendingMember(teamId, stale.id, "ADMIN"); // raised after the page loaded
    const departed = await member();
    const departedRow = await pendingMember(teamId, departed.id, "MEMBER");
    await sql(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, departed.id);
    const already = await member();
    const alreadyRow = await addMemberRow(teamId, already.id, {
      role: "MEMBER", deactivated: false, scimManaged: true, scimApprovalPending: false, keyDistributed: true,
    });
    const elsewhere = await member();
    const elsewhereRow = await pendingMember(otherTeamId, elsewhere.id, "MEMBER");
    const unknownId = randomUUID();

    const res = await bulkApprove(teamId, owner, [
      { memberId: adminRow, expectedRole: "ADMIN" },
      { memberId: staleRow, expectedRole: "MEMBER" },
      { memberId: memberRow, expectedRole: "MEMBER" },
      { memberId: departedRow, expectedRole: "MEMBER" },
      { memberId: alreadyRow, expectedRole: "MEMBER" },
      { memberId: elsewhereRow, expectedRole: "MEMBER" },
      { memberId: unknownId, expectedRole: "MEMBER" },
    ]);

    expect(res.status).toBe(200);
    expect(await resultsOf(res)).toEqual([
      { memberId: adminRow, outcome: "approved" },
      { memberId: staleRow, outcome: "role_changed" },
      { memberId: memberRow, outcome: "approved" },
      { memberId: departedRow, outcome: "tenant_inactive" },
      { memberId: alreadyRow, outcome: "not_found" },
      { memberId: elsewhereRow, outcome: "not_found" },
      { memberId: unknownId, outcome: "not_found" },
    ]);

    for (const [user, role] of [[approvableAdmin, "ADMIN"], [approvableMember, "MEMBER"]] as const) {
      expect(await membership(teamId, user.id)).toMatchObject({
        role, deactivated_at: null, scim_approval_pending: false, key_distributed: false,
      });
    }
    expect(await membership(teamId, stale.id)).toMatchObject({ role: "ADMIN", scim_approval_pending: true });
    expect(await membership(teamId, departed.id)).toMatchObject({ scim_approval_pending: true });
    expect(await membership(teamId, already.id)).toMatchObject({ scim_approval_pending: false, key_distributed: true });
    expect(await membership(otherTeamId, elsewhere.id)).toMatchObject({ scim_approval_pending: true });

    const audits = await auditRows("TEAM_MEMBER_SCIM_APPROVE");
    expect(audits.map((a) => a.targetId).sort()).toEqual([approvableAdmin.id, approvableMember.id].sort());
    expect(audits.find((a) => a.targetId === approvableAdmin.id)?.metadata).toMatchObject({ memberId: adminRow, role: "ADMIN" });
    expect(audits.find((a) => a.targetId === approvableMember.id)?.metadata).toMatchObject({ memberId: memberRow, role: "MEMBER" });
    for (const a of audits) {
      expect(a.scope).toBe(AUDIT_SCOPE.TEAM);
      expect(a.userId).toBe(owner);
    }
    const firstBatchIds = new Set(audits.map((a) => a.metadata.batchId));
    expect(firstBatchIds.size).toBe(1);
    expect(typeof [...firstBatchIds][0]).toBe("string");

    // A second request gets a batchId of its own.
    const later = await member();
    const laterRow = await pendingMember(teamId, later.id, "MEMBER");
    expect((await bulkApprove(teamId, owner, [{ memberId: laterRow, expectedRole: "MEMBER" }])).status).toBe(200);
    const allAudits = await auditRows("TEAM_MEMBER_SCIM_APPROVE");
    expect(allAudits).toHaveLength(3);
    const laterBatchId = allAudits.find((a) => a.targetId === later.id)?.metadata.batchId;
    expect(typeof laterBatchId).toBe("string");
    expect(firstBatchIds.has(laterBatchId)).toBe(false);
  });

  // ── B2 ───────────────────────────────────────────────────────

  it("B2: a key-less team ADMIN's bulk approve answers 403 and changes nothing; the same caller's bulk reject answers 200", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const keylessAdmin = await ctx.createUser(tenantId);
    await activeMember(teamId, keylessAdmin, "ADMIN", { keyDistributed: false });
    const t1 = await member();
    const row1 = await pendingMember(teamId, t1.id, "MEMBER");
    const t2 = await member();
    const row2 = await pendingMember(teamId, t2.id, "MEMBER");

    const approved = await bulkApprove(teamId, keylessAdmin, [
      { memberId: row1, expectedRole: "MEMBER" },
      { memberId: row2, expectedRole: "MEMBER" },
    ]);
    expect(approved.status).toBe(403);
    expect(await membership(teamId, t1.id)).toMatchObject({ scim_approval_pending: true });
    expect(await membership(teamId, t2.id)).toMatchObject({ scim_approval_pending: true });
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);

    const rejected = await bulkReject(teamId, keylessAdmin, [row1, row2]);
    expect(rejected.status).toBe(200);
    expect(await resultsOf(rejected)).toEqual([
      { memberId: row1, outcome: "rejected" },
      { memberId: row2, outcome: "rejected" },
    ]);
    expect(await membership(teamId, t1.id)).toBeNull();
    expect(await membership(teamId, t2.id)).toBeNull();
  });

  // ── B3 ───────────────────────────────────────────────────────

  it("B3: bulk reject deletes exactly the listed pending rows; an active member, another team's pending row and an unknown id are not_found and intact", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const otherTeamId = await team(owner);

    const p1 = await member();
    const p1Row = await pendingMember(teamId, p1.id, "ADMIN");
    const p2 = await member();
    const p2Row = await pendingMember(teamId, p2.id, "VIEWER");
    const active = await member();
    const activeRow = await activeMember(teamId, active.id, "MEMBER");
    const elsewhere = await member();
    const elsewhereRow = await pendingMember(otherTeamId, elsewhere.id, "MEMBER");
    const unknownId = randomUUID();

    const res = await bulkReject(teamId, owner, [p1Row, activeRow, elsewhereRow, p2Row, unknownId]);

    expect(res.status).toBe(200);
    expect(await resultsOf(res)).toEqual([
      { memberId: p1Row, outcome: "rejected" },
      { memberId: activeRow, outcome: "not_found" },
      { memberId: elsewhereRow, outcome: "not_found" },
      { memberId: p2Row, outcome: "rejected" },
      { memberId: unknownId, outcome: "not_found" },
    ]);
    expect(await membership(teamId, p1.id)).toBeNull();
    expect(await membership(teamId, p2.id)).toBeNull();
    expect(await membership(teamId, active.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    expect(await membership(otherTeamId, elsewhere.id)).toMatchObject({ scim_approval_pending: true });

    const audits = await auditRows("TEAM_MEMBER_SCIM_REJECT");
    expect(audits.map((a) => a.targetId).sort()).toEqual([p1.id, p2.id].sort());
    // The role in the audit row is the locked row's, per target.
    expect(audits.find((a) => a.targetId === p1.id)?.metadata).toMatchObject({ memberId: p1Row, role: "ADMIN" });
    expect(audits.find((a) => a.targetId === p2.id)?.metadata).toMatchObject({ memberId: p2Row, role: "VIEWER" });
    expect(new Set(audits.map((a) => a.metadata.batchId)).size).toBe(1);
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE")).toEqual([]);
  });

  // ── B4 ───────────────────────────────────────────────────────

  it("B4: a single approve of a row a parked bulk request holds queues behind it, then answers 404; one audit row", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const approver2 = await keyHoldingAdmin(teamId);
    const target = await member();
    const rowId = await pendingMember(teamId, target.id, "MEMBER");

    const blocker = await race.holdRowLock(`SELECT id FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [teamId]);
    let bulking: Promise<Response> | undefined;
    let single: Promise<Response> | undefined;
    try {
      bulking = bulkApprove(teamId, owner, [{ memberId: rowId, expectedRole: "MEMBER" }]);
      const bulkPid = await race.waitForBackendBlockedBy(blocker.pid);
      single = singleApprove(teamId, rowId, approver2, "MEMBER");
      expect(await race.settledOrBlocked(single, bulkPid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      const bulkRes = await bulking;
      expect(bulkRes.status).toBe(200);
      expect(await resultsOf(bulkRes)).toEqual([{ memberId: rowId, outcome: "approved" }]);
      expect((await single).status).toBe(404);
    } finally {
      await blocker.release();
      await Promise.allSettled([bulking, single]);
    }
    expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([
      expect.objectContaining({ targetId: target.id }),
    ]);
  });

  // ── B5a ──────────────────────────────────────────────────────

  it("B5a: a bulk approve parked behind a SCIM remove of a listed user finds that row gone after it commits", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const groupId = await mapGroup(teamId, "MEMBER");
    // A sorts before B: SCIM takes A's advisory lock, then waits on B's (held by the blocker).
    const [a, b] = await membersByLockOrder(2);
    const aRow = await pendingMember(teamId, a.id, "MEMBER");
    await activeMember(teamId, b.id, "MEMBER");
    const c = await member();
    const cRow = await pendingMember(teamId, c.id, "MEMBER");

    const blocker = await holdUserLock(b.id);
    let scimming: Promise<Response> | undefined;
    let bulking: Promise<Response> | undefined;
    try {
      scimming = scimPatchRemove(groupId, [a.id, b.id]);
      const scimPid = await race.waitForBackendBlockedBy(blocker.pid);
      bulking = bulkApprove(teamId, owner, [
        { memberId: aRow, expectedRole: "MEMBER" },
        { memberId: cRow, expectedRole: "MEMBER" },
      ]);
      expect(await race.settledOrBlocked(bulking, scimPid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      expect((await scimming).status).toBe(200);
      const bulkRes = await bulking;
      expect(bulkRes.status).toBe(200);
      expect(await resultsOf(bulkRes)).toEqual([
        { memberId: aRow, outcome: "not_found" },
        { memberId: cRow, outcome: "approved" },
      ]);
    } finally {
      await blocker.release();
      await Promise.allSettled([scimming, bulking]);
    }
    expect(await membership(teamId, a.id)).toBeNull();
    expect(await membership(teamId, c.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    expect((await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).map((r) => r.targetId)).toEqual([c.id]);
  });

  // ── B5b ──────────────────────────────────────────────────────

  it("B5b: a target's advisory lock held past the lock budget answers 409 with every row pending and no audit row", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const t1 = await member();
    const row1 = await pendingMember(teamId, t1.id, "MEMBER");
    const t2 = await member();
    const row2 = await pendingMember(teamId, t2.id, "MEMBER");

    const blocker = await holdUserLock(t2.id);
    let bulking: Promise<Response> | undefined;
    try {
      const startedAt = Date.now();
      bulking = bulkApprove(teamId, owner, [
        { memberId: row1, expectedRole: "MEMBER" },
        { memberId: row2, expectedRole: "MEMBER" },
      ]);
      await race.waitForBackendBlockedBy(blocker.pid);
      // The blocker stays held: the response can only be the budget running out.
      const res = await bulking;
      expect(res.status).toBe(409);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TEAM_KEY_LOCK_TIMEOUT_MS - 250);
    } finally {
      await blocker.release();
      await Promise.allSettled([bulking]);
    }
    expect(await membership(teamId, t1.id)).toMatchObject({ scim_approval_pending: true });
    expect(await membership(teamId, t2.id)).toMatchObject({ scim_approval_pending: true });
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);
  });

  // ── B5c ──────────────────────────────────────────────────────

  it("B5c: a bulk request naming only an active member answers not_found without waiting for that member's lock", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const active = await member();
    const activeRow = await activeMember(teamId, active.id, "MEMBER");

    const blocker = await holdUserLock(active.id);
    try {
      // Without the pre-read's pending filter this would park on the blocker and
      // settle as a 409 after the lock budget; the response arriving now, with
      // the blocker held, is the pass condition.
      const res = await bulkApprove(teamId, owner, [{ memberId: activeRow, expectedRole: "MEMBER" }]);
      expect(res.status).toBe(200);
      expect(await resultsOf(res)).toEqual([{ memberId: activeRow, outcome: "not_found" }]);
      expect(await race.backendsBlockedBy(blocker.pid)).toEqual([]);
    } finally {
      await blocker.release();
    }
    expect(await membership(teamId, active.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);

    // Positive control: the same hold on a PENDING row's user parks the request.
    const pending = await member();
    const pendingRow = await pendingMember(teamId, pending.id, "MEMBER");
    const controlBlocker = await holdUserLock(pending.id);
    let parked: Promise<Response> | undefined;
    try {
      parked = bulkApprove(teamId, owner, [{ memberId: pendingRow, expectedRole: "MEMBER" }]);
      await race.waitForBackendBlockedBy(controlBlocker.pid);
      await controlBlocker.release();
      const parkedRes = await parked;
      expect(parkedRes.status).toBe(200);
      expect(await resultsOf(parkedRes)).toEqual([{ memberId: pendingRow, outcome: "approved" }]);
    } finally {
      await controlBlocker.release();
      await Promise.allSettled([parked]);
    }
  });

  // ── B6 ───────────────────────────────────────────────────────

  it("B6: two bulk requests with overlapping users in different teams serialise in lock order and both commit", async () => {
    const owner1 = await ctx.createUser(tenantId);
    const owner2 = await ctx.createUser(tenantId);
    const team1 = await team(owner1);
    const team2 = await team(owner2);
    const [a, m, z] = await membersByLockOrder(3);
    const a1 = await pendingMember(team1, a.id, "MEMBER");
    const m1 = await pendingMember(team1, m.id, "MEMBER");
    const z1 = await pendingMember(team1, z.id, "MEMBER");
    const a2 = await pendingMember(team2, a.id, "MEMBER");
    const z2 = await pendingMember(team2, z.id, "MEMBER");

    const blocker = await holdUserLock(m.id);
    let bulk1: Promise<Response> | undefined;
    let bulk2: Promise<Response> | undefined;
    try {
      bulk1 = bulkApprove(team1, owner1, [
        { memberId: a1, expectedRole: "MEMBER" },
        { memberId: m1, expectedRole: "MEMBER" },
        { memberId: z1, expectedRole: "MEMBER" },
      ]);
      // bulk1 holds A's lock and waits for M's, held by the blocker.
      const bulk1Pid = await race.waitForBackendBlockedBy(blocker.pid);
      bulk2 = bulkApprove(team2, owner2, [
        { memberId: a2, expectedRole: "MEMBER" },
        { memberId: z2, expectedRole: "MEMBER" },
      ]);
      expect(await race.settledOrBlocked(bulk2, bulk1Pid, blocker.pid)).toBe("blocked-on-parked");
      await blocker.release();
      const res1 = await bulk1;
      const res2 = await bulk2;
      expect(res1.status).toBe(200);
      expect(await resultsOf(res1)).toEqual([
        { memberId: a1, outcome: "approved" },
        { memberId: m1, outcome: "approved" },
        { memberId: z1, outcome: "approved" },
      ]);
      expect(res2.status).toBe(200);
      expect(await resultsOf(res2)).toEqual([
        { memberId: a2, outcome: "approved" },
        { memberId: z2, outcome: "approved" },
      ]);
    } finally {
      await blocker.release();
      await Promise.allSettled([bulk1, bulk2]);
    }
    for (const user of [a, m, z]) {
      expect(await membership(team1, user.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    }
    for (const user of [a, z]) {
      expect(await membership(team2, user.id)).toMatchObject({ scim_approval_pending: false, deactivated_at: null });
    }
    expect((await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId: team1 })).map((r) => r.targetId).sort()).toEqual([a.id, m.id, z.id].sort());
    expect((await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId: team2 })).map((r) => r.targetId).sort()).toEqual([a.id, z.id].sort());
  });

  // ── B7: C6 measurement ───────────────────────────────────────

  describe("B7: cap measurement", () => {
    /** `count` pending rows with their users and tenant memberships, in one statement. */
    async function seedPending(teamId: string, count: number): Promise<string[]> {
      const rows = await sql<{ id: string }>(
        `WITH u AS (
           INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
           SELECT gen_random_uuid(), $1::uuid, 'b7-' || gen_random_uuid() || '@example.com', 'B7 user', now(), now()
             FROM generate_series(1, $3::int)
           RETURNING id
         ), tm AS (
           INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
           SELECT gen_random_uuid(), $1::uuid, id, 'MEMBER', now(), now() FROM u
         )
         INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, deactivated_by_tenant,
           scim_managed, scim_approval_pending, key_distributed, created_at, updated_at)
         SELECT gen_random_uuid(), $2::uuid, id, $1::uuid, 'MEMBER'::"TeamRole", now(), false,
           true, true, false, now(), now() FROM u
         RETURNING id`,
        tenantId, teamId, count,
      );
      return rows.map((r) => r.id);
    }

    type Call = (teamId: string, owner: string, ids: string[]) => Promise<Response>;
    const kinds: { kind: "approve" | "reject"; call: Call; done: string }[] = [
      { kind: "approve", call: (t, o, ids) => bulkApprove(t, o, ids.map((memberId) => ({ memberId, expectedRole: "MEMBER" }))), done: "approved" },
      { kind: "reject", call: (t, o, ids) => bulkReject(t, o, ids), done: "rejected" },
    ];

    it.each(kinds)("B7: $kind of the cap-sized batch, timed and counted", async ({ kind, call, done }) => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);

      /** Seed before the timer; time and count only the route call. */
      async function run(n: number): Promise<{ ms: number; statements: number }> {
        const ids = await seedPending(teamId, n);
        expect(ids).toHaveLength(n);
        const spy = vi.spyOn(Client.prototype, "query");
        let res: Response;
        let ms: number;
        let statements: number;
        try {
          const startedAt = performance.now();
          res = await call(teamId, owner, ids);
          ms = performance.now() - startedAt;
          statements = spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
        expect(res.status).toBe(200);
        const results = await resultsOf(res);
        expect(results).toHaveLength(n);
        expect(results.every((r) => r.outcome === done)).toBe(true);
        // A spy that missed the driver would read as a tiny constant.
        expect(statements).toBeGreaterThan(n);
        return { ms, statements };
      }

      await run(SCIM_BULK_ADMISSION_MAX); // warm-up
      const timed: { ms: number; statements: number }[] = [];
      for (let i = 0; i < 5; i++) timed.push(await run(SCIM_BULK_ADMISSION_MAX));
      const small = await run(10);

      const maxMs = Math.max(...timed.map((t) => t.ms));
      console.log(
        `[B7] kind=${kind} n=${SCIM_BULK_ADMISSION_MAX} max_ms=${maxMs.toFixed(1)} ` +
          `statements=${timed[timed.length - 1].statements} statements_n10=${small.statements}`,
      );
    }, 180_000);
  });

  // ── B8 ───────────────────────────────────────────────────────

  it("B8: an audit write failing on the third row rolls the whole request back; the same batch without the fault admits all three", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const targets: { user: { id: string }; rowId: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const user = await member();
      targets.push({ user, rowId: await pendingMember(teamId, user.id, "MEMBER") });
    }
    const entries = targets.map((t) => ({ memberId: t.rowId, expectedRole: "MEMBER" }));

    let calls = 0;
    auditFault.spy.mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 3) throw new Error("audit write failed");
      return auditFault.real.fn!(...args);
    });
    // The handler does not catch it: the route is called directly, so it rejects.
    await expect(bulkApprove(teamId, owner, entries)).rejects.toThrow("audit write failed");
    expect(calls).toBe(3);

    for (const t of targets) {
      expect(await membership(teamId, t.user.id)).toMatchObject({
        scim_approval_pending: true, deactivated_at: expect.any(Date),
      });
    }
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toEqual([]);

    // Control: the pass-through restored, the rows the failed request left pending admit.
    auditFault.spy.mockImplementation(auditFault.real.fn!);
    const res = await bulkApprove(teamId, owner, entries);
    expect(res.status).toBe(200);
    expect((await resultsOf(res)).map((r) => r.outcome)).toEqual(["approved", "approved", "approved"]);
    expect(await auditRows("TEAM_MEMBER_SCIM_APPROVE", { teamId })).toHaveLength(3);
  });
});
