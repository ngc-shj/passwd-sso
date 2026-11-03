import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  MockTeamAuthError,
  mockWithTeamTenantRls,
  mockRequireRecentSession,
  mockReadCheck,
  mockFetchUserDisplayMap,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockWithTeamTenantRls: vi.fn(),
  mockRequireRecentSession: vi.fn(),
  mockReadCheck: vi.fn(),
  mockFetchUserDisplayMap: vi.fn(),
}));

const txMock = {
  $queryRaw: vi.fn(),
  team: { findUnique: vi.fn() },
  teamPasswordEntry: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  teamMemberKey: { findMany: vi.fn() },
  teamMember: { findMany: vi.fn(), count: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  teamRekeyReadLimiter: { check: mockReadCheck, clear: vi.fn() },
}));
vi.mock("@/lib/audit/audit-user-lookup", async () => ({
  ...(await vi.importActual<typeof import("@/lib/audit/audit-user-lookup")>("@/lib/audit/audit-user-lookup")),
  fetchUserDisplayMap: mockFetchUserDisplayMap,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";
import { REKEY_HOLDERS_LISTED_MAX } from "@/lib/constants/team/rotate-key";

const TEAM = "11111111-1111-4111-8111-111111111111";
const ME = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const MEMBER = "00000000-0000-4000-8000-0000000000b1";
const AFTER = "22222222-2222-4222-8222-222222222222";

type Holder = { userId: string; role: string };

/** Member-key holders per team key version; the real holder rule reads these. */
let holdersByVersion: Map<number, Holder[]>;

function request(query = "") {
  return new NextRequest(`http://localhost/api/teams/${TEAM}/rekey${query}`);
}

async function list(query = "") {
  const res = await GET(request(query), { params: Promise.resolve({ teamId: TEAM }) });
  return { res, json: await res.json() };
}

describe("GET /api/teams/[teamId]/rekey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ME } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockReadCheck.mockResolvedValue({ allowed: true });
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, tx: typeof txMock) => unknown) => fn("tenant-1", txMock),
    );
    txMock.team.findUnique.mockResolvedValue({ teamKeyVersion: 5 });
    txMock.teamPasswordEntry.count.mockResolvedValue(0);
    txMock.teamPasswordEntry.findMany.mockResolvedValue([]);
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([]);
    holdersByVersion = new Map();
    txMock.teamMemberKey.findMany.mockImplementation(async ({ where }: { where: { keyVersion: number } }) =>
      (holdersByVersion.get(where.keyVersion) ?? []).map((h) => ({ userId: h.userId })),
    );
    txMock.teamMember.findMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      [...holdersByVersion.values()].flat().filter((h, i, all) =>
        where.userId.in.includes(h.userId) && all.findIndex((o) => o.userId === h.userId) === i,
      ),
    );
    txMock.teamMember.count.mockResolvedValue(0);
    txMock.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    mockFetchUserDisplayMap.mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id) => [id, { id, name: `name-${id.slice(-2)}`, email: `${id.slice(-2)}@example.com`, image: null }])),
    );
  });

  // ── Gates ────────────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await list()).res.status).toBe(401);
  });

  it("requires TEAM_UPDATE (a non-member gets the gate's 404)", async () => {
    mockRequireTeamPermission.mockRejectedValue(new MockTeamAuthError("NOT_FOUND", 404));
    const { res } = await list();
    expect(res.status).toBe(404);
    expect(mockRequireTeamPermission).toHaveBeenCalledWith(ME, TEAM, "team:update", expect.anything());
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  it("needs no step-up", async () => {
    await list();
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("rate-limits per (team, user)", async () => {
    mockReadCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { res } = await list();
    expect(res.status).toBe(429);
    expect(mockReadCheck).toHaveBeenCalledWith(`rl:team_rekey_read:${TEAM}:${ME}`);
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  it("returns 404 when the team is invisible", async () => {
    txMock.team.findUnique.mockResolvedValue(null);
    expect((await list()).res.status).toBe(404);
  });

  it.each([
    ["a limit above the cap", "?limit=101"],
    ["a zero limit", "?limit=0"],
    ["a non-uuid cursor", "?after=nope"],
  ])("returns 400 for %s", async (_label, query) => {
    const { res } = await list(query);
    expect(res.status).toBe(400);
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  // ── Paging ───────────────────────────────────────────────────────────────

  it("counts and pages pending entries (marker below the team's version, trash and archive included) by id", async () => {
    txMock.teamPasswordEntry.count.mockResolvedValue(7);
    txMock.teamPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    const { res, json } = await list();
    expect(res.status).toBe(200);
    expect(json.pendingCount).toBe(7);
    expect(json.entryIds).toEqual(["e1", "e2"]);
    const pendingWhere = { teamId: TEAM, itemKeyTeamKeyVersion: { lt: 5 } };
    expect(txMock.teamPasswordEntry.count).toHaveBeenCalledWith({ where: pendingWhere });
    expect(txMock.teamPasswordEntry.findMany).toHaveBeenCalledWith({
      where: pendingWhere,
      select: { id: true },
      orderBy: { id: "asc" },
      take: 50,
    });
  });

  it("continues after the cursor with the requested limit", async () => {
    await list(`?after=${AFTER}&limit=100`);
    expect(txMock.teamPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: TEAM, itemKeyTeamKeyVersion: { lt: 5 }, id: { gt: AFTER } },
        take: 100,
      }),
    );
  });

  // ── States ───────────────────────────────────────────────────────────────

  it("classifies pending entries by who holds their team key version", async () => {
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([
      { teamKeyVersion: 0, _count: { _all: 1 } }, // normalised to 1, with the next row
      { teamKeyVersion: 1, _count: { _all: 2 } },
      { teamKeyVersion: 2, _count: { _all: 4 } },
      { teamKeyVersion: 3, _count: { _all: 5 } },
      { teamKeyVersion: 4, _count: { _all: 6 } },
    ]);
    holdersByVersion.set(1, [{ userId: ME, role: "ADMIN" }, { userId: ADMIN, role: "ADMIN" }]);
    holdersByVersion.set(2, [{ userId: ADMIN, role: "OWNER" }, { userId: MEMBER, role: "MEMBER" }]);
    holdersByVersion.set(3, [{ userId: MEMBER, role: "MEMBER" }]);
    // version 4: nobody.

    const { res, json } = await list();
    expect(res.status).toBe(200);
    expect(json.stateCounts).toEqual({
      ready: 3,
      needs_rekeyer_holder: 4,
      holder_cannot_rekey: 5,
      unrecoverable: 6,
    });
    // Holders are listed only where the caller needs someone else; only re-keyers.
    expect(json.holders).toEqual({
      2: [{ id: ADMIN, name: "name-a1", email: "a1@example.com" }],
    });
  });

  it("does not count a holder whose membership is deactivated", async () => {
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([{ teamKeyVersion: 2, _count: { _all: 1 } }]);
    holdersByVersion.set(2, [{ userId: ADMIN, role: "ADMIN" }]);
    // The member-key row exists, the active-membership read finds nobody.
    txMock.teamMember.findMany.mockResolvedValue([]);
    const { json } = await list();
    expect(json.stateCounts.unrecoverable).toBe(1);
    expect(txMock.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deactivatedAt: null }) }),
    );
  });

  it(`lists at most ${REKEY_HOLDERS_LISTED_MAX} re-keyer holders per version`, async () => {
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([{ teamKeyVersion: 2, _count: { _all: 1 } }]);
    holdersByVersion.set(
      2,
      Array.from({ length: REKEY_HOLDERS_LISTED_MAX + 5 }, (_, i) => ({
        userId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
        role: "ADMIN",
      })),
    );
    const { json } = await list();
    expect(json.holders[2]).toHaveLength(REKEY_HOLDERS_LISTED_MAX);
  });

  // ── Holders per pending version (D36) ────────────────────────────────────

  it("names the other active holders of every pending version, the caller's own included, with deactivated holders counted", async () => {
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([
      { teamKeyVersion: 2, _count: { _all: 1 } },
      { teamKeyVersion: 3, _count: { _all: 1 } },
    ]);
    holdersByVersion.set(2, [{ userId: ME, role: "ADMIN" }, { userId: MEMBER, role: "MEMBER" }, { userId: ADMIN, role: "ADMIN" }]);
    holdersByVersion.set(3, [{ userId: ME, role: "ADMIN" }]);
    txMock.teamMember.count.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in.length === 3 ? 0 : 2,
    );

    const { res, json } = await list();

    expect(res.status).toBe(200);
    expect(json.versionHolders).toEqual({
      2: {
        callerHolds: true,
        activeHolderCount: 3,
        // Re-keyers first; the caller is not listed.
        holders: [
          { id: ADMIN, name: "name-a1", email: "a1@example.com", canRekey: true },
          { id: MEMBER, name: "name-b1", email: "b1@example.com", canRekey: false },
        ],
        deactivatedHolderCount: 0,
      },
      // The caller is the only active holder.
      3: { callerHolds: true, activeHolderCount: 1, holders: [], deactivatedHolderCount: 2 },
    });
    expect(txMock.teamMember.count).toHaveBeenCalledWith({
      where: { teamId: TEAM, userId: { in: [ME] }, deactivatedAt: { not: null } },
    });
  });

  it(`lists at most ${REKEY_HOLDERS_LISTED_MAX} other holders per version but counts them all`, async () => {
    txMock.teamPasswordEntry.groupBy.mockResolvedValue([{ teamKeyVersion: 2, _count: { _all: 1 } }]);
    holdersByVersion.set(
      2,
      Array.from({ length: REKEY_HOLDERS_LISTED_MAX + 5 }, (_, i) => ({
        userId: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
        role: "MEMBER",
      })),
    );
    const { json } = await list();
    expect(json.versionHolders[2].holders).toHaveLength(REKEY_HOLDERS_LISTED_MAX);
    expect(json.versionHolders[2].activeHolderCount).toBe(REKEY_HOLDERS_LISTED_MAX + 5);
  });

  // ── Retained history ─────────────────────────────────────────────────────

  it("counts the team's history rows not under their entry's current ItemKey (NULL distinct)", async () => {
    txMock.$queryRaw.mockResolvedValue([{ count: BigInt(3) }]);
    const { json } = await list();
    expect(json.retainedHistoryCount).toBe(3);
    const sql = (txMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/h\.item_key_id IS DISTINCT FROM e\.item_key_id/);
    expect(sql).toMatch(/e\.team_id = \?::uuid/);
    expect(txMock.$queryRaw.mock.calls[0][1]).toBe(TEAM);
  });
});
