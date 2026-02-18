import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaOrgPasswordEntry,
  mockPrismaOrgPasswordEntryHistory,
  mockRequireOrgMember,
  mockUnwrapOrgKey,
  mockDecryptServerData,
  OrgAuthError,
} = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaOrgPasswordEntry: { findUnique: vi.fn() },
    mockPrismaOrgPasswordEntryHistory: { findUnique: vi.fn() },
    mockRequireOrgMember: vi.fn(),
    mockUnwrapOrgKey: vi.fn(),
    mockDecryptServerData: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    orgPasswordEntryHistory: mockPrismaOrgPasswordEntryHistory,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgMember: mockRequireOrgMember,
  OrgAuthError,
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: mockUnwrapOrgKey,
  decryptServerData: mockDecryptServerData,
}));
vi.mock("@/lib/crypto-aad", () => ({
  buildOrgEntryAAD: vi.fn().mockReturnValue("test-aad"),
}));

import { GET } from "./route";

const ORG_ID = "org-123";
const ENTRY_ID = "entry-456";
const HISTORY_ID = "hist-789";
const orgKeyData = { encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag" };

function makeUrl() {
  return `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${ENTRY_ID}/history/${HISTORY_ID}`;
}

function makeParams() {
  return createParams({ orgId: ORG_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

describe("GET /api/orgs/[orgId]/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ id: "member-1" });
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when not org member", async () => {
    mockRequireOrgMember.mockRejectedValue(
      new OrgAuthError("NOT_A_MEMBER", 403),
    );
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(createRequest("GET", makeUrl()), makeParams()),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry orgId does not match", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: "other-org",
      org: orgKeyData,
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: ORG_ID,
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history entryId does not match", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: ORG_ID,
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: "other-entry",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 500 when decryption fails", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: ENTRY_ID,
      encryptedBlob: "blob",
      blobIv: "iv",
      blobAuthTag: "tag",
      aadVersion: 1,
      changedAt: new Date("2025-01-01"),
    });
    mockDecryptServerData.mockImplementation(() => {
      throw new Error("decrypt failed");
    });

    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("DECRYPT_FAILED");
  });

  it("returns decrypted history with AAD for aadVersion >= 1", async () => {
    const changedAt = new Date("2025-01-01");
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: ENTRY_ID,
      encryptedBlob: "blob",
      blobIv: "iv",
      blobAuthTag: "tag",
      aadVersion: 1,
      changedAt,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "Old Title",
        username: "user",
        password: "oldpass",
      }),
    );

    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(HISTORY_ID);
    expect(json.entryId).toBe(ENTRY_ID);
    expect(json.entryType).toBe("LOGIN");
    expect(json.title).toBe("Old Title");
    expect(json.password).toBe("oldpass");

    // Verify AAD was passed to decryptServerData
    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeInstanceOf(Buffer);
  });

  it("passes undefined AAD for legacy entries (aadVersion=0)", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: ENTRY_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: ENTRY_ID,
      encryptedBlob: "blob",
      blobIv: "iv",
      blobAuthTag: "tag",
      aadVersion: 0,
      changedAt: new Date("2025-01-01"),
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Legacy", username: "u", password: "p" }),
    );

    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(200);

    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeUndefined();
  });
});
