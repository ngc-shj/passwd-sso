/**
 * Integration test (real DB) for the departed-member follow-ups
 * (docs/archive/review/departed-member-followups-plan.md):
 *
 * - C1: the audit of a change of team membership authority commits with the
 *   change. Per site (members POST create and reactivate, invitations POST, member
 *   PUT role change and ownership transfer): the success cell reads exactly one
 *   audit_outbox row; the atomicity cell makes the outbox INSERT raise through a
 *   temporary trigger and asserts the change did not persist.
 * - C2: the members GET `joinedAt` is the admission time, admitted_at when set.
 *
 * Production routes run on the app role under FORCE RLS; only auth, step-up and
 * rate limits are mocked. Audit rows are read from audit_outbox: the workers are
 * stopped while this suite runs (CLAUDE.md), so audit_logs would be empty.
 *
 * Run: docker compose stop audit-outbox-worker retention-gc-worker &&
 *      npm run test:integration -- departed-member-followups
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createTestContext, recipientKey, setBypassRlsGucs, writeRefusedState, type TestContext } from "./helpers";

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

import { GET as listMembersRoute, POST as addMemberRoute } from "@/app/api/teams/[teamId]/members/route";
import { PUT as changeRoleRoute } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { POST as issueInvitation } from "@/app/api/teams/[teamId]/invitations/route";
import { prisma } from "@/lib/prisma";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

const hex = (n: number) => randomBytes(n).toString("hex");

// Fixed name: check-bypass-rls allowlists exactly this routine in this file.
const PROBE_FN = "c1_audit_outbox_raise_probe";
const PROBE_MARKER = "c1 audit outbox probe";

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("departed-member follow-ups — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  // ── Fixtures (superuser) ──────────────────────────────────────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A tenant MEMBER (createUser makes OWNERs). */
  async function member(): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenantId);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  /**
   * A key row. For an ended member (`ended`) the database refuses writing one
   * (departed_member_guard, key_inactive): such a member holds the keys written
   * before the row ended, so that state is seeded through writeRefusedState.
   */
  async function seedKey(teamId: string, userId: string, ended = false) {
    const text = `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, recipient_key_fingerprint, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, $10, now(), now())`;
    const fingerprint = ended ? null : (await recipientKey(ctx.su, userId)).fingerprint;
    const params = [randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), fingerprint];
    if (ended) await writeRefusedState(ctx.su, text, params);
    else await sql(text, ...params);
  }

  type RowOpts = { createdAt?: string; deactivated?: boolean; pending?: boolean };

  async function addTeamMember(teamId: string, userId: string, role: string, o: RowOpts = {}): Promise<string> {
    const rowId = randomUUID();
    const keyed = !o.pending;
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, scim_managed,
         scim_approval_pending, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", ${o.deactivated || o.pending ? "now()" : "NULL"},
         $6, $6, $7, ${o.createdAt ?? "now()"}, now())`,
      rowId, teamId, userId, tenantId, role, o.pending ?? false, keyed,
    );
    if (keyed) await seedKey(teamId, userId, Boolean(o.deactivated));
    return rowId;
  }

  async function team(owner: string): Promise<{ teamId: string; ownerRowId: string }> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      teamId, tenantId, `team-${teamId.slice(0, 8)}`,
    );
    const ownerRowId = await addTeamMember(teamId, owner, "OWNER", { createdAt: "now() - interval '2 hours'" });
    return { teamId, ownerRowId };
  }

  async function memberRow(teamId: string, userId: string) {
    const [row] = await sql<{
      id: string; role: string; deactivated_at: Date | null; admitted_at: Date | null; created_at: Date;
    }>(
      `SELECT id, role, deactivated_at, admitted_at, created_at FROM team_members
        WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  async function auditRows(action: string, targetId: string) {
    const rows = await sql<{ payload: { metadata: Record<string, unknown> } }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2 AND payload->>'targetId' = $3`,
      tenantId, action, targetId,
    );
    return rows.map((r) => r.payload);
  }

  async function auditCount(action: string): Promise<number> {
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2`,
      tenantId, action,
    );
    return n;
  }

  /**
   * Runs `fn` while every audit_outbox INSERT for this cell's tenant and `action`
   * raises (default SQLSTATE, PROBE_MARKER). The function is dropped in finally;
   * the trigger name is unique per cell.
   */
  async function withFailingAudit<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const trigger = `c1_probe_trg_${randomBytes(6).toString("hex")}`;
    await sql(`DROP FUNCTION IF EXISTS public.${PROBE_FN}() CASCADE`);
    await sql(`CREATE FUNCTION c1_audit_outbox_raise_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${PROBE_MARKER}'; END $$`);
    try {
      await sql(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_outbox FOR EACH ROW
           WHEN (NEW.tenant_id = '${tenantId}'::uuid AND NEW.payload->>'action' = '${action}')
           EXECUTE FUNCTION public.${PROBE_FN}()`,
      );
      return await fn();
    } finally {
      await sql(`DROP TRIGGER IF EXISTS ${trigger} ON audit_outbox`);
      await sql(`DROP FUNCTION IF EXISTS public.${PROBE_FN}()`);
    }
  }

  async function expectRejectsWithMarker(call: Promise<unknown>) {
    await expect(call).rejects.toThrow(PROBE_MARKER);
  }

  // ── Entry points ──────────────────────────────────────────────

  function addMember(teamId: string, actor: string, userId: string, role = "MEMBER") {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return addMemberRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members`, "POST", { userId, role }), {
      params: Promise.resolve({ teamId }),
    });
  }

  function invite(teamId: string, actor: string, email: string, role = "MEMBER") {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return issueInvitation(jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, "POST", { email, role }), {
      params: Promise.resolve({ teamId }),
    });
  }

  function changeRole(teamId: string, memberId: string, actor: string, role: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return changeRoleRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}`, "PUT", { role }), {
      params: Promise.resolve({ teamId, memberId }),
    });
  }

  function listMembers(teamId: string, actor: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return listMembersRoute(new NextRequest(`http://localhost/api/teams/${teamId}/members`), {
      params: Promise.resolve({ teamId }),
    });
  }

  // ── C1: members POST ──────────────────────────────────────────

  describe("C1: members POST", () => {
    const action = AUDIT_ACTION.TEAM_MEMBER_ADD;

    it("create path: audits TEAM_MEMBER_ADD once", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);

      const res = await addMember(teamId, owner, user.id);
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };

      const rows = await auditRows(action, created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ userId: user.id, role: "MEMBER", reactivated: false });
      expect(await auditCount(action)).toBe(1);
    });

    it("reactivate path: audits TEAM_MEMBER_ADD once", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "MEMBER", { deactivated: true });

      expect((await addMember(teamId, owner, user.id)).status).toBe(201);

      const rows = await auditRows(action, rowId);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ userId: user.id, role: "MEMBER", reactivated: true });
      expect(await auditCount(action)).toBe(1);
    });

    it("create path: a failing audit insert rolls the new member back", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);

      await withFailingAudit(action, () => expectRejectsWithMarker(addMember(teamId, owner, user.id)));

      expect(await memberRow(teamId, user.id)).toBeNull();
      expect(await auditCount(action)).toBe(0);
    });

    it("reactivate path: a failing audit insert leaves the row deactivated", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER", { deactivated: true });
      const before = await memberRow(teamId, user.id);

      await withFailingAudit(action, () => expectRejectsWithMarker(addMember(teamId, owner, user.id)));

      expect(await memberRow(teamId, user.id)).toEqual(before);
      expect(before!.deactivated_at).not.toBeNull();
      expect(await auditCount(action)).toBe(0);
    });
  });

  // ── C1: invitations POST ──────────────────────────────────────

  describe("C1: invitations POST", () => {
    const action = AUDIT_ACTION.TEAM_MEMBER_INVITE;
    const invitationsOf = (teamId: string, email: string) =>
      sql(`SELECT id FROM team_invitations WHERE team_id = $1::uuid AND email = $2`, teamId, email);

    it("audits TEAM_MEMBER_INVITE once", async () => {
      const owner = await ctx.createUser(tenantId);
      const { teamId } = await team(owner);
      const email = `invitee-${hex(6)}@example.com`;

      const res = await invite(teamId, owner, email);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const rows = await auditRows(action, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ email, role: "MEMBER" });
      expect(await auditCount(action)).toBe(1);
    });

    it("a failing audit insert leaves no invitation", async () => {
      const owner = await ctx.createUser(tenantId);
      const { teamId } = await team(owner);
      const email = `invitee-${hex(6)}@example.com`;

      await withFailingAudit(action, () => expectRejectsWithMarker(invite(teamId, owner, email)));

      expect(await invitationsOf(teamId, email)).toHaveLength(0);
      expect(await auditCount(action)).toBe(0);
    });
  });

  // ── C1: member PUT ────────────────────────────────────────────

  describe("C1: member PUT", () => {
    const action = AUDIT_ACTION.TEAM_ROLE_UPDATE;

    it("role change: audits TEAM_ROLE_UPDATE once", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "MEMBER");

      expect((await changeRole(teamId, rowId, owner, "ADMIN")).status).toBe(200);

      const rows = await auditRows(action, rowId);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ newRole: "ADMIN", previousRole: "MEMBER" });
      expect(await auditCount(action)).toBe(1);
      expect((await memberRow(teamId, user.id))!.role).toBe("ADMIN");
    });

    it("role change: a failing audit insert leaves the role unchanged", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "MEMBER");

      await withFailingAudit(action, () => expectRejectsWithMarker(changeRole(teamId, rowId, owner, "ADMIN")));

      expect((await memberRow(teamId, user.id))!.role).toBe("MEMBER");
      expect(await auditCount(action)).toBe(0);
    });

    it("ownership transfer: audits TEAM_ROLE_UPDATE once", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "ADMIN");

      expect((await changeRole(teamId, rowId, owner, "OWNER")).status).toBe(200);

      const rows = await auditRows(action, rowId);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ newRole: "OWNER", previousRole: "ADMIN", transfer: true });
      expect(await auditCount(action)).toBe(1);
      expect((await memberRow(teamId, user.id))!.role).toBe("OWNER");
      expect((await memberRow(teamId, owner))!.role).toBe("ADMIN");
    });

    it("ownership transfer: a failing audit insert leaves both roles unchanged", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "ADMIN");

      await withFailingAudit(action, () => expectRejectsWithMarker(changeRole(teamId, rowId, owner, "OWNER")));

      expect((await memberRow(teamId, user.id))!.role).toBe("ADMIN");
      expect((await memberRow(teamId, owner))!.role).toBe("OWNER");
      expect(await auditCount(action)).toBe(0);
    });
  });

  // ── C2: members GET joinedAt ──────────────────────────────────

  describe("C2: members GET joinedAt", () => {
    type Item = { userId: string; joinedAt: string };

    async function joinedAtOf(teamId: string, actor: string, userId: string): Promise<string> {
      const res = await listMembers(teamId, actor);
      expect(res.status).toBe(200);
      const item = ((await res.json()) as Item[]).find((i) => i.userId === userId);
      expect(item).toBeDefined();
      return item!.joinedAt;
    }

    const iso = (d: Date) => d.toISOString();

    it("a member re-admitted through members POST reports admitted_at, not created_at", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER", { createdAt: "now() - interval '1 hour'", deactivated: true });
      expect((await addMember(teamId, owner, user.id)).status).toBe(201);
      const row = (await memberRow(teamId, user.id))!;
      expect(row.admitted_at).not.toBeNull();
      expect(row.admitted_at!.getTime()).not.toBe(row.created_at.getTime());

      expect(await joinedAtOf(teamId, owner, user.id)).toBe(iso(row.admitted_at!));
    });

    it("a never re-admitted member reports created_at", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER", { createdAt: "now() - interval '1 hour'" });
      const row = (await memberRow(teamId, user.id))!;
      expect(row.admitted_at).toBeNull();

      expect(await joinedAtOf(teamId, owner, user.id)).toBe(iso(row.created_at));
    });

    it("a SCIM-pending row (admitted_at NULL) reports created_at", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const { teamId } = await team(owner);
      await addTeamMember(teamId, user.id, "MEMBER", { createdAt: "now() - interval '1 hour'", pending: true });
      const row = (await memberRow(teamId, user.id))!;
      expect(row.admitted_at).toBeNull();

      expect(await joinedAtOf(teamId, owner, user.id)).toBe(iso(row.created_at));
    });
  });
});
