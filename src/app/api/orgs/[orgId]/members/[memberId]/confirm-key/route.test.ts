import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockPrismaUser,
  mockPrismaOrgMemberKey, mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaOrgMemberKey: { upsert: vi.fn() },
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    user: mockPrismaUser,
    orgMemberKey: mockPrismaOrgMemberKey,
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const URL = "http://localhost/api/orgs/org-1/members/member-1/confirm-key";

const validBody = {
  encryptedOrgKey: "encrypted-org-key-data",
  orgKeyIv: "a".repeat(24),
  orgKeyAuthTag: "b".repeat(32),
  ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
  hkdfSalt: "c".repeat(64),
  keyVersion: 1,
};

describe("POST /api/orgs/[orgId]/members/[memberId]/confirm-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
    mockTransaction.mockResolvedValue([{}, {}]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when admin is not a member", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValueOnce(null); // requireOrgPermission
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when target member not found", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" }) // admin
      .mockResolvedValueOnce(null); // target member

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when target user has no ECDH public key", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" })
      .mockResolvedValueOnce({ orgId: "org-1", userId: "target-user", keyDistributed: false });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_READY");
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" })
      .mockResolvedValueOnce({ orgId: "org-1", userId: "target-user", keyDistributed: false });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: { encryptedOrgKey: "data" } }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("distributes key successfully", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" })
      .mockResolvedValueOnce({ id: "member-1", orgId: "org-1", userId: "target-user", keyDistributed: false });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
