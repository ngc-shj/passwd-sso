import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockRequireOrgMember, mockPrismaOrgMember,
  mockPrismaOrgMemberKey, TeamAuthError,
} = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireOrgMember: vi.fn(),
    mockPrismaOrgMember: { findUnique: vi.fn(), findFirst: vi.fn() },
    mockPrismaOrgMemberKey: { findUnique: vi.fn(), findFirst: vi.fn() },
    TeamAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireOrgMember,
  TeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgMemberKey: mockPrismaOrgMemberKey,
  },
}));

import { GET } from "./route";

const URL = "http://localhost/api/teams/org-1/member-key";

describe("GET /api/teams/[teamId]/member-key", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgMember.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new TeamAuthError("NOT_ORG_MEMBER", 404));
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_ORG_MEMBER");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", URL),
        { params: Promise.resolve({ teamId: "org-1" }) },
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 403 when key not distributed", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: false });
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("KEY_NOT_DISTRIBUTED");
  });

  it("returns latest key when no keyVersion param", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaOrgMemberKey.findFirst.mockResolvedValue({
      encryptedOrgKey: "enc-key",
      orgKeyIv: "iv-hex",
      orgKeyAuthTag: "tag-hex",
      ephemeralPublicKey: "eph-pub",
      hkdfSalt: "salt-hex",
      keyVersion: 2,
      wrapVersion: 1,
    });

    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.encryptedOrgKey).toBe("enc-key");
    expect(json.keyVersion).toBe(2);
    expect(json.wrapVersion).toBe(1);
    expect(mockPrismaOrgMemberKey.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-1" },
      orderBy: { keyVersion: "desc" },
    });
  });

  it("returns specific key version when param provided", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaOrgMemberKey.findUnique.mockResolvedValue({
      encryptedOrgKey: "enc-key-v1",
      orgKeyIv: "iv",
      orgKeyAuthTag: "tag",
      ephemeralPublicKey: "eph",
      hkdfSalt: "salt",
      keyVersion: 1,
      wrapVersion: 1,
    });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=1`),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(1);
    expect(json.wrapVersion).toBe(1);
  });

  it("returns 400 on invalid keyVersion param", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=abc`),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion=0 (boundary)", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=0`),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion exceeds upper bound (S-30)", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=10001`),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when member key not found", async () => {
    mockPrismaOrgMember.findFirst.mockResolvedValue({ keyDistributed: true });
    mockPrismaOrgMemberKey.findFirst.mockResolvedValue(null);

    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ teamId: "org-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_KEY_NOT_FOUND");
  });
});
