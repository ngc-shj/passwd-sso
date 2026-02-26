import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaUser,
  mockPrismaTeamMemberKey, mockPrismaOrganization, mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaTeamMemberKey: { upsert: vi.fn() },
  mockPrismaOrganization: { findUnique: vi.fn() },
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

// Build a tx proxy that delegates to the same mocks
const txProxy = {
  orgMember: mockPrismaTeamMember,
  orgMemberKey: mockPrismaTeamMemberKey,
  organization: mockPrismaOrganization,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaTeamMember,
    user: mockPrismaUser,
    orgMemberKey: mockPrismaTeamMemberKey,
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const URL = "http://localhost/api/teams/team-1/members/member-1/confirm-key";

const validBody = {
  encryptedOrgKey: "encrypted-team-key-data",
  teamKeyIv: "a".repeat(24),
  teamKeyAuthTag: "b".repeat(32),
  ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
  hkdfSalt: "c".repeat(64),
  keyVersion: 1,
};

describe("POST /api/teams/[teamId]/members/[memberId]/confirm-key", () => {
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
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when admin is not a member", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce(null); // getTeamMembership (findFirst)
    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when target member not found", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce(null); // target member

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when target user has no ECDH public key", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" });
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: null });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_READY");
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" });
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: { encryptedOrgKey: "data" } }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("distributes key successfully", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null }); // re-check inside tx
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when target member belongs to a different team (Q-1 IDOR)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ orgId: "team-OTHER", userId: "target-user", keyDistributed: false, deactivatedAt: null }); // target belongs to different team

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 409 when key already distributed (pre-check, Q-2)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ id: "member-1", orgId: "team-1", userId: "target-user", keyDistributed: true, deactivatedAt: null }); // already distributed
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
    // Transaction should NOT be called since pre-check caught it
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON (Q-3)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" });
    mockPrismaTeamMember.findUnique.mockResolvedValueOnce({ orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest(URL, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(
      req,
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 409 when keyVersion does not match team's current version (F-16)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // admin (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null })
      .mockResolvedValueOnce({ keyDistributed: false, deactivatedAt: null }); // re-check passes
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });
    mockPrismaOrganization.findUnique.mockResolvedValue({ orgKeyVersion: 2 }); // team rotated to v2

    const res = await POST(
      createRequest("POST", URL, { body: validBody }), // keyVersion: 1 (stale)
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("returns 409 when key already distributed (TOCTOU race)", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValueOnce({ role: "OWNER", orgId: "team-1" }); // getTeamMembership (findFirst)
    mockPrismaTeamMember.findUnique
      .mockResolvedValueOnce({ id: "member-1", orgId: "team-1", userId: "target-user", keyDistributed: false, deactivatedAt: null }) // target check (passes)
      .mockResolvedValueOnce({ keyDistributed: true, deactivatedAt: null }); // re-check inside tx (race: another admin distributed first)
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(
      createRequest("POST", URL, { body: validBody }),
      { params: Promise.resolve({ teamId: "team-1", memberId: "member-1" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("KEY_ALREADY_DISTRIBUTED");
  });
});
