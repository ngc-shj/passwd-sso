import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockPrismaUser,
  mockPrismaOrgMemberKey, mockPrismaOrganization, mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaOrgMemberKey: { upsert: vi.fn() },
  mockPrismaOrganization: { findUnique: vi.fn() },
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

// Build a tx proxy that delegates to the same mocks
const txProxy = {
  orgMember: mockPrismaOrgMember,
  orgMemberKey: mockPrismaOrgMemberKey,
  organization: mockPrismaOrganization,
};

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
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 1 });
    // Interactive transaction: call the callback with tx proxy
    mockTransaction.mockImplementation(async (fn: (tx: typeof txProxy) => unknown) => fn(txProxy));
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
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" }) // requireOrgPermission
      .mockResolvedValueOnce({ id: "member-1", orgId: "org-1", userId: "target-user", keyDistributed: false }) // target check
      .mockResolvedValueOnce({ keyDistributed: false }); // re-check inside tx
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

  it("returns 404 when target member belongs to a different org (Q-1 IDOR)", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" }) // admin
      .mockResolvedValueOnce({ orgId: "org-OTHER", userId: "target-user", keyDistributed: false }); // target belongs to different org

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 409 when key already distributed (pre-check, Q-2)", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" }) // admin
      .mockResolvedValueOnce({ id: "member-1", orgId: "org-1", userId: "target-user", keyDistributed: true }); // already distributed
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
    // Transaction should NOT be called since pre-check caught it
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON (Q-3)", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" })
      .mockResolvedValueOnce({ orgId: "org-1", userId: "target-user", keyDistributed: false });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest(URL, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(
      req,
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 409 when keyVersion does not match org's current version (F-16)", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" })
      .mockResolvedValueOnce({ id: "member-1", orgId: "org-1", userId: "target-user", keyDistributed: false })
      .mockResolvedValueOnce({ keyDistributed: false }); // re-check passes
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 2 }); // org rotated to v2

    const res = await POST(
      createRequest("POST", URL, { body: validBody }), // keyVersion: 1 (stale)
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ORG_KEY_VERSION_MISMATCH");
  });

  it("returns 409 when key already distributed (TOCTOU race)", async () => {
    mockPrismaOrgMember.findUnique
      .mockResolvedValueOnce({ role: "OWNER", orgId: "org-1" }) // requireOrgPermission
      .mockResolvedValueOnce({ id: "member-1", orgId: "org-1", userId: "target-user", keyDistributed: false }) // target check (passes)
      .mockResolvedValueOnce({ keyDistributed: true }); // re-check inside tx (race: another admin distributed first)
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ orgId: "org-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
  });
});
