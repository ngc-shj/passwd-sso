/**
 * Integration test (real DB): a team-entry share link stops serving once its
 * creator no longer holds the membership of the entry's team they held when
 * they created it, or the entry is trashed or gone
 * (docs/archive/review/departed-member-share-links-plan.md, #990); while the
 * team's policy disallows sharing or requires a share password the link lacks
 * (#996); and a personal entry share while its entry is trashed or gone (#998).
 *
 * Production routes, the share page and share_creator_admitted run on the app
 * role under FORCE RLS; only auth, step-up, rate limits, the SCIM token and
 * next/headers are mocked, plus two per-cell toggles (a stale permission check
 * for A7, a forced pre-check for A12) that pass through by default.
 *
 * Run: docker compose up -d db && npm run test:integration -- share-departure
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
  expectBypassNotices,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { analyze } from "../../../scripts/checks/check-migration-transaction.mjs";

const { scimTenant, stalePermission, forceAdmitted } = vi.hoisted(() => ({
  scimTenant: { id: "" },
  // When set, requireTeamPermission answers as it did before the membership ended.
  stalePermission: { membership: null as null | { id: string; role: string; teamId: string; userId: string } },
  // When set, the serve paths' pre-check admits, so only the UPDATEs' call decides.
  forceAdmitted: { on: false },
}));
vi.mock("@/lib/auth/access/team-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/access/team-auth")>();
  return {
    ...actual,
    requireTeamPermission: async (...args: Parameters<typeof actual.requireTeamPermission>) =>
      stalePermission.membership ?? actual.requireTeamPermission(...args),
  };
});
vi.mock("@/lib/share/share-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/share/share-admission")>();
  return {
    ...actual,
    isShareCreatorAdmitted: async (...args: Parameters<typeof actual.isShareCreatorAdmitted>) =>
      forceAdmitted.on ? true : actual.isShareCreatorAdmitted(...args),
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "share-departure-test", "x-forwarded-for": "203.0.113.7" }),
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

import SharePage from "@/app/s/[token]/page";
import { ShareError } from "@/components/share/share-error";
import { ShareProtectedContent } from "@/components/share/share-protected-content";
import { POST as verifyAccess } from "@/app/api/share-links/verify-access/route";
import { GET as shareContent } from "@/app/api/share-links/[id]/content/route";
import { POST as createShareLink, GET as listShareLinks } from "@/app/api/share-links/route";
import { GET as listMine } from "@/app/api/share-links/mine/route";
import { PATCH as scimPatchUser, DELETE as scimDeleteUser } from "@/app/api/scim/v2/Users/[id]/route";
import { DELETE as removeMember } from "@/app/api/teams/[teamId]/members/[memberId]/route";
import { hashToken, generateAccessPassword, hashAccessPassword } from "@/lib/crypto/crypto-server";
import { createShareAccessToken } from "@/lib/auth/tokens/share-access-token";
import { BYPASS_GRANT, setBypassGucs, setTenantGucs } from "@/lib/tenant-rls-grants";
import { prisma } from "@/lib/prisma";

const hex = (n: number) => randomBytes(n).toString("hex");
const ROLLBACK = new Error("rollback");

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("share links across a creator's departure — real-DB integration", () => {
  let ctx: TestContext;
  let side: ReturnType<typeof createPrismaForRole>;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    side = createPrismaForRole("superuser");
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
    stalePermission.membership = null;
    forceAdmitted.on = false;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
    vi.unstubAllEnvs();
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A tenant MEMBER (createUser makes OWNERs, whom a departure never touches). */
  async function member(tenant = tenantId): Promise<string> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    return id;
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

  async function addTeamMember(teamId: string, userId: string, role: string, createdAt = "now()"): Promise<string> {
    const rowId = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, ${createdAt}, now())`,
      rowId, teamId, userId, tenantId, role,
    );
    return rowId;
  }

  async function teamPolicy(teamId: string, o: { allowSharing: boolean; requireSharePassword: boolean }): Promise<void> {
    await sql(
      `INSERT INTO team_policies (id, team_id, tenant_id, allow_sharing, require_share_password, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now(), now())
       ON CONFLICT (team_id) DO UPDATE SET allow_sharing = $4, require_share_password = $5, updated_at = now()`,
      randomUUID(), teamId, tenantId, o.allowSharing, o.requireSharePassword,
    );
  }

  async function teamEntry(teamId: string, owner: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_password_entries (id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
         aad_version, team_key_version, item_key_version, entry_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, 1, 0, 'LOGIN', now(), now())`,
      id, teamId, tenantId, owner, hex(32), hex(12), hex(16), hex(32), hex(12), hex(16),
    );
    return id;
  }

  async function personalEntry(userId: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag, key_version, aad_version, entry_type, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 1, 1, 'LOGIN', now(), now())`,
      id, userId, tenantId, hex(32), hex(12), hex(16), hex(32), hex(12), hex(16),
    );
    return id;
  }

  interface SeededShare {
    id: string;
    token: string;
    password?: string;
  }

  async function share(o: {
    creatorId: string;
    teamEntryId?: string | null;
    personalEntryId?: string | null;
    version?: number;
    shareType?: "ENTRY_SHARE" | "TEXT" | "FILE";
    protect?: boolean;
    maxViews?: number | null;
    createdAt?: string;
  }): Promise<SeededShare> {
    const id = randomUUID();
    const token = hex(32);
    const password = o.protect ? generateAccessPassword() : undefined;
    const hashed = password ? hashAccessPassword(password) : null;
    await sql(
      `INSERT INTO password_shares (id, tenant_id, token_hash, share_type, entry_type, encrypted_data, data_iv,
         data_auth_tag, expires_at, max_views, created_by_id, team_password_entry_id, master_key_version,
         access_password_hash, access_password_hash_version, password_entry_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::"ShareType", 'LOGIN', $5, $6, $7, now() + interval '1 day', $8,
         $9::uuid, $10::uuid, $11, $12, $13, $14::uuid, ${o.createdAt ?? "now()"})`,
      id, tenantId, hashToken(token), o.shareType ?? "ENTRY_SHARE", hex(32), hex(12), hex(16),
      o.maxViews ?? null, o.creatorId, o.teamEntryId ?? null, o.version ?? 0,
      hashed?.hash ?? null, hashed?.version ?? 1, o.personalEntryId ?? null,
    );
    return { id, token, password };
  }

  async function state(shareId: string) {
    const [row] = await sql<{ view_count: number; revoked_at: Date | null; logs: number }>(
      `SELECT s.view_count, s.revoked_at,
              (SELECT count(*)::int FROM share_access_logs l WHERE l.share_id = s.id) AS logs
         FROM password_shares s WHERE s.id = $1::uuid`,
      shareId,
    );
    return row;
  }

  /** "served" / "gate" / the ShareError reason. */
  async function page(s: SeededShare): Promise<string> {
    const el = (await SharePage({ params: Promise.resolve({ token: s.token }) })) as { type: unknown; props: { reason?: string } };
    if (el.type === ShareError) return `error:${el.props.reason}`;
    if (el.type === ShareProtectedContent) return "gate";
    return "served";
  }

  async function verify(s: SeededShare, password = s.password ?? "x") {
    const res = await verifyAccess(jsonRequest("http://localhost/api/share-links/verify-access", "POST", { token: s.token, password }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function content(s: SeededShare) {
    const res = await shareContent(
      new NextRequest(`http://localhost/api/share-links/${s.id}/content`, {
        headers: { authorization: `Bearer ${createShareAccessToken(s.id)}` },
      }),
      { params: Promise.resolve({ id: s.id }) },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  function scimActive(userId: string, active: boolean) {
    return scimPatchUser(
      jsonRequest(`http://localhost/api/scim/v2/Users/${userId}`, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: active }],
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  async function remove(teamId: string, actor: string, memberRowId: string) {
    mockAuth.mockResolvedValue({ user: { id: actor } });
    const res = await removeMember(new NextRequest(`http://localhost/api/teams/${teamId}/members/${memberRowId}`, { method: "DELETE" }), {
      params: Promise.resolve({ teamId, memberId: memberRowId }),
    });
    expect(res.status).toBe(200);
  }

  /** A team with an owner, a member creator, one team entry. */
  async function teamWithCreator() {
    const owner = await ctx.createUser(tenantId);
    const creator = await member();
    const teamId = await team(owner);
    const creatorRow = await addTeamMember(teamId, creator, "MEMBER", "now() - interval '1 hour'");
    const entryId = await teamEntry(teamId, owner);
    return { owner, creator, teamId, creatorRow, entryId };
  }

  // ── A1 / A2 / A3: serve paths refuse a departed creator's link ──

  it("A1: a SCIM deactivation stops the creator's team links at the page, verify-access and content; serving resumes on return (A3)", async () => {
    const t = await teamWithCreator();
    const open = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const locked = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    const revokedControl = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    await sql(`UPDATE password_shares SET revoked_at = now() WHERE id = $1::uuid`, revokedControl.id);

    // Positive controls.
    expect(await page(open)).toBe("served");
    expect((await state(open.id)).view_count).toBe(1);
    expect(await page(locked)).toBe("gate");
    expect((await verify(locked)).status).toBe(200);
    const live = await content(locked);
    expect(live.status).toBe(200);
    expect((await state(locked.id)).view_count).toBe(1);

    expect((await scimActive(t.creator, false)).status).toBe(200);

    expect(await page(open)).toBe("error:revoked");
    expect(await page(locked)).toBe("error:revoked");
    // A wrong password on the dead link answers as revoked, not "password incorrect".
    const refusedVerify = await verify(locked, generateAccessPassword());
    expect(refusedVerify).toEqual(await verify(revokedControl));
    const refusedContent = await content(locked);
    expect(refusedContent).toEqual(await content(revokedControl));
    for (const s of [open, locked]) {
      const after = await state(s.id);
      expect(after.view_count).toBe(1);
      expect(after.logs).toBe(1);
      expect(after.revoked_at).toBeNull();
    }
    // A3: the IdP reactivates the creator.
    expect((await scimActive(t.creator, true)).status).toBe(200);
    expect(await page(open)).toBe("served");
  });

  it.each([
    ["SCIM DELETE", "scim-delete"],
    ["team member DELETE", "member-delete"],
    ["entry trashed", "trash"],
    ["entry hard-deleted", "entry-delete"],
    ["team deleted", "team-delete"],
  ])("A2: refused after %s", async (_label, path) => {
    const t = await teamWithCreator();
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const locked = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    const revokedControl = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    await sql(`UPDATE password_shares SET revoked_at = now() WHERE id = $1::uuid`, revokedControl.id);
    expect(await page(s)).toBe("served");
    expect((await verify(locked)).status).toBe(200);

    if (path === "scim-delete") {
      const res = await scimDeleteUser(new NextRequest(`http://localhost/api/scim/v2/Users/${t.creator}`, { method: "DELETE" }), {
        params: Promise.resolve({ id: t.creator }),
      });
      expect(res.status).toBe(204);
    } else if (path === "member-delete") {
      await remove(t.teamId, t.owner, t.creatorRow);
    } else if (path === "trash") {
      await sql(`UPDATE team_password_entries SET deleted_at = now() WHERE id = $1::uuid`, t.entryId);
    } else if (path === "entry-delete") {
      await sql(`DELETE FROM team_password_entries WHERE id = $1::uuid`, t.entryId);
    } else {
      await sql(`DELETE FROM teams WHERE id = $1::uuid`, t.teamId);
    }

    expect(await page(s)).toBe("error:revoked");
    expect((await state(s.id)).view_count).toBe(1);
    expect(await page(locked)).toBe("error:revoked");
    expect(await verify(locked)).toEqual(await verify(revokedControl));
    expect(await content(locked)).toEqual(await content(revokedControl));
    expect((await state(locked.id)).view_count).toBe(0);
  });

  it("A3: restoring the entry from the trash serves the link again", async () => {
    const t = await teamWithCreator();
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    await sql(`UPDATE team_password_entries SET deleted_at = now() WHERE id = $1::uuid`, t.entryId);
    expect(await page(s)).toBe("error:revoked");
    await sql(`UPDATE team_password_entries SET deleted_at = NULL WHERE id = $1::uuid`, t.entryId);
    expect(await page(s)).toBe("served");
  });

  it("A3: a soft removal reactivated on the same row (as SCIM group re-add or invitation accept do) serves again", async () => {
    const t = await teamWithCreator();
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    await sql(`UPDATE team_members SET deactivated_at = now() WHERE id = $1::uuid`, t.creatorRow);
    expect(await page(s)).toBe("error:revoked");
    await sql(`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, t.creatorRow);
    expect(await page(s)).toBe("served");
  });

  it("A4: a membership deleted and re-created later does not revive the link", async () => {
    const t = await teamWithCreator();
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId, createdAt: "now() - interval '1 minute'" });
    await remove(t.teamId, t.owner, t.creatorRow);
    await addTeamMember(t.teamId, t.creator, "MEMBER");
    expect(await page(s)).toBe("error:revoked");
  });

  it("A5: removal from team X stops only X's links; another member staying does not keep the creator's link alive", async () => {
    const t = await teamWithCreator();
    const otherTeam = await team(t.owner);
    await addTeamMember(otherTeam, t.creator, "MEMBER", "now() - interval '1 hour'");
    const otherEntry = await teamEntry(otherTeam, t.owner);
    const x = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const y = await share({ creatorId: t.creator, teamEntryId: otherEntry });

    await remove(t.teamId, t.owner, t.creatorRow);

    expect(await page(x)).toBe("error:revoked");
    expect(await page(y)).toBe("served");
  });

  it("A6: personal entry shares and Sends serve regardless of the creator's team state", async () => {
    const t = await teamWithCreator();
    const entry = await personalEntry(t.creator);
    // Protected, so the page answers with the password gate and verify-access
    // issues a token without decrypting anything.
    const personal = await share({ creatorId: t.creator, personalEntryId: entry, version: 1, protect: true });
    const send = await share({ creatorId: t.creator, version: 1, shareType: "TEXT", protect: true });
    await remove(t.teamId, t.owner, t.creatorRow);

    for (const s of [personal, send]) {
      expect(await page(s)).toBe("gate");
      expect((await verify(s)).status).toBe(200);
    }
  });

  // ── A7: a share inserted after the creator lost the membership ──

  it.each([
    ["refused when inserted after the creator was removed from the team", true],
    ["served when the creator was not removed (positive twin)", false],
  ])("A7: %s", async (_label, removed) => {
    const t = await teamWithCreator();
    if (removed) await remove(t.teamId, t.owner, t.creatorRow);
    stalePermission.membership = { id: t.creatorRow, role: "MEMBER", teamId: t.teamId, userId: t.creator };
    mockAuth.mockResolvedValue({ user: { id: t.creator } });
    const res = await createShareLink(
      jsonRequest("http://localhost/api/share-links", "POST", {
        teamPasswordEntryId: t.entryId,
        encryptedShareData: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
        entryType: "LOGIN",
        expiresIn: "1d",
      }),
    );
    expect(res.status).toBe(201);
    const { id, token } = (await res.json()) as { id: string; token: string };
    stalePermission.membership = null;
    expect(await page({ id, token })).toBe(removed ? "error:revoked" : "served");
  });

  it("A7: a share row inserted after the creator's tenant departure is refused", async () => {
    const t = await teamWithCreator();
    expect((await scimActive(t.creator, false)).status).toBe(200);
    const late = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    expect(await page(late)).toBe("error:revoked");
  });

  // ── A13 / A14: sharing policy and personal entry state (#996, #998) ──

  it("A13: turning the team's sharing off stops its links at the page, verify-access and content; turning it back on serves them", async () => {
    const t = await teamWithCreator();
    const open = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const locked = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    const revokedControl = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });
    await sql(`UPDATE password_shares SET revoked_at = now() WHERE id = $1::uuid`, revokedControl.id);
    await teamPolicy(t.teamId, { allowSharing: true, requireSharePassword: false });
    expect(await page(open)).toBe("served");

    await teamPolicy(t.teamId, { allowSharing: false, requireSharePassword: false });
    expect(await page(open)).toBe("error:revoked");
    expect(await page(locked)).toBe("error:revoked");
    expect(await verify(locked)).toEqual(await verify(revokedControl));
    expect(await content(locked)).toEqual(await content(revokedControl));
    expect((await state(open.id)).view_count).toBe(1);
    expect((await state(locked.id)).revoked_at).toBeNull();

    await teamPolicy(t.teamId, { allowSharing: true, requireSharePassword: false });
    expect(await page(open)).toBe("served");
    expect((await verify(locked)).status).toBe(200);
  });

  it("A13: requiring a share password stops the team's unprotected links only; relaxing it serves them again", async () => {
    const t = await teamWithCreator();
    const open = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const locked = await share({ creatorId: t.creator, teamEntryId: t.entryId, protect: true });

    await teamPolicy(t.teamId, { allowSharing: true, requireSharePassword: true });
    expect(await page(open)).toBe("error:revoked");
    expect(await page(locked)).toBe("gate");
    expect((await verify(locked)).status).toBe(200);

    await teamPolicy(t.teamId, { allowSharing: true, requireSharePassword: false });
    expect(await page(open)).toBe("served");
  });

  it("A13: another team's policy does not stop this team's links", async () => {
    const t = await teamWithCreator();
    const otherTeam = await team(t.owner);
    await teamPolicy(otherTeam, { allowSharing: false, requireSharePassword: true });
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    expect(await page(s)).toBe("served");
  });

  it.each([
    ["trashed", "trash"],
    ["deleted", "delete"],
  ] as const)("A14: a personal entry share stops when its entry is %s; a Send of the same creator still serves", async (_label, path) => {
    const creator = await member();
    const entry = await personalEntry(creator);
    const personal = await share({ creatorId: creator, personalEntryId: entry, version: 1, protect: true });
    const revokedControl = await share({ creatorId: creator, personalEntryId: entry, version: 1, protect: true });
    await sql(`UPDATE password_shares SET revoked_at = now() WHERE id = $1::uuid`, revokedControl.id);
    const send = await share({ creatorId: creator, version: 1, shareType: "TEXT", protect: true });
    expect(await page(personal)).toBe("gate");

    if (path === "trash") {
      await sql(`UPDATE password_entries SET deleted_at = now() WHERE id = $1::uuid`, entry);
    } else {
      await sql(`DELETE FROM password_entries WHERE id = $1::uuid`, entry);
    }

    expect(await page(personal)).toBe("error:revoked");
    expect(await verify(personal)).toEqual(await verify(revokedControl));
    expect(await page(send)).toBe("gate");
    expect((await verify(send)).status).toBe(200);
    if (path === "trash") {
      await sql(`UPDATE password_entries SET deleted_at = NULL WHERE id = $1::uuid`, entry);
      expect(await page(personal)).toBe("gate");
    }
  });

  // ── A8: lists ──

  it("A8: /mine?team= reports creatorAdmitted=false to an admin and a member; a VIEWER does not list another member's link", async () => {
    const t = await teamWithCreator();
    const viewer = await member();
    await addTeamMember(t.teamId, viewer, "VIEWER");
    const otherMember = await member();
    await addTeamMember(t.teamId, otherMember, "MEMBER");
    const dead = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const live = await share({ creatorId: otherMember, teamEntryId: t.entryId });
    await remove(t.teamId, t.owner, t.creatorRow);

    for (const who of [t.owner, otherMember]) {
      mockAuth.mockResolvedValue({ user: { id: who } });
      const res = await listMine(new NextRequest(`http://localhost/api/share-links/mine?team=${t.teamId}`));
      const items = ((await res.json()) as { items: { id: string; creatorAdmitted: boolean }[] }).items;
      expect(Object.fromEntries(items.map((i) => [i.id, i.creatorAdmitted]))).toEqual({ [dead.id]: false, [live.id]: true });
    }

    mockAuth.mockResolvedValue({ user: { id: viewer } });
    const asViewer = await listMine(new NextRequest(`http://localhost/api/share-links/mine?team=${t.teamId}`));
    // A VIEWER lists only their own links: neither of these.
    expect(((await asViewer.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("A8: GET /api/share-links as the creator re-admitted on a new membership reports their old link as not admitted", async () => {
    const t = await teamWithCreator();
    const old = await share({ creatorId: t.creator, teamEntryId: t.entryId, createdAt: "now() - interval '1 minute'" });
    await remove(t.teamId, t.owner, t.creatorRow);
    await addTeamMember(t.teamId, t.creator, "MEMBER");
    const fresh = await share({ creatorId: t.creator, teamEntryId: t.entryId });

    mockAuth.mockResolvedValue({ user: { id: t.creator } });
    const res = await listShareLinks(
      new NextRequest(`http://localhost/api/share-links?teamPasswordEntryId=${t.entryId}`),
    );
    const items = ((await res.json()) as { items: { id: string; creatorAdmitted: boolean }[] }).items;
    expect(Object.fromEntries(items.map((i) => [i.id, i.creatorAdmitted]))).toEqual({
      [old.id]: false,
      [fresh.id]: true,
    });
  });

  // ── A9: the team-share CHECK ──

  it("A9: a team-entry share under the server key is rejected by the CHECK; a team E2E share and a personal share insert", async () => {
    const t = await teamWithCreator();
    const insert = (teamEntry: string | null, version: number) =>
      side.pool.query(
        `INSERT INTO password_shares (id, tenant_id, token_hash, share_type, encrypted_data, data_iv, data_auth_tag,
           expires_at, created_by_id, team_password_entry_id, master_key_version)
         VALUES ($1, $2, $3, 'ENTRY_SHARE', 'x', $4, $5, now() + interval '1 day', $6, $7, $8)`,
        [randomUUID(), tenantId, hex(32), hex(12), hex(16), t.creator, teamEntry, version],
      );
    await expect(insert(t.entryId, 1)).rejects.toMatchObject({
      code: "23514",
      constraint: "password_shares_team_share_client_encrypted",
    });
    await expect(insert(t.entryId, 0)).resolves.toBeDefined();
    await expect(insert(null, 1)).resolves.toBeDefined();
  });

  // ── A10: the function's matrix, as passwd_app, in three calling contexts ──

  it("A10: share_creator_admitted decides each case alike under no context, a tenant context and the public serve bypass", async () => {
    const owner = await ctx.createUser(tenantId);
    const teamId = await team(owner);
    const entryId = await teamEntry(teamId, owner);
    const trashedEntry = await teamEntry(teamId, owner);
    await sql(`UPDATE team_password_entries SET deleted_at = now() WHERE id = $1::uuid`, trashedEntry);
    const otherTeamId = await team(owner);
    const base = "timestamptz '2026-06-01 00:00:00+00'";

    async function caseShare(
      memberOffset: string | null,
      opts: { entry?: string | null; deactivated?: boolean; inTeam?: string; version?: number; shareType?: "ENTRY_SHARE" | "TEXT" } = {},
    ) {
      const user = await member();
      if (memberOffset !== null) {
        const row = await addTeamMember(opts.inTeam ?? teamId, user, "MEMBER", `${base} + interval '${memberOffset}'`);
        if (opts.deactivated) await sql(`UPDATE team_members SET deactivated_at = now() WHERE id = $1::uuid`, row);
      }
      return (await share({
        creatorId: user,
        teamEntryId: opts.entry === undefined ? entryId : opts.entry,
        version: opts.version ?? 0,
        shareType: opts.shareType,
        createdAt: base,
      })).id;
    }

    async function personalCase(entryState: "live" | "trashed" | "gone" = "live", shareType: "ENTRY_SHARE" | "FILE" = "ENTRY_SHARE") {
      const user = await member();
      const entry = await personalEntry(user);
      const id = (await share({ creatorId: user, personalEntryId: entry, version: 1, shareType, createdAt: base })).id;
      if (entryState === "trashed") await sql(`UPDATE password_entries SET deleted_at = now() WHERE id = $1::uuid`, entry);
      if (entryState === "gone") await sql(`DELETE FROM password_entries WHERE id = $1::uuid`, entry);
      return id;
    }

    async function policyCase(policy: { allowSharing: boolean; requireSharePassword: boolean }, protect: boolean) {
      const policyOwner = await ctx.createUser(tenantId);
      const policyTeam = await team(policyOwner);
      await teamPolicy(policyTeam, policy);
      const user = await member();
      await addTeamMember(policyTeam, user, "MEMBER", `${base} - interval '1 second'`);
      return (await share({ creatorId: user, teamEntryId: await teamEntry(policyTeam, policyOwner), protect, createdAt: base })).id;
    }

    const cases: [string, string, boolean][] = [
      ["membership 1s before the share", await caseShare("-1 second"), true],
      ["membership at the share's instant", await caseShare("0 second"), true],
      ["membership 1s after the share", await caseShare("1 second"), false],
      ["entry trashed", await caseShare("-1 second", { entry: trashedEntry }), false],
      ["membership deactivated", await caseShare("-1 second", { deactivated: true }), false],
      ["creator never a member (another member is)", await caseShare(null), false],
      ["creator a member of another team only", await caseShare("-1 second", { inTeam: otherTeamId }), false],
      ["team share whose entry is gone (version 0, no entry)", await caseShare("-1 second", { entry: null }), false],
      ["Send (version 1, no entry)", await caseShare(null, { entry: null, version: 1, shareType: "TEXT" }), true],
      ["personal entry share (version 1)", await personalCase(), true],
      ["personal entry share, entry trashed", await personalCase("trashed"), false],
      ["personal entry share, entry gone", await personalCase("gone"), false],
      ["FILE share with a personal entry gone (not an entry share)", await personalCase("gone", "FILE"), true],
      ["team policy allows sharing (row present)", await policyCase({ allowSharing: true, requireSharePassword: false }, false), true],
      ["team policy disallows sharing", await policyCase({ allowSharing: false, requireSharePassword: false }, true), false],
      ["team policy requires a password, link has none", await policyCase({ allowSharing: true, requireSharePassword: true }, false), false],
      ["team policy requires a password, link has one", await policyCase({ allowSharing: true, requireSharePassword: true }, true), true],
      ["unknown id", randomUUID(), false],
    ];
    const legacyCreator = await member();

    const contexts: [string, (tx: Prisma.TransactionClient) => Promise<void>][] = [
      ["none", async () => {}],
      ["tenant", (tx) => setTenantGucs(tx, tenantId)],
      ["public serve bypass", (tx) => setBypassGucs(tx, BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS)],
    ];
    for (const [contextName, enter] of contexts) {
      const results: Record<string, boolean> = {};
      await expect(
        ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // A legacy row (team entry, version 1) as su, possible only without the CHECK.
          await tx.$executeRawUnsafe(`ALTER TABLE password_shares DROP CONSTRAINT password_shares_team_share_client_encrypted`);
          const legacyId = randomUUID();
          await tx.$executeRawUnsafe(
            `INSERT INTO password_shares (id, tenant_id, token_hash, share_type, encrypted_data, data_iv, data_auth_tag,
               expires_at, created_by_id, team_password_entry_id, master_key_version)
             VALUES ($1::uuid, $2::uuid, $3, 'ENTRY_SHARE', 'x', $4, $5, now() + interval '1 day', $6::uuid, $7::uuid, 1)`,
            legacyId, tenantId, hex(32), hex(12), hex(16), legacyCreator, entryId,
          );
          await tx.$executeRawUnsafe(`SET LOCAL ROLE passwd_app`);
          const [{ who }] = await tx.$queryRawUnsafe<{ who: string }[]>(`SELECT current_user AS who`);
          expect(who).toBe("passwd_app");
          await enter(tx);

          const settings = async () =>
            tx.$queryRawUnsafe<{ rls: string; tables: string; purpose: string; tenant: string | null }[]>(
              `SELECT COALESCE(current_setting('app.bypass_rls', true), '') AS rls,
                      COALESCE(current_setting('app.bypass_tables', true), '') AS tables,
                      COALESCE(current_setting('app.bypass_purpose', true), '') AS purpose,
                      current_setting('app.tenant_id', true) AS tenant`,
            );
          for (const [name, id] of [...cases.map(([n, i]) => [n, i] as const), ["legacy server-key team row, creator left", legacyId] as const]) {
            const before = await settings();
            const [{ ok }] = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT share_creator_admitted($1::uuid) AS ok`, id);
            expect(await settings(), `${contextName}: ${name}`).toEqual(before);
            results[name] = ok;
          }

          // The notice sink sees a report on this connection (positive control).
          if (contextName === "public serve bypass") {
            const notices = await expectBypassNotices(() => tx.$queryRawUnsafe(`SELECT count(*) FROM team_members`));
            expect(notices.length).toBeGreaterThan(0);
          }
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);

      expect(results, contextName).toEqual({
        ...Object.fromEntries(cases.map(([n, , want]) => [n, want])),
        "legacy server-key team row, creator left": false,
      });
    }
    // The CHECK came back with the rollback.
    const [c] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'password_shares_team_share_client_encrypted'`,
    );
    expect(c.n).toBe(1);
  });

  // Each migration replaces the function as the role that created it, as on RDS.
  it.each([
    [["20261102000000_share_creator_admitted"]],
    [["20261102000000_share_creator_admitted", "20261108000000_share_admission_policy_and_personal_entry"]],
  ])("A10b: the function's migrations %j apply as a NOSUPERUSER NOBYPASSRLS role (RDS)", async (migrations) => {
    const bodies = migrations.map((migration) => {
      const file = readFileSync(join(process.cwd(), `prisma/migrations/${migration}/migration.sql`), "utf8");
      const whole = analyze(file);
      expect([whole.beginCount, whole.commitCount, whole.rollbackCount]).toEqual([1, 1, 0]);
      const trimmed = file.trim();
      expect(trimmed.startsWith("BEGIN;")).toBe(true);
      expect(trimmed.endsWith("COMMIT;")).toBe(true);
      const body = trimmed.slice("BEGIN;".length, -"COMMIT;".length);
      const inner = analyze(body);
      expect([inner.beginCount, inner.commitCount, inner.rollbackCount]).toEqual([0, 0, 0]);
      return body;
    });

    const t = await teamWithCreator();
    const s = await share({ creatorId: t.creator, teamEntryId: t.entryId });
    const role = `probe_rds_${hex(4)}`;
    const client = await side.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP FUNCTION public.share_creator_admitted(uuid)`);
      await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      for (const body of bodies) await client.query(body);
      await client.query(`RESET ROLE`);
      const fn = await client.query(
        `SELECT pg_get_userbyid(proowner) AS owner,
                has_function_privilege('passwd_app', oid, 'EXECUTE') AS app,
                EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0) AS public
           FROM pg_proc WHERE oid = 'public.share_creator_admitted(uuid)'::regprocedure`,
      );
      expect(fn.rows[0]).toEqual({ owner: role, app: true, public: false });
      await client.query(`SET LOCAL ROLE passwd_app`);
      const r = await client.query(`SELECT share_creator_admitted($1::uuid) AS ok`, [s.id]);
      expect(r.rows[0].ok).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  // ── A12: the UPDATEs' own call refuses when the pre-check is bypassed ──

  it.each([
    ["ENTRY_SHARE, no view limit", "ENTRY_SHARE", null],
    ["ENTRY_SHARE, view limit", "ENTRY_SHARE", 5],
    ["FILE-type team share", "FILE", null],
  ] as const)("A12: with the pre-check forced, the UPDATE refuses a dead link (%s); a live twin serves", async (_label, shareType, maxViews) => {
    const t = await teamWithCreator();
    const deadOpen = await share({ creatorId: t.creator, teamEntryId: t.entryId, shareType, maxViews });
    const deadLocked = await share({ creatorId: t.creator, teamEntryId: t.entryId, shareType, maxViews, protect: true });
    const owner = t.owner;
    const liveOpen = await share({ creatorId: owner, teamEntryId: t.entryId, shareType, maxViews });
    const liveLocked = await share({ creatorId: owner, teamEntryId: t.entryId, shareType, maxViews, protect: true });
    await remove(t.teamId, t.owner, t.creatorRow);

    forceAdmitted.on = true;
    expect(await page(deadOpen)).toBe("error:maxViews");
    expect((await content(deadLocked)).body).toMatchObject({ error: "SHARE_GONE" });
    for (const s of [deadOpen, deadLocked]) {
      const after = await state(s.id);
      expect(after.view_count).toBe(0);
      expect(after.logs).toBe(0);
    }
    expect(await page(liveOpen)).toBe("served");
    expect((await content(liveLocked)).status).toBe(200);
  });
});
