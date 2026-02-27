import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockRequireTeamMember, mockPrismaTeamMember,
  mockPrismaTeamMemberKey, TeamAuthError, mockWithUserTenantRls,
} = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireTeamMember: vi.fn(),
    mockPrismaTeamMember: { findUnique: vi.fn(), findFirst: vi.fn() },
    mockPrismaTeamMemberKey: { findUnique: vi.fn(), findFirst: vi.fn() },
    TeamAuthError: _TeamAuthError,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    teamMemberKey: mockPrismaTeamMemberKey,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET } from "./route";

const URL = "http://localhost/api/teams/team-1/member-key";

describe("GET /api/teams/[teamId]/member-key", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_TEAM_MEMBER", 404));
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_TEAM_MEMBER");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", URL),
        { params: Promise.resolve({ teamId: "team-1" }) },
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 403 when key not distributed", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: false });
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("KEY_NOT_DISTRIBUTED");
  });

  it("returns latest key when no keyVersion param", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaTeamMemberKey.findFirst.mockResolvedValue({
      encryptedTeamKey: "enc-key",
      teamKeyIv: "iv-hex",
      teamKeyAuthTag: "tag-hex",
      ephemeralPublicKey: "eph-pub",
      hkdfSalt: "salt-hex",
      keyVersion: 2,
      wrapVersion: 1,
    });

    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.encryptedTeamKey).toBe("enc-key");
    expect(json.keyVersion).toBe(2);
    expect(json.wrapVersion).toBe(1);
    expect(mockPrismaTeamMemberKey.findFirst).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "user-1" },
      orderBy: { keyVersion: "desc" },
    });
  });

  it("returns specific key version when param provided", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaTeamMemberKey.findUnique.mockResolvedValue({
      encryptedTeamKey: "enc-key-v1",
      teamKeyIv: "iv",
      teamKeyAuthTag: "tag",
      ephemeralPublicKey: "eph",
      hkdfSalt: "salt",
      keyVersion: 1,
      wrapVersion: 1,
    });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=1`),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(1);
    expect(json.wrapVersion).toBe(1);
  });

  it("returns 400 on invalid keyVersion param", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=abc`),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion=0 (boundary)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=0`),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion exceeds upper bound (S-30)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=10001`),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when member key not found", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaTeamMemberKey.findFirst.mockResolvedValue(null);

    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "team-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_KEY_NOT_FOUND");
  });
});
