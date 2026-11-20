/**
 * Integration test (real DB): a leftover team membership — an active
 * team_members row whose user left the team's tenant at or after their admission
 * — grants no team authority of any kind
 * (docs/archive/review/leftover-team-actor-authority-plan.md, #1055).
 *
 * - C1: getTeamMembership refuses a leftover on every team route (404, as for a
 *   non-member), proven on both residue seeds.
 * - C2: the actor-on-others sites #1043 excluded (member DELETE, SCIM reject
 *   single and bulk, invitation cancel) re-check the actor under the locks.
 *   C1 refuses a leftover before those transactions, so the deny cells inject
 *   the departure AFTER the gate (a one-shot hook in the team IP restriction, or
 *   in the step-up check for member DELETE) and assert the in-transaction 403;
 *   C1's own 404 is asserted in separate cells.
 * - C3: the consistency readers (team list, admin shell, pending key
 *   distributions, key holders) drop leftover memberships.
 * - C4: team webhook delivery stops for a leftover creator, run as the real
 *   outbox worker role.
 *
 * The two seeds (the same states departed-member-leaked-authority uses):
 *   residueDepart  — the user's tenant row deactivated by a raw UPDATE, team row left active;
 *   recreatedDepart — a departure record while the tenant row stays active.
 *
 * Production routes run on the app role under FORCE RLS; only auth, step-up,
 * rate limits and the SSRF IP resolution (the mock receiver is on loopback) are
 * mocked. Audit rows are read from audit_outbox, never audit_logs: this file
 * does not start the drainer.
 *
 * Run: npm run test:integration -- leftover-team-actor-authority
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  assertRlsApplies,
  createTestContext,
  recipientKey,
  setBypassRlsGucs,
  writeRefusedState,
  type TestContext,
} from "./helpers";

const { afterGate, stepUp } = vi.hoisted(() => ({
  afterGate: { hook: null as (() => Promise<void>) | null, fired: false },
  stepUp: { hook: null as (() => Promise<void>) | null, fired: false },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
// Step-up runs after requireTeamPermission, so a one-shot hook here runs
// strictly after the getTeamMembership gate. Default: the current `null`.
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => {
    const hook = stepUp.hook;
    stepUp.hook = null;
    if (hook) {
      stepUp.fired = true;
      await hook();
    }
    return null;
  },
}));
// requireTeamMember calls withTeamIpRestriction once the membership resolved: a
// one-shot hook here runs after the gate too. Everything else passes through to
// the real module, and so does the restriction itself.
vi.mock("@/lib/team/team-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/team/team-policy")>();
  return {
    ...actual,
    withTeamIpRestriction: async (...args: Parameters<typeof actual.withTeamIpRestriction>) => {
      const hook = afterGate.hook;
      afterGate.hook = null;
      if (hook) {
        afterGate.fired = true;
        await hook();
      }
      return actual.withTeamIpRestriction(...args);
    },
  };
});
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));
// Loopback is blocked by the SSRF guard: resolve every webhook host to the mock
// receiver's loopback address, keeping the rest real.
vi.mock("@/lib/http/external-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/external-http")>();
  return { ...actual, resolveAndValidateIps: vi.fn(async () => ["127.0.0.1"]) };
});

import { GET as listTeamsRoute } from "@/app/api/teams/route";
import { GET as pendingKeyDistributionsRoute } from "@/app/api/teams/pending-key-distributions/route";
import { PUT as updateTeamRoute, DELETE as deleteTeamRoute } from "@/app/api/teams/[teamId]/route";
import { GET as listPasswordsRoute } from "@/app/api/teams/[teamId]/passwords/route";
import { POST as createTagRoute } from "@/app/api/teams/[teamId]/tags/route";
import { GET as memberKeyRoute } from "@/app/api/teams/[teamId]/member-key/route";
import { DELETE as removeMemberRoute } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { POST as rejectRoute } from "@/app/api/teams/[teamId]/members/[memberId]/reject/route";
import { POST as bulkRejectRoute } from "@/app/api/teams/[teamId]/members/bulk-reject/route";
import { DELETE as cancelInvitationRoute } from "@/app/api/teams/[teamId]/invitations/[invId]/route";
import { GET as rekeyRoute } from "@/app/api/teams/[teamId]/rekey/route";
import { POST as restoreHistoryRoute } from "@/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/restore/route";
import { GET as listWebhooksRoute, POST as createWebhookRoute } from "@/app/api/teams/[teamId]/webhooks/route";
import { deliverRowWithChain, processWebhookDeliveryBatch, type AuditOutboxRow } from "@/workers/audit-outbox-worker";
import { enqueueAuditInTx } from "@/lib/audit/audit-outbox";
import { buildOutboxPayload } from "@/lib/audit/audit-payload";
import { prisma } from "@/lib/prisma";
import { getAdminTeamMemberships } from "@/lib/auth/access/team-auth";
import { rejectScimPending } from "@/lib/team/scim-admission";
import { holderInputsFrom, type VersionHoldersDto } from "@/lib/team/rekey-report";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import {
  AUDIT_ACTION,
  AUDIT_SCOPE,
  TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS,
  WEBHOOK_DISPATCH_SUPPRESS,
} from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import { SCIM_REJECT_OUTCOME } from "@/lib/constants/team/scim-admission";

const hex = (n: number) => randomBytes(n).toString("hex");
/** A team-webhook-subscribable action the dispatcher does not suppress. */
const EVENT = AUDIT_ACTION.ENTRY_CREATE;

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("leftover team actor authority — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    vi.clearAllMocks();
    afterGate.hook = null;
    afterGate.fired = false;
    stepUp.hook = null;
    stepUp.fired = false;
  });

  afterEach(async () => {
    afterGate.hook = null;
    stepUp.hook = null;
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  // ── Fixtures (superuser) ──────────────────────────────────────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A tenant MEMBER (createUser makes OWNERs, whom a departure never touches). */
  async function member(tenant = tenantId): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  async function setEcdhKey(userId: string) {
    await recipientKey(ctx.su, userId);
  }

  async function seedKey(teamId: string, userId: string, tenant = tenantId, keyVersion = 1) {
    const { fingerprint } = await recipientKey(ctx.su, userId);
    await sql(
      `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, recipient_key_fingerprint, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, $11, now(), now())`,
      randomUUID(), teamId, tenant, userId, hex(32), hex(12), hex(16), hex(32), hex(32), keyVersion, fingerprint,
    );
  }

  type RowOpts = {
    createdAt?: string;
    keyDistributed?: boolean;
    pending?: boolean;
    withKey?: boolean;
    keyVersion?: number;
    tenant?: string;
  };

  /**
   * A team_members row, every field explicit. `createdAt` is SQL. `updated_at`
   * is set to now(); the admission anchor is created_at (admitted_at is NULL,
   * as for a row never re-activated).
   */
  async function addTeamMember(teamId: string, userId: string, role: string, o: RowOpts = {}): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, scim_managed,
         scim_approval_pending, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", ${o.pending ? "now()" : "NULL"},
         $6, $6, $7, ${o.createdAt ?? "now()"}, now())`,
      rowId, teamId, userId, o.tenant ?? tenantId, role, o.pending ?? false, o.keyDistributed ?? true,
    );
    if (o.withKey ?? o.keyDistributed ?? true) await seedKey(teamId, userId, o.tenant, o.keyVersion);
    return rowId;
  }

  async function team(owner: string, tenant = tenantId, teamKeyVersion = 1): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      id, tenant, `team-${id.slice(0, 8)}`, teamKeyVersion,
    );
    await addTeamMember(id, owner, "OWNER", { tenant, createdAt: "now() - interval '2 hours'" });
    return id;
  }

  async function membership(teamId: string, userId: string) {
    const [row] = await sql<{
      id: string; role: string; deactivated_at: Date | null; admitted_at: Date | null; scim_approval_pending: boolean;
    }>(
      `SELECT id, role, deactivated_at, admitted_at, scim_approval_pending
         FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  /** The residue state: the user's tenant row deactivated by a raw UPDATE; their team rows stay active. */
  async function residueDepart(userId: string, tenant = tenantId) {
    // Refused since departed_member_guard (pre-guard databases hold it).
    const changed = await writeRefusedState(
      ctx.su,
      `UPDATE tenant_members SET deactivated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid RETURNING 1`,
      [tenant, userId],
    );
    expect(changed).toHaveLength(1);
  }

  /**
   * The re-created state: a departure record (stamped now unless `departedAt`,
   * SQL, says otherwise) while the tenant row stays active. Exactly one row.
   */
  async function recreatedDepart(userId: string, departedAt = "clock_timestamp()", tenant = tenantId) {
    // Refused since departed_member_guard, as residueDepart.
    const written = await writeRefusedState(
      ctx.su,
      `INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at)
       VALUES ($1::uuid, $2::uuid, ${departedAt}) RETURNING 1`,
      [tenant, userId],
    );
    expect(written).toHaveLength(1);
  }

  const seeds = [
    ["residue (tenant row deactivated)", residueDepart],
    ["re-created (departure record, tenant row active)", recreatedDepart],
  ] as const;

  /**
   * Re-admit an already-departed member the way accept did: the team row is
   * deactivated and re-activated, and the trigger stamps admitted_at after the
   * departure. Needs the departure first. Over a departed tenant row (the
   * residue seed) the departed-member guard refuses the re-activation, and
   * accept no longer makes it (C9); pre-guard databases and the runbook
   * re-admit script hold it, so the re-activation goes through
   * writeRefusedState, with the admitted_at the trigger would stamp.
   */
  async function readmit(teamId: string, userId: string) {
    await sql(`SELECT pg_sleep(0.02)::text`);
    await sql(`UPDATE team_members SET deactivated_at = clock_timestamp() WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, userId);
    await writeRefusedState(
      ctx.su,
      `UPDATE team_members SET deactivated_at = NULL, admitted_at = clock_timestamp() WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      [teamId, userId],
    );
    const row = await membership(teamId, userId);
    expect(row!.admitted_at).not.toBeNull();
  }

  async function insertInvitation(teamId: string, inviter: string, email: string, tenant = tenantId) {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token_hash, expires_at, invited_by_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER'::"TeamRole", 'PENDING', $5, now() + interval '1 day', $6::uuid, now())`,
      id, teamId, tenant, email, hex(32), inviter,
    );
    return id;
  }

  async function invitationExists(id: string): Promise<boolean> {
    return (await sql(`SELECT 1 FROM team_invitations WHERE id = $1::uuid`, id)).length === 1;
  }

  async function keyRows(teamId: string, userId: string): Promise<number> {
    return (await sql(`SELECT 1 FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, userId)).length;
  }

  /** The hook ran: the request got past its gate (it was not refused by it). */
  function expectGatePassed(hook: { fired: boolean }) {
    expect(hook.fired).toBe(true);
  }

  // ── Entry points ──────────────────────────────────────────────

  function asUser(userId: string) {
    mockAuth.mockResolvedValue({ user: { id: userId } });
  }

  const teamParams = (teamId: string) => ({ params: Promise.resolve({ teamId }) });

  function getRequest(path: string) {
    return new NextRequest(`http://localhost${path}`);
  }

  function listPasswords(teamId: string, actor: string) {
    asUser(actor);
    return listPasswordsRoute(getRequest(`/api/teams/${teamId}/passwords`), teamParams(teamId));
  }

  function createTag(teamId: string, actor: string) {
    asUser(actor);
    return createTagRoute(jsonRequest(`http://localhost/api/teams/${teamId}/tags`, "POST", { name: `tag-${hex(4)}` }), teamParams(teamId));
  }

  function updateTeam(teamId: string, actor: string, name: string) {
    asUser(actor);
    return updateTeamRoute(jsonRequest(`http://localhost/api/teams/${teamId}`, "PUT", { name }), teamParams(teamId));
  }

  function deleteTeam(teamId: string, actor: string) {
    asUser(actor);
    return deleteTeamRoute(new NextRequest(`http://localhost/api/teams/${teamId}`, { method: "DELETE" }), teamParams(teamId));
  }

  function memberKey(teamId: string, actor: string) {
    asUser(actor);
    return memberKeyRoute(getRequest(`/api/teams/${teamId}/member-key`), teamParams(teamId));
  }

  function removeMember(teamId: string, memberId: string, actor: string) {
    asUser(actor);
    return removeMemberRoute(new NextRequest(`http://localhost/api/teams/${teamId}/members/${memberId}`, { method: "DELETE" }), {
      params: Promise.resolve({ teamId, memberId }),
    });
  }

  function rejectMember(teamId: string, memberId: string, actor: string) {
    asUser(actor);
    return rejectRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/reject`, "POST"), {
      params: Promise.resolve({ teamId, memberId }),
    });
  }

  function bulkReject(teamId: string, memberIds: string[], actor: string) {
    asUser(actor);
    return bulkRejectRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members/bulk-reject`, "POST", { memberIds }), teamParams(teamId));
  }

  function cancelInvitation(urlTeamId: string, invId: string, actor: string) {
    asUser(actor);
    return cancelInvitationRoute(
      new NextRequest(`http://localhost/api/teams/${urlTeamId}/invitations/${invId}`, { method: "DELETE" }),
      { params: Promise.resolve({ teamId: urlTeamId, invId }) },
    );
  }

  /** TEAM_MEMBER_INVITE_CANCEL rows, from audit_outbox (the drainer is not started here). */
  async function cancelAudits(invId: string) {
    const rows = await sql<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2 AND payload->>'targetId' = $3`,
      tenantId, AUDIT_ACTION.TEAM_MEMBER_INVITE_CANCEL, invId,
    );
    return rows.map((r) => r.payload);
  }

  // ── C1: getTeamMembership refuses a leftover on every team route ──

  describe("C1: a leftover membership is refused like a non-member, on every team route", () => {
    /** The OWNER's team (admitted 2 hours ago, holding the key), plus a bystander ADMIN. */
    async function ownedTeam() {
      const actor = await member();
      const teamId = await team(actor.id);
      return { actor, teamId };
    }

    type Site = {
      name: string;
      call: (teamId: string, actor: string) => Promise<Response>;
      okStatus: number;
      /** What must not have changed when refused. */
      unchanged: (teamId: string) => Promise<void>;
    };

    const sites: Site[] = [
      {
        name: "team passwords GET",
        call: listPasswords,
        okStatus: 200,
        unchanged: async () => {},
      },
      {
        name: "team tags POST",
        call: createTag,
        okStatus: 201,
        unchanged: async (teamId) => {
          expect(await sql(`SELECT 1 FROM team_tags WHERE team_id = $1::uuid`, teamId)).toHaveLength(0);
        },
      },
      {
        name: "team PUT",
        call: (teamId, actor) => updateTeam(teamId, actor, "renamed-by-leftover"),
        okStatus: 200,
        unchanged: async (teamId) => {
          const [row] = await sql<{ name: string }>(`SELECT name FROM teams WHERE id = $1::uuid`, teamId);
          expect(row.name).toBe(`team-${teamId.slice(0, 8)}`);
        },
      },
      {
        name: "team DELETE",
        call: deleteTeam,
        okStatus: 200,
        unchanged: async (teamId) => {
          expect(await sql(`SELECT 1 FROM teams WHERE id = $1::uuid`, teamId)).toHaveLength(1);
          expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, teamId)).toHaveLength(1);
        },
      },
      {
        name: "member-key GET",
        call: memberKey,
        okStatus: 200,
        unchanged: async () => {},
      },
    ];

    describe.each(sites)("$name", (site) => {
      it.each(seeds)("a leftover OWNER gets 404, state unchanged: %s", async (_label, depart) => {
        const { actor, teamId } = await ownedTeam();
        await depart(actor.id);

        const res = await site.call(teamId, actor.id);

        expect(res.status).toBe(404);
        expect(await membership(teamId, actor.id)).toMatchObject({ role: "OWNER", deactivated_at: null });
        await site.unchanged(teamId);
      });

      it("allowed without the departure (positive twin)", async () => {
        const { actor, teamId } = await ownedTeam();

        const res = await site.call(teamId, actor.id);

        expect(res.status).toBe(site.okStatus);
      });
    });

    it("member-key GET returns the key row to the positive twin and nothing to the leftover", async () => {
      const leftover = await member();
      const teamId = await team(leftover.id);
      const twin = await member();
      await addTeamMember(teamId, twin.id, "MEMBER", { createdAt: "now() - interval '1 hour'" });
      await residueDepart(leftover.id);

      const refused = await memberKey(teamId, leftover.id);
      const served = await memberKey(teamId, twin.id);

      expect(refused.status).toBe(404);
      expect(JSON.stringify(await refused.json())).not.toContain("encryptedTeamKey");
      expect(served.status).toBe(200);
      expect(await served.json()).toHaveProperty("encryptedTeamKey");
    });

    it.each([
      ["residue", residueDepart],
      ["re-created", recreatedDepart],
    ] as const)("a guest from another tenant is unaffected (%s departure from their own tenant)", async (_label, departFromOwn) => {
      const owner = await member();
      const teamId = await team(owner.id);
      const guest = await member(otherTenantId);
      await addTeamMember(teamId, guest.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      // Leaving their own tenant makes them neither a leftover nor a non-member of this team.
      await (departFromOwn === residueDepart
        ? residueDepart(guest.id, otherTenantId)
        : recreatedDepart(guest.id, "clock_timestamp()", otherTenantId));

      expect((await listPasswords(teamId, guest.id)).status).toBe(200);
      expect((await memberKey(teamId, guest.id)).status).toBe(200);
    });

    it("a member re-admitted after the departure (created_at < departure < admitted_at) is unaffected", async () => {
      const owner = await member();
      const teamId = await team(owner.id);
      const readmitted = await member();
      await addTeamMember(teamId, readmitted.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      await residueDepart(readmitted.id);
      await readmit(teamId, readmitted.id);

      expect((await listPasswords(teamId, readmitted.id)).status).toBe(200);
      expect((await memberKey(teamId, readmitted.id)).status).toBe(200);
    });

    it.each([
      ["departed at exactly the admission instant: refused", "timestamptz '2026-01-01 00:00:00+00'", 404],
      ["departed 1 ms before the admission: allowed", "timestamptz '2025-12-31 23:59:59.999+00'", 200],
    ] as const)("equality boundary, %s", async (_label, departedAt, status) => {
      const owner = await member();
      const teamId = await team(owner.id);
      const actor = await member();
      await addTeamMember(teamId, actor.id, "ADMIN", { createdAt: "timestamptz '2026-01-01 00:00:00+00'" });
      await recreatedDepart(actor.id, departedAt);

      expect((await listPasswords(teamId, actor.id)).status).toBe(status);
    });
  });

  // ── C2: locked re-check at the actor-on-others sites ──────────

  describe("C2: the actor-on-others sites re-check the actor under the locks", () => {
    /** The OWNER's team, and an ADMIN actor admitted an hour ago who holds the key. */
    async function actorTeam() {
      const owner = await member();
      const actor = await member();
      const teamId = await team(owner.id);
      await addTeamMember(teamId, actor.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      return { owner, actor, teamId };
    }

    /** Arm the hook; the departure runs after the actor passed getTeamMembership. */
    function departAfterGate(departure: () => Promise<void>) {
      afterGate.hook = departure;
    }

    async function insertSession(userId: string, tenant: string): Promise<string> {
      const token = `sess-${randomUUID()}`;
      await sql(
        `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
        randomUUID(), hashSessionToken(token), userId, tenant,
      );
      return token;
    }

    async function insertExtensionToken(userId: string, tenant: string): Promise<string> {
      const id = randomUUID();
      await sql(
        `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, family_created_at,
           created_at, cnf_jkt)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension:read', now() + interval '1 day', $5::uuid, now(), now(), $6)`,
        id, userId, tenant, (id + id).replace(/-/g, "").slice(0, 64), randomUUID(), "a".repeat(43),
      );
      return id;
    }

    async function authArtifacts(userId: string) {
      const [sessions] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1::uuid`, userId);
      const [tokens] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM extension_tokens WHERE user_id = $1::uuid AND revoked_at IS NULL`, userId,
      );
      return { sessions: sessions.n, liveTokens: tokens.n };
    }

    describe("member DELETE", () => {
      async function removable() {
        const { actor, teamId } = await actorTeam();
        const target = await member();
        const targetRow = await addTeamMember(teamId, target.id, "MEMBER", { createdAt: "now() - interval '1 hour'" });
        await insertSession(target.id, tenantId);
        await insertExtensionToken(target.id, tenantId);
        return { actor, teamId, target, targetRow };
      }

      it.each(seeds)("a departure injected after the gate is refused 403; the target, its keys, sessions and tokens survive: %s", async (_label, depart) => {
        const { actor, teamId, target, targetRow } = await removable();
        stepUp.hook = () => depart(actor.id);

        const res = await removeMember(teamId, targetRow, actor.id);

        expectGatePassed(stepUp);
        expect(res.status).toBe(403);
        expect(await membership(teamId, target.id)).toMatchObject({ deactivated_at: null });
        expect(await keyRows(teamId, target.id)).toBe(1);
        expect(await authArtifacts(target.id)).toEqual({ sessions: 1, liveTokens: 1 });
      });

      it("the same hook without a departure removes the member (positive twin)", async () => {
        const { actor, teamId, target, targetRow } = await removable();
        stepUp.hook = async () => {};

        const res = await removeMember(teamId, targetRow, actor.id);

        expectGatePassed(stepUp);
        expect(res.status).toBe(200);
        expect(await membership(teamId, target.id)).toBeNull();
        expect(await keyRows(teamId, target.id)).toBe(0);
        expect(await authArtifacts(target.id)).toEqual({ sessions: 0, liveTokens: 0 });
      });

      it.each(seeds)("a leftover ADMIN is refused 404 before the transaction, nothing removed: %s", async (_label, depart) => {
        const { actor, teamId, target, targetRow } = await removable();
        await depart(actor.id);
        // Armed: it would fire if the request got past the membership gate.
        stepUp.hook = async () => {};

        const res = await removeMember(teamId, targetRow, actor.id);

        expect(res.status).toBe(404);
        expect(stepUp.fired).toBe(false);
        expect(await membership(teamId, target.id)).toMatchObject({ deactivated_at: null });
        expect(await keyRows(teamId, target.id)).toBe(1);
        expect(await authArtifacts(target.id)).toEqual({ sessions: 1, liveTokens: 1 });
      });
    });

    describe("SCIM reject (single)", () => {
      async function pendingTeam() {
        const { actor, teamId } = await actorTeam();
        const target = await member();
        const targetRow = await addTeamMember(teamId, target.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false });
        return { actor, teamId, target, targetRow };
      }

      it.each(seeds)("a departure injected after the gate is refused 403; the pending row survives: %s", async (_label, depart) => {
        const { actor, teamId, target, targetRow } = await pendingTeam();
        departAfterGate(() => depart(actor.id));

        const res = await rejectMember(teamId, targetRow, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(403);
        expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      });

      it("the same hook without a departure rejects the row (positive twin)", async () => {
        const { actor, teamId, target, targetRow } = await pendingTeam();
        departAfterGate(async () => {});

        const res = await rejectMember(teamId, targetRow, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(200);
        expect(await membership(teamId, target.id)).toBeNull();
      });

      it.each(seeds)("a leftover ADMIN is refused 404 before the transaction: %s", async (_label, depart) => {
        const { actor, teamId, target, targetRow } = await pendingTeam();
        await depart(actor.id);
        // Armed: it would fire if the request got past the membership gate.
        afterGate.hook = async () => {};

        const res = await rejectMember(teamId, targetRow, actor.id);

        expect(res.status).toBe(404);
        expect(afterGate.fired).toBe(false);
        expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      });
    });

    describe("SCIM reject (bulk)", () => {
      async function pendingRows() {
        const { actor, teamId } = await actorTeam();
        const targets = [await member(), await member(), await member()];
        const rows = [];
        for (const t of targets) {
          rows.push(await addTeamMember(teamId, t.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false }));
        }
        return { actor, teamId, targets, rows };
      }

      it.each(seeds)("a departure injected after the gate is refused 403; every pending row survives: %s", async (_label, depart) => {
        const { actor, teamId, targets, rows } = await pendingRows();
        departAfterGate(() => depart(actor.id));

        const res = await bulkReject(teamId, rows, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(403);
        for (const t of targets) {
          expect(await membership(teamId, t.id)).toMatchObject({ scim_approval_pending: true });
        }
      });

      it("the same hook without a departure rejects every row (positive twin)", async () => {
        const { actor, teamId, targets, rows } = await pendingRows();
        departAfterGate(async () => {});

        const res = await bulkReject(teamId, rows, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(200);
        expect((await res.json()).results).toEqual(rows.map((memberId) => ({ memberId, outcome: SCIM_REJECT_OUTCOME.REJECTED })));
        for (const t of targets) expect(await membership(teamId, t.id)).toBeNull();
      });

      it.each(seeds)("a leftover ADMIN is refused 404 before the transaction, every row survives: %s", async (_label, depart) => {
        const { actor, teamId, targets, rows } = await pendingRows();
        await depart(actor.id);
        // Armed: it would fire if the request got past the membership gate.
        afterGate.hook = async () => {};

        const res = await bulkReject(teamId, rows, actor.id);

        expect(res.status).toBe(404);
        expect(afterGate.fired).toBe(false);
        for (const t of targets) {
          expect(await membership(teamId, t.id)).toMatchObject({ scim_approval_pending: true });
        }
      });
    });

    describe("rejectScimPending (lib level)", () => {
      function reject(teamId: string, actor: string, target: { memberId: string; userId: string }) {
        return withTeamTenantRls(teamId, (tenant, tx) =>
          rejectScimPending(tx, tenant, { teamId, actorUserId: actor, ip: null, userAgent: null }, [target]),
        );
      }

      it.each(seeds)("returns null for an actor who left the tenant since admission, rejecting nothing: %s", async (_label, depart) => {
        const { actor, teamId } = await actorTeam();
        const target = await member();
        const memberId = await addTeamMember(teamId, target.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false });
        await depart(actor.id);

        expect(await reject(teamId, actor.id, { memberId, userId: target.id })).toBeNull();

        expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: true });
      });

      it("rejects the pending row for an active actor (positive twin)", async () => {
        const { actor, teamId } = await actorTeam();
        const target = await member();
        const memberId = await addTeamMember(teamId, target.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false });

        const outcomes = await reject(teamId, actor.id, { memberId, userId: target.id });

        expect(outcomes?.get(memberId)).toBe(SCIM_REJECT_OUTCOME.REJECTED);
        expect(await membership(teamId, target.id)).toBeNull();
      });
    });

    describe("invitation cancel", () => {
      async function invited() {
        const { actor, teamId } = await actorTeam();
        const invId = await insertInvitation(teamId, actor.id, `invitee-${hex(4)}@example.test`);
        return { actor, teamId, invId };
      }

      it.each(seeds)("a departure injected after the gate is refused 403; the invitation survives, no audit row: %s", async (_label, depart) => {
        const { actor, teamId, invId } = await invited();
        departAfterGate(() => depart(actor.id));

        const res = await cancelInvitation(teamId, invId, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(403);
        expect(await invitationExists(invId)).toBe(true);
        expect(await cancelAudits(invId)).toEqual([]);
      });

      it("the same hook without a departure cancels and writes one TEAM_MEMBER_INVITE_CANCEL row (positive twin)", async () => {
        const { actor, teamId, invId } = await invited();
        const [{ email }] = await sql<{ email: string }>(`SELECT email FROM team_invitations WHERE id = $1::uuid`, invId);
        departAfterGate(async () => {});

        const res = await cancelInvitation(teamId, invId, actor.id);

        expectGatePassed(afterGate);
        expect(res.status).toBe(200);
        expect(await invitationExists(invId)).toBe(false);
        expect(await cancelAudits(invId)).toEqual([
          expect.objectContaining({
            scope: AUDIT_SCOPE.TEAM,
            userId: actor.id,
            teamId,
            targetType: AUDIT_TARGET_TYPE.TEAM_INVITATION,
            targetId: invId,
            metadata: { email, role: "MEMBER" },
          }),
        ]);
      });

      it.each(seeds)("a leftover ADMIN is refused 404 before the transaction: %s", async (_label, depart) => {
        const { actor, teamId, invId } = await invited();
        await depart(actor.id);
        // Armed: it would fire if the request got past the membership gate.
        afterGate.hook = async () => {};

        const res = await cancelInvitation(teamId, invId, actor.id);

        expect(res.status).toBe(404);
        expect(afterGate.fired).toBe(false);
        expect(await invitationExists(invId)).toBe(true);
      });

      it("an admin of team A cannot cancel team B's invitation, by either URL (IDOR)", async () => {
        const { actor, teamId: teamA } = await actorTeam();
        const ownerB = await member();
        const teamB = await team(ownerB.id);
        const invB = await insertInvitation(teamB, ownerB.id, `invitee-${hex(4)}@example.test`);

        // Team A's URL with B's invitation id: the delete is scoped to the URL's team.
        const viaOwnTeam = await cancelInvitation(teamA, invB, actor.id);
        expect(viaOwnTeam.status).toBe(404);
        expect((await viaOwnTeam.json()).error).toBe("INVITATION_NOT_FOUND");
        // Team B's URL: the actor is no member of B.
        const viaOtherTeam = await cancelInvitation(teamB, invB, actor.id);
        expect(viaOtherTeam.status).toBe(404);

        expect(await invitationExists(invB)).toBe(true);
        expect(await cancelAudits(invB)).toEqual([]);
      });
    });
  });

  // ── C3: consistency readers ───────────────────────────────────

  describe("C3: readers that list teams, recipients or holders drop leftover memberships", () => {
    describe("GET /api/teams and the admin shell", () => {
      async function listedTeamIds(userId: string): Promise<string[]> {
        asUser(userId);
        const res = await listTeamsRoute(getRequest("/api/teams"));
        expect(res.status).toBe(200);
        return ((await res.json()) as { id: string }[]).map((t) => t.id).sort();
      }

      async function adminTeamIds(userId: string): Promise<string[]> {
        return (await getAdminTeamMemberships(userId)).map((m) => m.team.id).sort();
      }

      /** U owns nothing: U is an ADMIN (admitted an hour ago) of one team in the tenant. */
      async function adminOf() {
        const owner = await member();
        const user = await member();
        const teamId = await team(owner.id);
        await addTeamMember(teamId, user.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
        return { user, teamId };
      }

      it.each(seeds)("the leftover's team is omitted from both, per (tenant, user) pair: %s", async (_label, depart) => {
        const { user, teamId: leftoverTeam } = await adminOf();
        // The same user is a guest ADMIN of a team in another tenant.
        const otherOwner = await member(otherTenantId);
        const guestTeam = await team(otherOwner.id, otherTenantId);
        await addTeamMember(guestTeam, user.id, "ADMIN", { tenant: otherTenantId, createdAt: "now() - interval '1 hour'" });
        await depart(user.id);

        expect(await listedTeamIds(user.id)).toEqual([guestTeam]);
        expect(await adminTeamIds(user.id)).toEqual([guestTeam]);
        expect(leftoverTeam).not.toBe(guestTeam);
      });

      it("both teams are listed without the departure (positive twin)", async () => {
        const { user, teamId } = await adminOf();
        const otherOwner = await member(otherTenantId);
        const guestTeam = await team(otherOwner.id, otherTenantId);
        await addTeamMember(guestTeam, user.id, "ADMIN", { tenant: otherTenantId, createdAt: "now() - interval '1 hour'" });

        expect(await listedTeamIds(user.id)).toEqual([teamId, guestTeam].sort());
        expect(await adminTeamIds(user.id)).toEqual([teamId, guestTeam].sort());
      });

      it("a member re-admitted after the departure is listed (pins the admission anchor, not team.createdAt)", async () => {
        const { user, teamId } = await adminOf();
        await residueDepart(user.id);
        await readmit(teamId, user.id);

        expect(await listedTeamIds(user.id)).toEqual([teamId]);
        expect(await adminTeamIds(user.id)).toEqual([teamId]);
      });
    });

    describe("GET /api/teams/pending-key-distributions", () => {
      /**
       * Team 1 (tenant T1) and team 2 (tenant T2), both administered by `admin`;
       * U1 is pending in both (a T1 member, a guest in team 2); U2 is pending in
       * team 2 (a T2 member); U3 is a pending T1 member who never departs.
       */
      async function twoTenants() {
        const admin = await member();
        const u1 = await member();
        const u2 = await member(otherTenantId);
        const u3 = await member();
        for (const u of [u1, u2, u3]) await setEcdhKey(u.id);
        const team1 = await team(admin.id);
        const ownerT2 = await member(otherTenantId);
        const team2 = await team(ownerT2.id, otherTenantId);
        await addTeamMember(team2, admin.id, "ADMIN", { tenant: otherTenantId, createdAt: "now() - interval '1 hour'" });
        const old = { createdAt: "now() - interval '1 hour'", keyDistributed: false, withKey: false } as const;
        await addTeamMember(team1, u1.id, "MEMBER", old);
        await addTeamMember(team1, u3.id, "MEMBER", old);
        await addTeamMember(team2, u1.id, "MEMBER", { ...old, tenant: otherTenantId });
        await addTeamMember(team2, u2.id, "MEMBER", { ...old, tenant: otherTenantId });
        return { admin, u1, u2, u3, team1, team2 };
      }

      async function pending(userId: string): Promise<string[]> {
        asUser(userId);
        // The GET is typed without arguments, but withRequestLog reads the request.
        const res = await (pendingKeyDistributionsRoute as unknown as (req: NextRequest) => Promise<Response>)(
          getRequest("/api/teams/pending-key-distributions"),
        );
        expect(res.status).toBe(200);
        return ((await res.json()) as { teamId: string; userId: string }[]).map((r) => `${r.teamId}:${r.userId}`).sort();
      }

      it.each(seeds)("a leftover recipient is not listed; the same user as a guest elsewhere, and other recipients, are: %s", async (_label, depart) => {
        const { admin, u1, u2, u3, team1, team2 } = await twoTenants();
        await depart(u1.id);

        expect(await pending(admin.id)).toEqual([`${team1}:${u3.id}`, `${team2}:${u1.id}`, `${team2}:${u2.id}`].sort());
      });

      it("every recipient is listed without the departure (positive twin)", async () => {
        const { admin, u1, u2, u3, team1, team2 } = await twoTenants();

        expect(await pending(admin.id)).toEqual(
          [`${team1}:${u1.id}`, `${team1}:${u3.id}`, `${team2}:${u1.id}`, `${team2}:${u2.id}`].sort(),
        );
      });

      it("a re-admitted recipient is listed (pins the admission anchor)", async () => {
        const { admin, u1, u2, u3, team1, team2 } = await twoTenants();
        await residueDepart(u1.id);
        await readmit(team1, u1.id);
        // The re-activation does not touch the key state.
        await sql(`UPDATE team_members SET key_distributed = false WHERE team_id = $1::uuid AND user_id = $2::uuid`, team1, u1.id);

        expect(await pending(admin.id)).toEqual(
          [`${team1}:${u1.id}`, `${team1}:${u3.id}`, `${team2}:${u1.id}`, `${team2}:${u2.id}`].sort(),
        );
      });

      it.each(seeds)("a leftover admin contributes no teams: %s", async (_label, depart) => {
        const { admin, u1, u3, team1 } = await twoTenants();
        const team1Admin = await member();
        await addTeamMember(team1, team1Admin.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
        await depart(team1Admin.id);

        // Only team 1's leftover admin is asked: they administer no other team.
        expect(await pending(team1Admin.id)).toEqual([]);
        // The twin: an active admin of the same team is offered team 1's recipients.
        expect(await pending(admin.id)).toEqual(expect.arrayContaining([`${team1}:${u1.id}`, `${team1}:${u3.id}`]));
      });
    });

    describe("key holders: rekey GET and history restore", () => {
      /**
       * Team at key version 2. The OWNER (active, the actor) holds version 2
       * only. `holder` holds version 1, as an ADMIN admitted two hours ago.
       * One entry (and one history row) is sealed at version 1.
       */
      async function versionOneTeam() {
        const owner = await member();
        const holder = await member();
        const teamId = await team(owner.id, tenantId, 2);
        await sql(`UPDATE team_member_keys SET key_version = 2 WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, owner.id);
        await addTeamMember(teamId, holder.id, "ADMIN", { createdAt: "now() - interval '2 hours'", keyVersion: 1 });
        const entryId = randomUUID();
        await sql(
          `INSERT INTO team_password_entries (
             id, team_id, tenant_id, created_by_id, updated_by_id,
             encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
             aad_version, team_key_version, item_key_version, item_key_team_key_version, entry_type, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $5, $8, $7, 1, 1, 0, 1, 'LOGIN', now(), now())`,
          entryId, teamId, tenantId, owner.id, hex(32), hex(12), hex(16), hex(12),
        );
        const historyId = randomUUID();
        const snapshotIv = hex(12);
        await sql(
          `INSERT INTO team_password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
             aad_version, team_key_version, item_key_version, changed_by_id, changed_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, 1, 0, $7::uuid, now())`,
          historyId, entryId, tenantId, hex(32), snapshotIv, hex(16), owner.id,
        );
        return { owner, holder, teamId, entryId, historyId, snapshotIv };
      }

      async function rekey(teamId: string, actor: string) {
        asUser(actor);
        const res = await rekeyRoute(getRequest(`/api/teams/${teamId}/rekey`), teamParams(teamId));
        expect(res.status).toBe(200);
        return (await res.json()) as {
          stateCounts: Record<string, number>;
          versionHolders: Record<string, VersionHoldersDto>;
          holders: Record<string, unknown[]>;
        };
      }

      function restore(teamId: string, entryId: string, historyId: string, snapshotIv: string, actor: string) {
        asUser(actor);
        return restoreHistoryRoute(
          jsonRequest(`http://localhost/api/teams/${teamId}/passwords/${entryId}/history/${historyId}/restore`, "POST", {
            encryptedBlob: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
            encryptedOverview: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
            snapshotBlobIv: snapshotIv,
          }),
          { params: Promise.resolve({ teamId, id: entryId, historyId }) },
        );
      }

      async function entryState(entryId: string) {
        const [row] = await sql<{ team_key_version: number; encrypted_blob: string; blob_iv: string }>(
          `SELECT team_key_version, encrypted_blob, blob_iv FROM team_password_entries WHERE id = $1::uuid`, entryId,
        );
        const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM team_password_entry_histories WHERE entry_id = $1::uuid`, entryId);
        return { ...row, histories: n };
      }

      it.each(seeds)("rekey GET: a version held only by a leftover is UNRECOVERABLE and warns of a deactivated holder: %s", async (_label, depart) => {
        const { owner, holder, teamId } = await versionOneTeam();
        await depart(holder.id);

        const body = await rekey(teamId, owner.id);

        expect(body.stateCounts).toMatchObject({ unrecoverable: 1, ready: 0, needs_rekeyer_holder: 0 });
        expect(body.versionHolders["1"]).toMatchObject({ activeHolderCount: 0, holders: [], deactivatedHolderCount: 1 });
        expect(body.holders).toEqual({});
        expect(holderInputsFrom(body.versionHolders, "unknown").deactivatedHolder).toBe(true);
      });

      it("rekey GET: a version held by an active member names them as the rekeyer (positive twin)", async () => {
        const { owner, holder, teamId } = await versionOneTeam();

        const body = await rekey(teamId, owner.id);

        expect(body.stateCounts).toMatchObject({ needs_rekeyer_holder: 1, unrecoverable: 0 });
        expect(body.versionHolders["1"]).toMatchObject({ activeHolderCount: 1, deactivatedHolderCount: 0 });
        expect(body.versionHolders["1"].holders).toHaveLength(1);
        expect(body.holders["1"]).toHaveLength(1);
        expect(holderInputsFrom(body.versionHolders, "unknown").deactivatedHolder).toBe(false);
        expect(holder.id).not.toBe(owner.id);
      });

      it("rekey GET: a re-admitted holder still holds the version", async () => {
        const { owner, holder, teamId } = await versionOneTeam();
        await residueDepart(holder.id);
        await readmit(teamId, holder.id);

        const body = await rekey(teamId, owner.id);

        expect(body.versionHolders["1"]).toMatchObject({ activeHolderCount: 1, deactivatedHolderCount: 0 });
      });

      it.each(seeds)("history restore: a version held only by a leftover is refused 409 and the entry is unchanged: %s", async (_label, depart) => {
        const { owner, holder, teamId, entryId, historyId, snapshotIv } = await versionOneTeam();
        await depart(holder.id);
        const before = await entryState(entryId);

        const res = await restore(teamId, entryId, historyId, snapshotIv, owner.id);

        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe("HISTORY_KEY_UNAVAILABLE");
        expect(await entryState(entryId)).toEqual(before);
      });

      it("history restore: a version held by an active member is restored (positive twin)", async () => {
        const { owner, teamId, entryId, historyId, snapshotIv } = await versionOneTeam();
        const before = await entryState(entryId);

        const res = await restore(teamId, entryId, historyId, snapshotIv, owner.id);

        expect(res.status).toBe(200);
        const after = await entryState(entryId);
        expect(after.encrypted_blob).not.toBe(before.encrypted_blob);
        expect(after.histories).toBe(before.histories + 1);
      });
    });
  });

  // ── C4: webhook delivery stops for a leftover creator ─────────

  describe("C4: team webhook delivery requires the creator's current authority", () => {
    let server: http.Server;
    let port: number;
    let received: { body: string }[];

    beforeEach(async () => {
      received = [];
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          received.push({ body });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    });

    it("the chosen event is team-subscribable and not suppressed", () => {
      expect(TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS).toContain(EVENT);
      expect(WEBHOOK_DISPATCH_SUPPRESS.has(EVENT)).toBe(false);
    });

    /** Delivery runs as the real worker role: NOSUPERUSER, NOBYPASSRLS. */
    async function assertWorkerPrincipal() {
      const [p] = await ctx.worker.prisma.$queryRawUnsafe<{ name: string; rolsuper: boolean; rolbypassrls: boolean }[]>(
        `SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(p).toEqual({ name: "passwd_outbox_worker", rolsuper: false, rolbypassrls: false });
    }

    /** POST through the route as `creator`, then point it at the mock receiver (url is not in the AAD). */
    async function routeWebhook(teamId: string, creator: string): Promise<string> {
      asUser(creator);
      const res = await createWebhookRoute(
        jsonRequest(`http://localhost/api/teams/${teamId}/webhooks`, "POST", { url: "https://hooks.example.com/x", events: [EVENT] }),
        teamParams(teamId),
      );
      expect(res.status).toBe(201);
      const { webhook } = (await res.json()) as { webhook: { id: string } };
      await sql(`UPDATE team_webhooks SET url = $2 WHERE id = $1::uuid`, webhook.id, `http://127.0.0.1:${port}/hook`);
      return webhook.id;
    }

    /** One TEAM event for `teamId`, enqueued as the worker's drain would: returns its work item id. */
    async function teamEvent(teamId: string, actor: string): Promise<string> {
      const marker = randomUUID();
      const payload = buildOutboxPayload({
        scope: AUDIT_SCOPE.TEAM, action: EVENT, userId: actor, teamId, metadata: { marker },
      });
      await ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await setBypassRlsGucs(tx);
        await enqueueAuditInTx(tx, tenantId, payload);
      });
      const [row] = await sql<AuditOutboxRow>(
        `SELECT id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at,
                processing_started_at, sent_at, last_error
           FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->'metadata'->>'marker' = $2`,
        tenantId, marker,
      );
      expect((await deliverRowWithChain(ctx.su.prisma, row, payload)).inserted).toBe(true);
      const [item] = await sql<{ id: string }>(
        `SELECT id FROM webhook_deliveries WHERE outbox_id = $1::uuid AND scope = 'TEAM' AND team_id = $2::uuid`, row.id, teamId,
      );
      return item.id;
    }

    async function drain() {
      await assertWorkerPrincipal();
      await processWebhookDeliveryBatch(ctx.worker.prisma, 50);
    }

    async function item(id: string) {
      const [row] = await sql<{ status: string; last_error: string | null; attempt_count: number }>(
        `SELECT status, last_error, attempt_count FROM webhook_deliveries WHERE id = $1::uuid`, id,
      );
      return row;
    }

    async function hook(id: string) {
      const [row] = await sql<{ fail_count: number; is_active: boolean; last_delivered_at: Date | null }>(
        `SELECT fail_count, is_active, last_delivered_at FROM team_webhooks WHERE id = $1::uuid`, id,
      );
      return row;
    }

    /** The GET's computed verdict for one webhook, as the (active) team owner sees it. */
    async function creatorAuthorized(teamId: string, viewer: string, webhookId: string): Promise<boolean | null | undefined> {
      asUser(viewer);
      const res = await listWebhooksRoute(getRequest(`/api/teams/${teamId}/webhooks`), teamParams(teamId));
      expect(res.status).toBe(200);
      const { webhooks } = (await res.json()) as { webhooks: { id: string; creatorAuthorized: boolean | null }[] };
      const found = webhooks.find((w) => w.id === webhookId);
      expect(found).toBeDefined();
      return found?.creatorAuthorized;
    }

    /** The owner and an ADMIN creator admitted an hour ago, whose webhook points at the receiver. */
    async function creatorTeam() {
      const owner = await member();
      const creator = await member();
      const teamId = await team(owner.id);
      await addTeamMember(teamId, creator.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      const webhookId = await routeWebhook(teamId, creator.id);
      return { owner, creator, teamId, webhookId };
    }

    it.each(seeds)("a leftover creator's webhook is skipped: the item is SENT, nothing posted, counters unchanged: %s", async (_label, depart) => {
      const { owner, creator, teamId, webhookId } = await creatorTeam();
      await depart(creator.id);
      const work = await teamEvent(teamId, owner.id);

      await drain();

      expect(received).toEqual([]);
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect(await hook(webhookId)).toMatchObject({ fail_count: 0, is_active: true, last_delivered_at: null });
      expect(await creatorAuthorized(teamId, owner.id, webhookId)).toBe(false);
    });

    it("positive twin: the same webhook without the departure is delivered", async () => {
      const { owner, teamId, webhookId } = await creatorTeam();
      const work = await teamEvent(teamId, owner.id);

      await drain();

      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body)).toMatchObject({ type: EVENT, teamId });
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect((await hook(webhookId)).last_delivered_at).not.toBeNull();
      expect(await creatorAuthorized(teamId, owner.id, webhookId)).toBe(true);
    });

    it.each(seeds)("a guest creator (a member of another tenant) is delivered, although they left their own tenant: %s", async (_label, depart) => {
      const owner = await member();
      const teamId = await team(owner.id);
      const guest = await member(otherTenantId);
      await addTeamMember(teamId, guest.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      const webhookId = await routeWebhook(teamId, guest.id);
      await (depart === residueDepart
        ? residueDepart(guest.id, otherTenantId)
        : recreatedDepart(guest.id, "clock_timestamp()", otherTenantId));
      const work = await teamEvent(teamId, owner.id);

      await drain();

      expect(received).toHaveLength(1);
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect(await creatorAuthorized(teamId, owner.id, webhookId)).toBe(true);
    });

    it("a re-admitted creator (created_at < departure < admitted_at) is delivered", async () => {
      const { owner, creator, teamId, webhookId } = await creatorTeam();
      await residueDepart(creator.id);
      await readmit(teamId, creator.id);
      const work = await teamEvent(teamId, owner.id);

      await drain();

      expect(received).toHaveLength(1);
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect(await creatorAuthorized(teamId, owner.id, webhookId)).toBe(true);
    });
  });
});
