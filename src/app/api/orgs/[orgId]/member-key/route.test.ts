import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockRequireOrgMember, mockPrismaOrgMember,
  mockPrismaOrgMemberKey, OrgAuthError,
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
    mockPrismaOrgMember: { findUnique: vi.fn() },
    mockPrismaOrgMemberKey: { findUnique: vi.fn(), findFirst: vi.fn() },
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgMember: mockRequireOrgMember,
  OrgAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgMemberKey: mockPrismaOrgMemberKey,
  },
}));

import { GET } from "./route";

const URL = "http://localhost/api/orgs/org-1/member-key";

describe("GET /api/orgs/[orgId]/member-key", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgMember.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("NOT_ORG_MEMBER", 404));
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_ORG_MEMBER");
  });

  it("rethrows non-OrgAuthError", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", URL),
        { params: Promise.resolve({ orgId: "org-1" }) },
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 403 when key not distributed", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: false });
    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("KEY_NOT_DISTRIBUTED");
  });

  it("returns latest key when no keyVersion param", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });
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
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.encryptedOrgKey).toBe("enc-key");
    expect(json.keyVersion).toBe(2);
    expect(mockPrismaOrgMemberKey.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-1" },
      orderBy: { keyVersion: "desc" },
    });
  });

  it("returns specific key version when param provided", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });
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
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(1);
  });

  it("returns 400 on invalid keyVersion param", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=abc`),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion=0 (boundary)", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=0`),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyVersion exceeds upper bound (S-30)", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });

    const res = await GET(
      createRequest("GET", `${URL}?keyVersion=10001`),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when member key not found", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({ keyDistributed: true });
    mockPrismaOrgMemberKey.findFirst.mockResolvedValue(null);

    const res = await GET(
      createRequest("GET", URL),
      { params: Promise.resolve({ orgId: "org-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_KEY_NOT_FOUND");
  });
});
