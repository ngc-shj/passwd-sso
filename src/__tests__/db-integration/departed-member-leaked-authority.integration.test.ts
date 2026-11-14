/**
 * Integration test (real DB): after a user departs a tenant, or loses the role
 * that granted it, no team channel keeps acting on their earlier authority
 * (docs/archive/review/departed-member-leaked-authority-plan.md, #1035).
 *
 * - C2: team_members.admitted_at, owned by a same-row trigger.
 * - C4: one actor predicate on the six sites that grant authority to others,
 *   proven on the residue state (an active team row left behind by a raw
 *   tenant-row departure), each deny cell with a positive twin.
 * - C4 recipient: a residue TARGET is treated like a deactivated member by
 *   confirm-key, a promotion or ownership transfer, and key rotation; a
 *   demotion stays allowed.
 * - C5: accept answers ACCEPTED only inside the locked transaction, and audits
 *   the admission atomically with it.
 * - C6: team webhook delivery requires the creator's current authority, run as
 *   the real outbox worker role; plus the creator backfill block.
 *
 * Production routes run on the app role under FORCE RLS; only auth, step-up,
 * rate limits, the SCIM token and the SSRF IP resolution (the mock receiver is
 * on loopback) are mocked. Audit rows are read from audit_outbox: the workers
 * are stopped while this suite runs (CLAUDE.md), so audit_logs would be empty.
 *
 * Run: docker compose stop audit-outbox-worker retention-gc-worker &&
 *      npm run test:integration -- departed-member-leaked-authority
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  appConnectionString,
  assertRlsApplies,
  collectNotices,
  createTestContext,
  gucSentinels,
  readBackfillBlock,
  readGucs,
  setBypassRlsGucs,
  setGucs,
  setTestBypass,
  type TestContext,
} from "./helpers";

const { scimTenant } = vi.hoisted(() => ({ scimTenant: { id: "" } }));
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
// Loopback is blocked by the SSRF guard, and no other local address passes it
// either (webhook-delivery-durable.integration.test.ts header): resolve every
// webhook host to the mock receiver's loopback address, keeping the rest real.
vi.mock("@/lib/http/external-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/external-http")>();
  return { ...actual, resolveAndValidateIps: vi.fn(async () => ["127.0.0.1"]) };
});

import { PATCH as scimPatchUser } from "@/app/api/scim/v2/Users/[id]/route";
import { POST as acceptInvitation } from "@/app/api/teams/invitations/accept/route";
import { POST as issueInvitation } from "@/app/api/teams/[teamId]/invitations/route";
import { POST as addMemberRoute } from "@/app/api/teams/[teamId]/members/route";
import { PUT as changeRoleRoute, DELETE as removeMemberRoute } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { POST as approveRoute } from "@/app/api/teams/[teamId]/members/[memberId]/approve/route";
import { POST as confirmKeyRoute } from "@/app/api/teams/[teamId]/members/[memberId]/confirm-key/route";
import { POST as rotateKeyRoute } from "@/app/api/teams/[teamId]/rotate-key/route";
import { GET as listWebhooksRoute, POST as createWebhookRoute } from "@/app/api/teams/[teamId]/webhooks/route";
import { deliverRowWithChain, processWebhookDeliveryBatch, type AuditOutboxRow } from "@/workers/audit-outbox-worker";
import { enqueueAuditInTx } from "@/lib/audit/audit-outbox";
import { buildOutboxPayload } from "@/lib/audit/audit-payload";
import { createPool } from "@/lib/db/pool-factory";
import { prisma } from "@/lib/prisma";
import {
  ACTOR_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS,
  WEBHOOK_DISPATCH_SUPPRESS,
} from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import { WEBHOOK_AUTO_DISABLE_THRESHOLD } from "@/lib/validations/common.server";
import { encryptServerData, getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import { buildWebhookSecretAAD, WEBHOOK_SECRET_AAD_VERSION_CURRENT } from "@/lib/crypto/webhook-aad";

const hex = (n: number) => randomBytes(n).toString("hex");
const WEBHOOK_CREATOR_DIR = "20261114000300_team_webhook_creator";
/** A team-webhook-subscribable action the dispatcher does not suppress. */
const EVENT = AUDIT_ACTION.ENTRY_CREATE;

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

