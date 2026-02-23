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

const txMock = {
  organization: { findUnique: vi.fn(), update: vi.fn() },
  orgPasswordEntry: { update: vi.fn() },
  orgMemberKey: { create: vi.fn() },
};

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
      orgKeyVersion: 1,
    });
    mockMemberFindMany.mockResolvedValue([{ userId: "user-1" }]);
    // Interactive transaction: call the callback with tx proxy
    txMock.organization.findUnique.mockResolvedValue({ orgKeyVersion: 1 });
    txMock.organization.update.mockResolvedValue({});
    txMock.orgPasswordEntry.update.mockResolvedValue({});
    txMock.orgMemberKey.create.mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
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

  it("returns 404 when org not found", async () => {
    mockOrgFindUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("ORG_NOT_FOUND");
  });

  it("returns 403 when user lacks permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new MockOrgAuthError("FORBIDDEN", 403),
    );
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when entries exceed max limit", async () => {
    const tooManyEntries = Array.from({ length: 1001 }, (_, i) => validEntry(`e${i}`));
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: tooManyEntries,
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON (Q-4)", async () => {
    const req = new NextRequest("http://localhost/api/orgs/org-1/rotate-key", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams("org-1"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("filters out non-member memberKeys silently (Q-5)", async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: "user-1" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1"), validMemberKey("non-member-user")],
      }),
      createParams("org-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Only user-1's key should be created, non-member filtered out
    expect(txMock.orgMemberKey.create).toHaveBeenCalledTimes(1);
    expect(txMock.orgMemberKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("returns 409 when orgKeyVersion changed concurrently (S-17 optimistic lock)", async () => {
    // Pre-read returns version 1, but inside tx it's already been bumped to 2
    txMock.organization.findUnique.mockResolvedValue({ orgKeyVersion: 2 });
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("org-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ORG_KEY_VERSION_MISMATCH");
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
