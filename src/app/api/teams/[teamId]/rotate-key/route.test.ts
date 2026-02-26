import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockOrgFindUnique,
  mockTransaction,
  MockTeamAuthError,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.status = status;
    }
  },
}));

const txMock = {
  organization: { findUnique: vi.fn(), update: vi.fn() },
  orgMember: { findMany: vi.fn() },
  orgPasswordEntry: { updateMany: vi.fn(), findMany: vi.fn() },
  orgMemberKey: { create: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: mockOrgFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

function createRequest(body: unknown) {
  return new NextRequest("http://localhost/api/teams/team-1/rotate-key", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function createParams(teamId: string) {
  return { params: Promise.resolve({ teamId }) };
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

describe("POST /api/teams/[teamId]/rotate-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockOrgFindUnique.mockResolvedValue({
      orgKeyVersion: 1,
    });
    // Interactive transaction: call the callback with tx proxy
    txMock.organization.findUnique.mockResolvedValue({ orgKeyVersion: 1 });
    txMock.organization.update.mockResolvedValue({});
    txMock.orgMember.findMany.mockResolvedValue([{ userId: "user-1" }]);
    txMock.orgPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.orgPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }]);
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
      createParams("team-1"),
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
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.details.expected).toBe(2);
  });

  it("returns 400 when member key missing (F-26: checked inside tx)", async () => {
    txMock.orgMember.findMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")], // missing user-2
      }),
      createParams("team-1"),
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
      createParams("team-1"),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("ORG_NOT_FOUND");
  });

  it("returns 403 when user lacks permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
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
      createParams("team-1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON (Q-4)", async () => {
    const req = new NextRequest("http://localhost/api/teams/team-1/rotate-key", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams("team-1"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when memberKeys contain non-member userId (F-18/S-22, F-26: inside tx)", async () => {
    txMock.orgMember.findMany.mockResolvedValue([{ userId: "user-1" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1"), validMemberKey("non-member-user")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.details.unknownUserId).toBe("non-member-user");
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
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ORG_KEY_VERSION_MISMATCH");
  });

  it("rotates key successfully and logs audit (S-2)", async () => {
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.orgKeyVersion).toBe(2);
    expect(mockTransaction).toHaveBeenCalled();
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORG_KEY_ROTATION",
        orgId: "team-1",
        metadata: expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          entriesRotated: 1,
          membersUpdated: 1,
        }),
      }),
    );
  });

  it("returns 400 when entry count does not match org entries (F-17)", async () => {
    // Team has 3 entries but client submits only 1
    txMock.orgPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ENTRY_COUNT_MISMATCH");
  });

  it("returns 400 when submitted entry IDs do not exactly match org entries", async () => {
    txMock.orgPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("deleted-or-foreign-id")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ENTRY_COUNT_MISMATCH");
  });

  it("passes wrapVersion to OrgMemberKey create (F-19)", async () => {
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [{ ...validMemberKey("user-1"), wrapVersion: 1 }],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgMemberKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wrapVersion: 1 }),
      }),
    );
  });

  it("uses newOrgKeyVersion for memberKey creation regardless of payload keyVersion (S-3)", async () => {
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1")],
        memberKeys: [{
          ...validMemberKey("user-1"),
          keyVersion: 999, // intentionally wrong
        }],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgMemberKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ keyVersion: 2 }), // server forces correct version
      }),
    );
  });

  it("includes trashed entries in rotation (all-entries policy)", async () => {
    // Team has 2 entries: one active (e1), one trashed (e-trash).
    // rotate-key must cover ALL entries including trash.
    txMock.orgPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }, { id: "e-trash" }]);
    txMock.orgPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.orgMember.findMany.mockResolvedValue([{ userId: "user-1" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1"), validEntry("e-trash")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgPasswordEntry.updateMany).toHaveBeenCalledTimes(2);
    // Verify findMany was called without deletedAt filter
    expect(txMock.orgPasswordEntry.findMany).toHaveBeenCalledWith({
      where: { orgId: "team-1" },
      select: { id: true },
    });
  });

  it("succeeds with entries having mixed orgKeyVersions after history restore (F-29)", async () => {
    // Two entries exist — one may have been restored from history with a stale orgKeyVersion.
    // rotate-key should update all entries regardless of their current orgKeyVersion.
    txMock.orgPasswordEntry.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    txMock.orgPasswordEntry.updateMany.mockResolvedValue({ count: 1 });
    txMock.orgMember.findMany.mockResolvedValue([{ userId: "user-1" }]);
    const res = await POST(
      createRequest({
        newOrgKeyVersion: 2,
        entries: [validEntry("e1"), validEntry("e2")],
        memberKeys: [validMemberKey("user-1")],
      }),
      createParams("team-1"),
    );
    expect(res.status).toBe(200);
    expect(txMock.orgPasswordEntry.updateMany).toHaveBeenCalledTimes(2);
  });
});
