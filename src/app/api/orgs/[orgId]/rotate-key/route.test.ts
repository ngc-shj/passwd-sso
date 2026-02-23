import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireOrgPermission,
  mockOrgFindUnique,
  mockMemberFindMany,
  mockTransaction,
  MockOrgAuthError,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireOrgPermission: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockMemberFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  MockOrgAuthError: class MockOrgAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError: MockOrgAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: mockOrgFindUnique, update: vi.fn() },
    orgMember: { findMany: mockMemberFindMany },
    orgPasswordEntry: { update: vi.fn() },
    orgMemberKey: { create: vi.fn() },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { POST } from "./route";

function createRequest(body: unknown) {
  return new NextRequest("http://localhost/api/orgs/org-1/rotate-key", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function createParams(orgId: string) {
  return { params: Promise.resolve({ orgId }) };
}

function validEntry(id: string) {
  return {
    id,
    encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "ov", iv: "c".repeat(24), authTag: "d".repeat(32) },
    aadVersion: 1,
  };
}

function validMemberKey(userId: string) {
  return {
    userId,
    encryptedOrgKey: "enc-key",
    orgKeyIv: "a".repeat(24),
    orgKeyAuthTag: "b".repeat(32),
    ephemeralPublicKey: "pub-key",
    hkdfSalt: "c".repeat(64),
    keyVersion: 2,
  };
}

describe("POST /api/orgs/[orgId]/rotate-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockOrgFindUnique.mockResolvedValue({
      e2eEnabled: true,
      orgKeyVersion: 1,
      migrationInProgress: false,
    });
    mockMemberFindMany.mockResolvedValue([{ userId: "user-1" }]);
    mockTransaction.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when E2E not enabled", async () => {
    mockOrgFindUnique.mockResolvedValue({
      e2eEnabled: false,
      orgKeyVersion: 1,
      migrationInProgress: false,
    });
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 423 when migration in progress", async () => {
    mockOrgFindUnique.mockResolvedValue({
      e2eEnabled: true,
      orgKeyVersion: 1,
      migrationInProgress: true,
    });
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(423);
  });

  it("returns 409 when version mismatch", async () => {
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 5, // should be 2
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.details.expected).toBe(2);
  });

  it("returns 400 when member key missing", async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")], // missing user-2
      }),
      createParams("org-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.details.missingKeyFor).toBe("user-2");
  });

  it("rotates key successfully", async () => {
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.orgKeyVersion).toBe(2);
    expect(mockTransaction).toHaveBeenCalled();
  });
});