describe("departed-member leaked authority — real-DB integration", () => {
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
    // SCIM responses build their location from the app origin; CI sets none.
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

  // ── Fixtures (superuser) ──────────────────────────────────────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** The database clock at millisecond precision, the column's own. */
  async function dbNow(): Promise<number> {
    const [row] = await sql<{ t: Date }>(`SELECT clock_timestamp()::timestamptz(3) AS t`);
    return row.t.getTime();
  }

  /** A tenant MEMBER (createUser makes OWNERs, whom a departure never touches). */
  async function member(tenant = tenantId): Promise<{ id: string; email: string }> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, id);
    return { id, email: row.email };
  }

  /** The user is active in another tenant: the state in which a departed user accepts an invitation. */
  async function moveAway(userId: string) {
    await sql(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(), otherTenantId, userId,
    );
  }

  async function setEcdhKey(userId: string) {
    await sql(`UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, userId, hex(32));
  }

  async function seedKey(teamId: string, userId: string, tenant = tenantId) {
    await sql(
      `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv,
         team_key_auth_tag, ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 1, 1, now(), now())`,
      randomUUID(), teamId, tenant, userId, hex(32), hex(12), hex(16), hex(32), hex(32),
    );
  }

  type RowOpts = {
    createdAt?: string;
    keyDistributed?: boolean;
    scimManaged?: boolean;
    deactivated?: boolean;
    pending?: boolean;
    withKey?: boolean;
    tenant?: string;
  };

  /** A team_members row, every field explicit. `createdAt` is SQL. */
  async function addTeamMember(teamId: string, userId: string, role: string, o: RowOpts = {}): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, deactivated_at, scim_managed,
         scim_approval_pending, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", ${o.deactivated || o.pending ? "now()" : "NULL"},
         $6, $7, $8, ${o.createdAt ?? "now()"}, now())`,
      rowId, teamId, userId, o.tenant ?? tenantId, role, o.scimManaged ?? o.pending ?? false, o.pending ?? false,
      o.keyDistributed ?? true,
    );
    if (o.withKey ?? o.keyDistributed ?? true) await seedKey(teamId, userId, o.tenant);
    return rowId;
  }

  async function team(owner: string, tenant = tenantId): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, tenant, `team-${id.slice(0, 8)}`,
    );
    await addTeamMember(id, owner, "OWNER", { tenant, createdAt: "now() - interval '2 hours'" });
    return id;
  }

  async function membership(teamId: string, userId: string) {
    const [row] = await sql<{
      id: string; role: string; deactivated_at: Date | null; admitted_at: Date | null; created_at: Date;
      key_distributed: boolean; scim_approval_pending: boolean;
    }>(
      `SELECT id, role, deactivated_at, admitted_at, created_at, key_distributed, scim_approval_pending
         FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`,
      teamId, userId,
    );
    return row ?? null;
  }

  /**
   * The residue state: the user's tenant row departed by a raw UPDATE that
   * bypasses endTeamMemberships, so their team rows stay active. Exactly one
   * row must change.
   */
  async function residueDepart(userId: string) {
    const changed = await sql(
      `UPDATE tenant_members SET deactivated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid RETURNING 1`,
      tenantId, userId,
    );
    expect(changed).toHaveLength(1);
  }

  /** A PENDING invitation inserted directly (created_at = clock_timestamp()). */
  async function insertInvitation(teamId: string, inviter: string, email: string, role = "MEMBER") {
    const id = randomUUID();
    const token = hex(32);
    await sql(
      `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token, expires_at, invited_by_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"TeamRole", 'PENDING', $6, now() + interval '1 day', $7::uuid, now())`,
      id, teamId, tenantId, email, role, token, inviter,
    );
    return { id, token };
  }

  async function invitationStatus(id: string): Promise<string> {
    const [row] = await sql<{ status: string }>(`SELECT status FROM team_invitations WHERE id = $1::uuid`, id);
    return row.status;
  }

  async function acceptAudits(targetId: string) {
    const rows = await sql<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2 AND payload->>'targetId' = $3`,
      tenantId, AUDIT_ACTION.TEAM_MEMBER_INVITE_ACCEPT, targetId,
    );
    return rows.map((r) => r.payload);
  }

  // ── Entry points ──────────────────────────────────────────────

  function scimActive(userId: string, active: boolean) {
    return scimPatchUser(
      jsonRequest(`http://localhost/api/scim/v2/Users/${userId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  async function invite(teamId: string, inviter: string, email: string, role = "MEMBER") {
    mockAuth.mockResolvedValue({ user: { id: inviter } });
    const res = await issueInvitation(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, "POST", { email, role }),
      { params: Promise.resolve({ teamId }) },
    );
    const body = res.status === 201 ? await res.json() : {};
    return { status: res.status, id: body.id as string | undefined, token: body.token as string | undefined };
  }

  function accept(user: { id: string; email: string }, token: string) {
    mockAuth.mockResolvedValue({ user: { id: user.id, email: user.email } });
    return acceptInvitation(jsonRequest("http://localhost/api/teams/invitations/accept", "POST", { token }));
  }

  function addMember(teamId: string, actor: string, userId: string, role = "MEMBER") {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return addMemberRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members`, "POST", { userId, role }), {
      params: Promise.resolve({ teamId }),
    });
  }

  function approve(teamId: string, memberId: string, actor: string, expectedRole: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return approveRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/approve`, "POST", { expectedRole }),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  function changeRole(teamId: string, memberId: string, actor: string, role: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return changeRoleRoute(jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}`, "PUT", { role }), {
      params: Promise.resolve({ teamId, memberId }),
    });
  }

  function removeMember(teamId: string, memberId: string, actor: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return removeMemberRoute(new NextRequest(`http://localhost/api/teams/${teamId}/members/${memberId}`, { method: "DELETE" }), {
      params: Promise.resolve({ teamId, memberId }),
    });
  }

  function confirmKey(teamId: string, memberId: string, actor: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    return confirmKeyRoute(
      jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberId}/confirm-key`, "POST", keyMaterial(1)),
      { params: Promise.resolve({ teamId, memberId }) },
    );
  }

  // ── C2: admitted_at ───────────────────────────────────────────

  describe("C2: admitted_at is owned by the same-row trigger", () => {
    async function admittedAt(rowId: string): Promise<Date | null> {
      const [row] = await sql<{ admitted_at: Date | null }>(`SELECT admitted_at FROM team_members WHERE id = $1::uuid`, rowId);
      return row.admitted_at;
    }

    async function expectWithin(rowId: string, t0: number, t1: number) {
      const at = await admittedAt(rowId);
      expect(at).not.toBeNull();
      expect(at!.getTime()).toBeGreaterThanOrEqual(t0);
      expect(at!.getTime()).toBeLessThanOrEqual(t1);
    }

    it("an INSERT leaves it NULL, even when a value is supplied", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const user = await member();
      const rowId = randomUUID();
      await sql(
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, admitted_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MEMBER', timestamptz '2000-01-01 00:00:00+00', now(), now())`,
        rowId, teamId, user.id, tenantId,
      );
      expect(await admittedAt(rowId)).toBeNull();
      // The plain fixture insert too.
      expect(await admittedAt(await addTeamMember(teamId, (await member()).id, "MEMBER"))).toBeNull();
    });

    it("accept's upsert re-activating a departed member stamps it within the call", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, leaver.id, "MEMBER", { createdAt: "now() - interval '1 hour'" });
      expect((await scimActive(leaver.id, false)).status).toBe(200);
      await moveAway(leaver.id);
      const inv = await invite(teamId, owner, leaver.email);
      expect(inv.status).toBe(201);

      const t0 = await dbNow();
      expect((await accept(leaver, inv.token!)).status).toBe(200);
      const t1 = await dbNow();

      await expectWithin(rowId, t0, t1);
    });

    it("members POST re-activating a deactivated row stamps it within the call", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "MEMBER", { deactivated: true });

      const t0 = await dbNow();
      expect((await addMember(teamId, owner, user.id)).status).toBe(201);
      const t1 = await dbNow();

      await expectWithin(rowId, t0, t1);
    });

    it("approve's CAS admitting a SCIM-pending row stamps it within the call", async () => {
      const owner = await ctx.createUser(tenantId);
      const target = await member();
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, target.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false });

      const t0 = await dbNow();
      expect((await approve(teamId, rowId, owner, "MEMBER")).status).toBe(200);
      const t1 = await dbNow();

      await expectWithin(rowId, t0, t1);
    });

    it("returnToTenant (SCIM active=true) re-activating a departed row stamps it within the call", async () => {
      const owner = await ctx.createUser(tenantId);
      const user = await member();
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, user.id, "MEMBER");
      expect((await scimActive(user.id, false)).status).toBe(200);
      expect(await admittedAt(rowId)).toBeNull();

      const t0 = await dbNow();
      expect((await scimActive(user.id, true)).status).toBe(200);
      const t1 = await dbNow();

      await expectWithin(rowId, t0, t1);
    });

    it("is the statement's clock_timestamp(), not the transaction's now()", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, (await member()).id, "MEMBER", { deactivated: true });
      const client = await ctx.su.pool.connect();
      try {
        await client.query("BEGIN");
        await setTestBypass(client, ["team_members"]);
        const { rows: [{ start }] } = await client.query<{ start: Date }>(`SELECT now() AS start`);
        await client.query(`SELECT pg_sleep(0.3)`);
        await client.query(`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [rowId]);
        const { rows: [{ admitted_at }] } = await client.query<{ admitted_at: Date }>(
          `SELECT admitted_at FROM team_members WHERE id = $1::uuid`, [rowId],
        );
        expect(admitted_at.getTime() - start.getTime()).toBeGreaterThanOrEqual(250);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });

    it("a re-activating UPDATE that supplies a value is overridden", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, (await member()).id, "MEMBER", { deactivated: true });
      const t0 = await dbNow();
      await sql(
        `UPDATE team_members SET deactivated_at = NULL, admitted_at = timestamptz '2000-01-01 00:00:00+00' WHERE id = $1::uuid`,
        rowId,
      );
      const t1 = await dbNow();
      await expectWithin(rowId, t0, t1);
    });

    it("on an active row: re-clearing deactivated_at, a role or key update, and a direct SET leave it unchanged; a deactivation keeps it", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const rowId = await addTeamMember(teamId, (await member()).id, "MEMBER", { deactivated: true });
      await sql(`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, rowId);
      const stamped = await admittedAt(rowId);
      expect(stamped).not.toBeNull();

      for (const update of [
        `deactivated_at = NULL`,
        `role = 'ADMIN'`,
        `key_distributed = false`,
        `admitted_at = timestamptz '2000-01-01 00:00:00+00'`,
        `admitted_at = NULL`,
        `deactivated_at = now()`,
      ]) {
        await sql(`UPDATE team_members SET ${update} WHERE id = $1::uuid`, rowId);
        expect((await admittedAt(rowId))?.getTime(), update).toBe(stamped!.getTime());
      }

      // A never re-activated row: a direct SET does not invent one either.
      const fresh = await addTeamMember(teamId, (await member()).id, "MEMBER");
      await sql(`UPDATE team_members SET admitted_at = timestamptz '2000-01-01 00:00:00+00' WHERE id = $1::uuid`, fresh);
      expect(await admittedAt(fresh)).toBeNull();
    });
  });

  // ── C4: the actor predicate, per site, on the residue state ───

  describe("C4: an actor whose tenant row departed after their admission grants nothing", () => {
    /** The owner, and an actor admitted an hour ago with `role`, holding the key. */
    async function actorTeam(role: "ADMIN" | "OWNER") {
      const owner = await ctx.createUser(tenantId);
      const actor = await member();
      const teamId = await team(owner);
      const actorRow = await addTeamMember(teamId, actor.id, role, { createdAt: "now() - interval '1 hour'", keyDistributed: true });
      return { owner, actor, teamId, actorRow };
    }

    const twins = [
      ["denied when the actor's tenant row departed after admission (residue)", true],
      ["allowed without the departure (positive twin)", false],
    ] as const;

    it.each(twins)("invitations POST: %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const invitee = await member();

      const res = await invite(teamId, actor.id, invitee.email);

      expect(res.status).toBe(departed ? 403 : 201);
      const rows = await sql(`SELECT 1 FROM team_invitations WHERE team_id = $1::uuid AND email = $2`, teamId, invitee.email);
      expect(rows).toHaveLength(departed ? 0 : 1);
    });

    it.each(twins)("accept (inviter, invitation issued after the departure): %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const invitee = await member();
      const inv = await insertInvitation(teamId, actor.id, invitee.email);

      const res = await accept(invitee, inv.token);

      if (departed) {
        expect(res.status).toBe(410);
        expect((await res.json()).error).toBe("INVITATION_EXPIRED");
        expect(await invitationStatus(inv.id)).toBe("EXPIRED");
        expect(await membership(teamId, invitee.id)).toBeNull();
      } else {
        expect(res.status).toBe(200);
        expect(await invitationStatus(inv.id)).toBe("ACCEPTED");
        expect(await membership(teamId, invitee.id)).toMatchObject({ deactivated_at: null });
      }
    });

    it.each(twins)("members POST: %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const target = await member();

      const res = await addMember(teamId, actor.id, target.id);

      expect(res.status).toBe(departed ? 403 : 201);
      expect(await membership(teamId, target.id)).toEqual(departed ? null : expect.objectContaining({ deactivated_at: null }));
    });

    it.each(twins)("SCIM approve (approver holds the key): %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const target = await member();
      const rowId = await addTeamMember(teamId, target.id, "MEMBER", { pending: true, keyDistributed: false, withKey: false });

      const res = await approve(teamId, rowId, actor.id, "MEMBER");

      expect(res.status).toBe(departed ? 403 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ scim_approval_pending: departed });
    });

    it.each(twins)("member PUT role change: %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const target = await member();
      const rowId = await addTeamMember(teamId, target.id, "MEMBER");

      const res = await changeRole(teamId, rowId, actor.id, "VIEWER");

      expect(res.status).toBe(departed ? 403 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: departed ? "MEMBER" : "VIEWER" });
    });

    it.each(twins)("member PUT ownership transfer (actor is the OWNER): %s", async (_label, departed) => {
      const actor = await member();
      const teamId = randomUUID();
      await sql(
        `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
        teamId, tenantId, `team-${teamId.slice(0, 8)}`,
      );
      await addTeamMember(teamId, actor.id, "OWNER", { createdAt: "now() - interval '1 hour'" });
      if (departed) await residueDepart(actor.id);
      const successor = await member();
      const rowId = await addTeamMember(teamId, successor.id, "ADMIN");

      const res = await changeRole(teamId, rowId, actor.id, "OWNER");

      expect(res.status).toBe(departed ? 403 : 200);
      expect(await membership(teamId, successor.id)).toMatchObject({ role: departed ? "ADMIN" : "OWNER" });
      expect(await membership(teamId, actor.id)).toMatchObject({ role: departed ? "OWNER" : "ADMIN" });
    });

    it.each(twins)("confirm-key: %s", async (_label, departed) => {
      const { actor, teamId } = await actorTeam("ADMIN");
      if (departed) await residueDepart(actor.id);
      const target = await member();
      await setEcdhKey(target.id);
      const rowId = await addTeamMember(teamId, target.id, "MEMBER", { keyDistributed: false, withKey: false });

      const res = await confirmKey(teamId, rowId, actor.id);

      expect(res.status).toBe(departed ? 403 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ key_distributed: !departed });
    });

    it("a member re-admitted by accept after a SCIM departure (created_at < departure < admitted_at) invites successfully", async () => {
      const owner = await ctx.createUser(tenantId);
      const actor = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, actor.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      expect((await scimActive(actor.id, false)).status).toBe(200);
      await moveAway(actor.id);
      const inv = await invite(teamId, owner, actor.email, "ADMIN");
      expect(inv.status).toBe(201);
      expect((await accept(actor, inv.token!)).status).toBe(200);

      // The state the COALESCE must read: still departed, created before, admitted after.
      const row = await membership(teamId, actor.id);
      const [tenantRow] = await sql<{ deactivated_at: Date | null }>(
        `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantId, actor.id,
      );
      expect(tenantRow.deactivated_at).not.toBeNull();
      expect(row!.created_at.getTime()).toBeLessThan(tenantRow.deactivated_at!.getTime());
      expect(row!.admitted_at!.getTime()).toBeGreaterThan(tenantRow.deactivated_at!.getTime());

      const invitee = await member();
      expect((await invite(teamId, actor.id, invitee.email)).status).toBe(201);
    });
  });

  // ── C4 recipient: the target predicate, per site, on the residue state ───

  describe("C4 recipient: a target whose tenant row departed after their admission receives nothing", () => {
    /** The OWNER's team, and a target admitted an hour ago with `role`. */
    async function targetTeam(role: string, o: RowOpts = {}) {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const target = await member();
      const targetRow = await addTeamMember(teamId, target.id, role, { createdAt: "now() - interval '1 hour'", ...o });
      return { owner, teamId, target, targetRow };
    }

    const twins = [
      ["denied when the target's tenant row departed after admission (residue)", true],
      ["allowed without the departure (positive twin)", false],
    ] as const;

    it.each(twins)("confirm-key to the target: %s", async (_label, departed) => {
      const { owner, teamId, target, targetRow } = await targetTeam("MEMBER", { keyDistributed: false, withKey: false });
      await setEcdhKey(target.id);
      if (departed) await residueDepart(target.id);

      const res = await confirmKey(teamId, targetRow, owner);

      expect(res.status).toBe(departed ? 404 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ key_distributed: !departed });
      const keys = await sql(`SELECT 1 FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, target.id);
      expect(keys).toHaveLength(departed ? 0 : 1);
    });

    it.each(twins)("member PUT promotion of the target (MEMBER to ADMIN): %s", async (_label, departed) => {
      const { owner, teamId, target, targetRow } = await targetTeam("MEMBER");
      if (departed) await residueDepart(target.id);

      const res = await changeRole(teamId, targetRow, owner, "ADMIN");

      expect(res.status).toBe(departed ? 404 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: departed ? "MEMBER" : "ADMIN" });
    });

    it.each(twins)("member PUT ownership transfer to the target: %s", async (_label, departed) => {
      const { owner, teamId, target, targetRow } = await targetTeam("ADMIN");
      if (departed) await residueDepart(target.id);

      const res = await changeRole(teamId, targetRow, owner, "OWNER");

      expect(res.status).toBe(departed ? 404 : 200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: departed ? "ADMIN" : "OWNER" });
      expect(await membership(teamId, owner)).toMatchObject({ role: departed ? "OWNER" : "ADMIN" });
    });

    it.each([
      ["allowed although the target's tenant row departed after admission (residue)", true],
      ["allowed without the departure (positive twin)", false],
    ] as const)("member PUT demotion of the target (ADMIN to VIEWER): %s", async (_label, departed) => {
      const { owner, teamId, target, targetRow } = await targetTeam("ADMIN");
      if (departed) await residueDepart(target.id);

      const res = await changeRole(teamId, targetRow, owner, "VIEWER");

      expect(res.status).toBe(200);
      expect(await membership(teamId, target.id)).toMatchObject({ role: "VIEWER" });
    });

    describe("rotate-key with the target as a key-holder", () => {
      function rotate(teamId: string, actor: string, keysFor: string[]) {
        mockAuth.mockResolvedValue({ user: { id: actor } });
        return rotateKeyRoute(
          jsonRequest(`http://localhost/api/teams/${teamId}/rotate-key`, "POST", {
            newTeamKeyVersion: 2,
            entries: [],
            memberKeys: keysFor.map((userId) => ({ userId, ...keyMaterial(2) })),
          }),
          { params: Promise.resolve({ teamId }) },
        );
      }
      async function teamKeyVersion(teamId: string): Promise<number> {
        const [row] = await sql<{ team_key_version: number }>(`SELECT team_key_version FROM teams WHERE id = $1::uuid`, teamId);
        return row.team_key_version;
      }
      async function v2Key(teamId: string, userId: string) {
        return sql(`SELECT 1 FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid AND key_version = 2`, teamId, userId);
      }

      it.each(twins)("rotates without the target's key and lists them for distribution: %s", async (_label, departed) => {
        const { owner, teamId, target } = await targetTeam("MEMBER", { keyDistributed: true });
        if (departed) await residueDepart(target.id);

        // Without the departure the target is a key-holder and must be wrapped for.
        const res = await rotate(teamId, owner, departed ? [owner] : [owner, target.id]);

        expect(res.status).toBe(200);
        expect(await teamKeyVersion(teamId)).toBe(2);
        expect(await membership(teamId, target.id)).toMatchObject({ key_distributed: !departed, deactivated_at: null });
        expect(await v2Key(teamId, target.id)).toHaveLength(departed ? 0 : 1);
        expect(await v2Key(teamId, owner)).toHaveLength(1);
      });

      it.each(twins)("a key supplied for the target: %s", async (_label, departed) => {
        const { owner, teamId, target } = await targetTeam("MEMBER", { keyDistributed: true });
        if (departed) await residueDepart(target.id);

        const res = await rotate(teamId, owner, [owner, target.id]);

        // Refused as for a non-member, rotating nothing.
        expect(res.status).toBe(departed ? 400 : 200);
        if (departed) expect((await res.json()).details).toMatchObject({ unknownUserId: target.id });
        expect(await teamKeyVersion(teamId)).toBe(departed ? 1 : 2);
        expect(await membership(teamId, target.id)).toMatchObject({ key_distributed: true });
      });
    });
  });

  // ── C5: accept ────────────────────────────────────────────────

  describe("C5: accept answers ACCEPTED only after the locked admission checks, and audits the admission", () => {
    it.each([
      ["plain", false, false],
      ["SCIM-managed", true, false],
      ["plain", false, true],
      ["SCIM-managed", true, true],
    ] as const)("an already-active %s member, inviter departed=%s", async (_kind, scimManaged, inviterDeparted) => {
      const owner = await ctx.createUser(tenantId);
      const inviter = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, inviter.id, "ADMIN", { createdAt: "now() - interval '1 hour'" });
      if (inviterDeparted) await residueDepart(inviter.id);
      const invitee = await member();
      await addTeamMember(teamId, invitee.id, "MEMBER", { scimManaged });
      const inv = await insertInvitation(teamId, inviter.id, invitee.email);

      const res = await accept(invitee, inv.token);

      const body = await res.json();
      if (inviterDeparted) {
        expect(res.status).toBe(410);
        expect(body.error).toBe("INVITATION_EXPIRED");
        expect(await invitationStatus(inv.id)).toBe("EXPIRED");
      } else {
        expect(res.status).toBe(200);
        expect(body.alreadyMember).toBe(true);
        expect(await invitationStatus(inv.id)).toBe("ACCEPTED");
      }
      // ALREADY_MEMBER (and a refusal) admit nobody, so write no admission record.
      expect(await acceptAudits(invitee.id)).toEqual([]);
      expect(await membership(teamId, invitee.id)).toMatchObject({ deactivated_at: null, key_distributed: true });
    });

    it("a created membership writes one TEAM_MEMBER_INVITE_ACCEPT row with readmitted false", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const invitee = await member();
      const inv = await invite(teamId, owner, invitee.email);

      expect((await accept(invitee, inv.token!)).status).toBe(200);

      expect(await acceptAudits(invitee.id)).toEqual([
        expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          userId: invitee.id,
          actorType: ACTOR_TYPE.HUMAN,
          teamId,
          targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
          targetId: invitee.id,
          metadata: { invitationId: inv.id, role: "MEMBER", readmitted: false },
        }),
      ]);
    });

    it("a re-activated membership writes one row with readmitted true", async () => {
      const owner = await ctx.createUser(tenantId);
      const leaver = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, leaver.id, "MEMBER");
      expect((await scimActive(leaver.id, false)).status).toBe(200);
      await moveAway(leaver.id);
      const inv = await invite(teamId, owner, leaver.email, "ADMIN");

      expect((await accept(leaver, inv.token!)).status).toBe(200);

      const audits = await acceptAudits(leaver.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({ invitationId: inv.id, role: "ADMIN", readmitted: true });
    });

    it("an admission that rolls back (key cleanup raises) leaves no audit row and no membership change", async () => {
      const owner = await ctx.createUser(tenantId);
      const invitee = await member();
      const teamId = await team(owner);
      await addTeamMember(teamId, invitee.id, "MEMBER", { deactivated: true, withKey: true });
      const inv = await insertInvitation(teamId, owner, invitee.email);
      const before = await membership(teamId, invitee.id);

      // Fixed name: check-bypass-rls allowlists exactly this routine in this file.
      const fn = "c5_accept_rollback_probe";
      const trigger = `${fn}_trg`;
      await sql(`DROP FUNCTION IF EXISTS public.${fn}() CASCADE`);
      await sql(`CREATE FUNCTION c5_accept_rollback_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'c5 rollback probe'; END $$`);
      try {
        await sql(
          `CREATE TRIGGER ${trigger} BEFORE DELETE ON team_member_keys FOR EACH ROW
             WHEN (OLD.user_id = '${invitee.id}'::uuid) EXECUTE FUNCTION public.${fn}()`,
        );
        const outcome = await accept(invitee, inv.token).then((r) => r.status, (e: unknown) => e);
        expect(outcome === 500 || outcome instanceof Error).toBe(true);
      } finally {
        await sql(`DROP TRIGGER IF EXISTS ${trigger} ON team_member_keys`);
        await sql(`DROP FUNCTION IF EXISTS public.${fn}()`);
      }

      expect(await acceptAudits(invitee.id)).toEqual([]);
      expect(await membership(teamId, invitee.id)).toEqual(before);
      expect(await invitationStatus(inv.id)).toBe("PENDING");
      const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM team_member_keys WHERE team_id = $1::uuid AND user_id = $2::uuid`, teamId, invitee.id);
      expect(n).toBe(1);
    });
  });

  // ── C6: webhook delivery requires the creator's authority ─────

  describe("C6: team webhook delivery", () => {
    type Received = { body: string };
    let server: http.Server;
    let port: number;
    let received: Received[];
    let respondWith: number;

    beforeEach(async () => {
      received = [];
      respondWith = 200;
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          received.push({ body });
          res.writeHead(respondWith, { "Content-Type": "application/json" });
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

    /** POST through the route as `actor`, then point it at the mock receiver (url is not in the AAD). */
    async function routeWebhook(teamId: string, actor: string): Promise<string> {
      mockAuth.mockResolvedValue({ user: { id: actor } });
      const res = await createWebhookRoute(
        jsonRequest(`http://localhost/api/teams/${teamId}/webhooks`, "POST", { url: "https://hooks.example.com/x", events: [EVENT] }),
        { params: Promise.resolve({ teamId }) },
      );
      expect(res.status).toBe(201);
      const { webhook } = (await res.json()) as { webhook: { id: string } };
      await sql(`UPDATE team_webhooks SET url = $2 WHERE id = $1::uuid`, webhook.id, `http://127.0.0.1:${port}/hook`);
      return webhook.id;
    }

    /** A legacy webhook (created_by_id NULL), seeded by INSERT as before the column existed. */
    async function legacyWebhook(teamId: string): Promise<string> {
      const id = randomUUID();
      const masterKeyVersion = 1;
      const aad = buildWebhookSecretAAD({
        tableName: "TeamWebhook", version: WEBHOOK_SECRET_AAD_VERSION_CURRENT, webhookId: id, tenantId, teamId,
      });
      const enc = encryptServerData(hex(32), getMasterKeyByVersion(masterKeyVersion), aad);
      await sql(
        `INSERT INTO team_webhooks (id, team_id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag,
           master_key_version, secret_aad_version, events, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::text[], true, now(), now())`,
        id, teamId, tenantId, `http://127.0.0.1:${port}/hook`, enc.ciphertext, enc.iv, enc.authTag,
        masterKeyVersion, WEBHOOK_SECRET_AAD_VERSION_CURRENT, [EVENT],
      );
      return id;
    }

    /** Each work item's event marker, to tell which event a POST carried. */
    const markerOf = new Map<string, string>();

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
      markerOf.set(item.id, marker);
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
      const [row] = await sql<{ fail_count: number; is_active: boolean; last_delivered_at: Date | null; created_by_id: string | null }>(
        `SELECT fail_count, is_active, last_delivered_at, created_by_id FROM team_webhooks WHERE id = $1::uuid`, id,
      );
      return row;
    }

    /** The GET's computed verdict for one webhook, as the team owner sees it. */
    async function creatorAuthorized(teamId: string, viewer: string, webhookId: string): Promise<boolean | null | undefined> {
      mockAuth.mockResolvedValue({ user: { id: viewer } });
      const res = await listWebhooksRoute(new NextRequest(`http://localhost/api/teams/${teamId}/webhooks`), {
        params: Promise.resolve({ teamId }),
      });
      expect(res.status).toBe(200);
      const { webhooks } = (await res.json()) as { webhooks: { id: string; creatorAuthorized: boolean | null; createdById?: string }[] };
      const found = webhooks.find((w) => w.id === webhookId);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("createdById");
      return found?.creatorAuthorized;
    }

    /** The owner, and a team ADMIN creator. */
    async function creatorTeam() {
      const owner = await ctx.createUser(tenantId);
      const creator = await member();
      const teamId = await team(owner);
      const creatorRow = await addTeamMember(teamId, creator.id, "ADMIN");
      return { owner, creator, teamId, creatorRow };
    }

    it("a route-created webhook stores the session user as its creator", async () => {
      const { owner, creator, teamId } = await creatorTeam();
      const id = await routeWebhook(teamId, creator.id);
      expect((await hook(id)).created_by_id).toBe(creator.id);
      expect(await creatorAuthorized(teamId, owner, id)).toBe(true);
    });

    it("positive twin: an ADMIN creator's webhook is delivered (grant, select and bypass all in place)", async () => {
      const { owner, creator, teamId } = await creatorTeam();
      const id = await routeWebhook(teamId, creator.id);
      const work = await teamEvent(teamId, owner);

      await drain();

      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body)).toMatchObject({ type: EVENT, teamId });
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect((await hook(id)).last_delivered_at).not.toBeNull();
      expect(await creatorAuthorized(teamId, owner, id)).toBe(true);
    });

    it.each([
      ["removed by member DELETE", "delete"],
      ["departed the tenant (SCIM active=false)", "depart"],
      ["demoted to MEMBER", "demote"],
    ] as const)("skipped once the creator was %s: SENT, no error, no attempt or failure counted; a pre-queued item too", async (_label, how) => {
      const { owner, creator, teamId, creatorRow } = await creatorTeam();
      const id = await routeWebhook(teamId, creator.id);
      const preQueued = await teamEvent(teamId, owner);

      if (how === "delete") expect((await removeMember(teamId, creatorRow, owner)).status).toBe(200);
      if (how === "depart") expect((await scimActive(creator.id, false)).status).toBe(200);
      if (how === "demote") expect((await changeRole(teamId, creatorRow, owner, "MEMBER")).status).toBe(200);
      const after = await teamEvent(teamId, owner);

      await drain();

      expect(received).toEqual([]);
      for (const work of [preQueued, after]) {
        expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      }
      expect(await hook(id)).toMatchObject({ fail_count: 0, is_active: true, last_delivered_at: null });
      expect(await creatorAuthorized(teamId, owner, id)).toBe(false);
    });

    it("cross-team: removed from team X, still ADMIN of team Y — X is skipped, Y is delivered", async () => {
      const { owner, creator, teamId: x, creatorRow } = await creatorTeam();
      const y = await team(owner);
      await addTeamMember(y, creator.id, "ADMIN");
      const hookX = await routeWebhook(x, creator.id);
      const hookY = await routeWebhook(y, creator.id);
      expect((await removeMember(x, creatorRow, owner)).status).toBe(200);
      const workX = await teamEvent(x, owner);
      const workY = await teamEvent(y, owner);

      await drain();

      expect(received.map((r) => JSON.parse(r.body).teamId)).toEqual([y]);
      expect(await item(workX)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect(await item(workY)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect(await creatorAuthorized(x, owner, hookX)).toBe(false);
      expect(await creatorAuthorized(y, owner, hookY)).toBe(true);
    });

    it("resume: after the creator's return a new event is delivered; the skipped one is not redelivered", async () => {
      const { owner, creator, teamId } = await creatorTeam();
      const id = await routeWebhook(teamId, creator.id);
      expect((await scimActive(creator.id, false)).status).toBe(200);
      const skipped = await teamEvent(teamId, owner);
      await drain();
      expect(received).toEqual([]);
      expect(await creatorAuthorized(teamId, owner, id)).toBe(false);

      expect((await scimActive(creator.id, true)).status).toBe(200);
      const resumed = await teamEvent(teamId, owner);
      await drain();
      await drain();

      expect(received).toHaveLength(1);
      // The one POST is the resumed event, not the skipped one redelivered.
      expect(received[0].body).toContain(markerOf.get(resumed));
      expect(received[0].body).not.toContain(markerOf.get(skipped));
      expect(await item(skipped)).toMatchObject({ status: "SENT" });
      expect(await item(resumed)).toMatchObject({ status: "SENT" });
      expect(await creatorAuthorized(teamId, owner, id)).toBe(true);
    });

    it("a legacy NULL-creator webhook is delivered once and its health update commits", async () => {
      const { owner, teamId } = await creatorTeam();
      const id = await legacyWebhook(teamId);
      expect((await hook(id)).created_by_id).toBeNull();
      const work = await teamEvent(teamId, owner);

      await drain();

      expect(received).toHaveLength(1);
      expect(await item(work)).toEqual({ status: "SENT", last_error: null, attempt_count: 0 });
      expect((await hook(id)).last_delivered_at).not.toBeNull();
      expect(await creatorAuthorized(teamId, owner, id)).toBeNull();
    });

    it("a failing legacy webhook counts the failure and auto-disables at the threshold", async () => {
      const { owner, teamId } = await creatorTeam();
      const id = await legacyWebhook(teamId);
      await sql(`UPDATE team_webhooks SET fail_count = $2 WHERE id = $1::uuid`, id, WEBHOOK_AUTO_DISABLE_THRESHOLD - 1);
      respondWith = 500;
      await teamEvent(teamId, owner);

      await drain();

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(await hook(id)).toMatchObject({ fail_count: WEBHOOK_AUTO_DISABLE_THRESHOLD, is_active: false, created_by_id: null });
    }, 30_000);

    // ── backfill ───────────────────────────────────────────────

    it("backfill: as the NOBYPASSRLS app role, the latest audit row wins, other team/tenant rows are ignored, the outbox fallback works, non-NULL is untouched, a second run is a no-op", async () => {
      const owner = await ctx.createUser(tenantId);
      const teamId = await team(owner);
      const otherTeam = await team(owner);
      const [older, newer, outboxActor, kept, stranger] = await Promise.all([member(), member(), member(), member(), member()]);
      const insertHook = async (team: string, createdBy: string | null) => {
        const id = randomUUID();
        await sql(
          `INSERT INTO team_webhooks (id, team_id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag, events,
             is_active, created_by_id, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'https://example.invalid/hook', $4, $5, $6, ARRAY[]::text[], true, $7::uuid, now(), now())`,
          id, team, tenantId, hex(16), hex(12), hex(16), createdBy,
        );
        return id;
      };
      const auditCreate = (o: { tenant: string; team: string; webhookId: string; user: string; at: string }) =>
        sql(
          `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, team_id, metadata, outbox_id, created_at)
           VALUES ($1::uuid, $2::uuid, 'TEAM', 'WEBHOOK_CREATE', $3::uuid, 'HUMAN', $4::uuid, $5::jsonb, $6::uuid, ${o.at})`,
          randomUUID(), o.tenant, o.user, o.team, JSON.stringify({ webhookId: o.webhookId }), randomUUID(),
        );

      const latestWins = await insertHook(teamId, null);
      await auditCreate({ tenant: tenantId, team: teamId, webhookId: latestWins, user: older.id, at: "now() - interval '2 minutes'" });
      await auditCreate({ tenant: tenantId, team: teamId, webhookId: latestWins, user: newer.id, at: "now() - interval '1 minute'" });
      const otherTeamOnly = await insertHook(teamId, null);
      await auditCreate({ tenant: tenantId, team: otherTeam, webhookId: otherTeamOnly, user: stranger.id, at: "now()" });
      const otherTenantOnly = await insertHook(teamId, null);
      await auditCreate({ tenant: otherTenantId, team: teamId, webhookId: otherTenantOnly, user: stranger.id, at: "now()" });
      const fromOutbox = await insertHook(teamId, null);
      await ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await setBypassRlsGucs(tx);
        await enqueueAuditInTx(tx, tenantId, buildOutboxPayload({
          scope: AUDIT_SCOPE.TEAM, action: AUDIT_ACTION.WEBHOOK_CREATE, userId: outboxActor.id, teamId,
          metadata: { webhookId: fromOutbox, url: "https://example.invalid/***" },
        }));
      });
      const nonNull = await insertHook(teamId, kept.id);
      await auditCreate({ tenant: tenantId, team: teamId, webhookId: nonNull, user: stranger.id, at: "now()" });
      const all = [latestWins, otherTeamOnly, otherTenantOnly, fromOutbox, nonNull];
      const expected = {
        [latestWins]: newer.id, [otherTeamOnly]: null, [otherTenantOnly]: null, [fromOutbox]: outboxActor.id, [nonNull]: kept.id,
      };

      const block = readBackfillBlock(WEBHOOK_CREATOR_DIR, "team-webhook-creator");
      const pool = createPool({ connectionString: appConnectionString(), max: 1 });
      try {
        const client = await pool.connect();
        try {
          const [principal] = (await client.query<{ bypass: boolean; superuser: boolean }>(
            `SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
          )).rows;
          expect(principal).toEqual({ bypass: false, superuser: false });
          await client.query("BEGIN");
          try {
            const sentinels = gucSentinels();
            await setGucs(client, sentinels);
            // The subject: without the block's own bypass the rows are invisible to this role.
            expect((await client.query(`SELECT id FROM team_webhooks WHERE id = ANY($1::uuid[])`, [all])).rows).toEqual([]);

            const read = async () => {
              await setTestBypass(client, ["team_webhooks"]);
              const rows = (await client.query<{ id: string; created_by_id: string | null }>(
                `SELECT id, created_by_id FROM team_webhooks WHERE id = ANY($1::uuid[])`, [all],
              )).rows;
              await setGucs(client, sentinels);
              return Object.fromEntries(rows.map((r) => [r.id, r.created_by_id]));
            };

            const first = collectNotices(client);
            await client.query(block);
            first.stop();
            expect(await readGucs(client)).toEqual(sentinels);
            expect(first.messages.some((m) => m.startsWith("team-webhook-creator backfill:"))).toBe(true);
            expect(await read()).toEqual(expected);

            const second = collectNotices(client);
            await client.query(block);
            second.stop();
            expect(second.messages).toContain(
              "team-webhook-creator backfill: 0 webhook(s) attributed from audit_logs, 0 from audit_outbox",
            );
            expect(await readGucs(client)).toEqual(sentinels);
            expect(await read()).toEqual(expected);
          } finally {
            await client.query("ROLLBACK");
          }
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }

      // Nothing committed.
      const after = await sql<{ id: string; created_by_id: string | null }>(
        `SELECT id, created_by_id FROM team_webhooks WHERE id = ANY($1::uuid[])`, all,
      );
      expect(Object.fromEntries(after.map((r) => [r.id, r.created_by_id]))).toEqual({
        [latestWins]: null, [otherTeamOnly]: null, [otherTenantOnly]: null, [fromOutbox]: null, [nonNull]: kept.id,
      });
    });
  });
});
