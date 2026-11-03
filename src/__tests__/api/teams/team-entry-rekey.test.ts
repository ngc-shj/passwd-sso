import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams, createRequest, parseResponse } from "../../helpers/request-builder";

// Gate refusals of the re-key pass routes: everything that answers before a
// lock is taken. The in-transaction refusals are pinned in the routes' own
// route.test.ts and, against a real DB, in team-entry-rekey.integration.test.ts.

const {
  mockAuth,
  mockRequireTeamPermission,
  mockRequireRecentSession,
  mockRekeyCheck,
  mockReadCheck,
  mockEntryFindUnique,
  mockTeamFindUnique,
  mockLockTeamKeyVersion,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockRequireRecentSession: vi.fn(),
  mockRekeyCheck: vi.fn(),
  mockReadCheck: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockLockTeamKeyVersion: vi.fn(),
  mockWithTeamTenantRls: vi.fn(),
}));

const txMock = {
  teamPasswordEntry: { findUnique: mockEntryFindUnique },
  team: { findUnique: mockTeamFindUnique },
  attachment: { count: vi.fn(async () => 0) },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    requireTeamPermission: mockRequireTeamPermission,
    activeTeamRole: vi.fn(),
    hasTeamPermission: vi.fn(),
    TeamAuthError,
  };
});
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  teamEntryRekeyLimiter: { check: mockRekeyCheck, clear: vi.fn() },
  teamRekeyReadLimiter: { check: mockReadCheck, clear: vi.fn() },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/team/team-key-rotation-lock", () => ({
  lockTeamKeyVersion: mockLockTeamKeyVersion,
  TeamRotationInProgressError: class extends Error {},
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: vi.fn(),
  teamAuditBase: vi.fn(),
}));

import { GET as entryGET, POST as entryPOST } from "@/app/api/teams/[teamId]/passwords/[id]/rekey/route";
import { GET as listGET } from "@/app/api/teams/[teamId]/rekey/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

const ENTRY_URL = "http://localhost/api/teams/t1/passwords/e1/rekey";
const LIST_URL = "http://localhost/api/teams/t1/rekey";

async function post() {
  // The body is never read by a gate refusal.
  const res = await entryPOST(createRequest("POST", ENTRY_URL, { body: {} }), createParams({ teamId: "t1", id: "e1" }));
  return parseResponse(res);
}

async function getEntry() {
  const res = await entryGET(createRequest("GET", ENTRY_URL), createParams({ teamId: "t1", id: "e1" }));
  return parseResponse(res);
}

async function getList() {
  const res = await listGET(createRequest("GET", LIST_URL), createParams({ teamId: "t1" }));
  return parseResponse(res);
}

const ROUTES = [
  ["POST …/passwords/[id]/rekey", post],
  ["GET …/passwords/[id]/rekey", getEntry],
  ["GET …/rekey", getList],
] as const;

describe("re-key pass routes — gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRequireRecentSession.mockResolvedValue(null);
    mockRekeyCheck.mockResolvedValue({ allowed: true });
    mockReadCheck.mockResolvedValue({ allowed: true });
    mockEntryFindUnique.mockResolvedValue({ teamId: "t1", itemKeyVersion: 1, itemKeyTeamKeyVersion: 1 });
    mockTeamFindUnique.mockResolvedValue(null);
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, tx: typeof txMock) => unknown) => fn("tenant-1", txMock),
    );
  });

  it.each(ROUTES)("%s returns 401 without a session", async (_label, call) => {
    mockAuth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it.each(ROUTES)("%s returns 403 for a member without TEAM_UPDATE", async (_label, call) => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const { status, json } = await call();
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockRequireTeamPermission).toHaveBeenCalledWith(DEFAULT_SESSION.user.id, "t1", "team:update", expect.anything());
  });

  it.each(ROUTES)("%s returns 404 for a team of another tenant (not a member)", async (_label, call) => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    expect((await call()).status).toBe(404);
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  it("POST returns the step-up refusal for a stale session; the GETs need none", async () => {
    mockRequireRecentSession.mockResolvedValue(
      new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), { status: 403 }),
    );
    const refused = await post();
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe("SESSION_STEP_UP_REQUIRED");
    mockRequireRecentSession.mockClear();
    await getEntry();
    await getList();
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("POST returns 429 keyed per (team, user)", async () => {
    mockRekeyCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await post()).status).toBe(429);
    expect(mockRekeyCheck).toHaveBeenCalledWith(`rl:team_entry_rekey:t1:${DEFAULT_SESSION.user.id}`);
  });

  it("the GETs return 429 keyed per (team, user)", async () => {
    mockReadCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await getEntry()).status).toBe(429);
    expect((await getList()).status).toBe(429);
    expect(mockReadCheck).toHaveBeenCalledWith(`rl:team_entry_rekey_read:t1:${DEFAULT_SESSION.user.id}`);
    expect(mockReadCheck).toHaveBeenCalledWith(`rl:team_rekey_read:t1:${DEFAULT_SESSION.user.id}`);
  });

  it.each([
    ["an entry id of another team", { teamId: "t2", itemKeyVersion: 1, itemKeyTeamKeyVersion: 1 }],
    ["an entry id of another tenant (invisible under RLS)", null],
  ])("POST and the entry GET return 404 for %s", async (_label, entry) => {
    mockEntryFindUnique.mockResolvedValue(entry);
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 2 });
    expect((await post()).status).toBe(404);
    expect((await getEntry()).status).toBe(404);
    expect(mockLockTeamKeyVersion).not.toHaveBeenCalled();
  });
});
