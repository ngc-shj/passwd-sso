import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaOrgPasswordEntry,
  mockPrismaOrgPasswordEntryHistory,
  mockRequireOrgMember,
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

import { GET } from "./route";

const ORG_ID = "org-123";
const ENTRY_ID = "entry-456";
const HISTORY_ID = "hist-789";

function makeUrl() {
  return `http://localhost:3000/api/teams/${ORG_ID}/passwords/${ENTRY_ID}/history/${HISTORY_ID}`;
}

function makeParams() {
  return createParams({ teamId: ORG_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

describe("GET /api/teams/[teamId]/passwords/[id]/history/[historyId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ id: "member-1" });
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
      orgId: "other-org",
      entryType: "LOGIN",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      orgId: ORG_ID,
      entryType: "LOGIN",
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when history entryId does not match", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      orgId: ORG_ID,
      entryType: "LOGIN",
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: "other-entry",
    });
    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns encrypted history blob as-is (E2E mode)", async () => {
    const changedAt = new Date("2025-01-01");
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      orgId: ORG_ID,
      entryType: "LOGIN",
    });
    mockPrismaOrgPasswordEntryHistory.findUnique.mockResolvedValue({
      id: HISTORY_ID,
      entryId: ENTRY_ID,
      encryptedBlob: "encrypted-blob-data",
      blobIv: "aabbccddee001122",
      blobAuthTag: "aabbccddee0011223344556677889900",
      aadVersion: 1,
      orgKeyVersion: 1,
      changedAt,
    });

    const res = await GET(createRequest("GET", makeUrl()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe(HISTORY_ID);
    expect(json.entryId).toBe(ENTRY_ID);
    expect(json.entryType).toBe("LOGIN");
    expect(json.encryptedBlob).toBe("encrypted-blob-data");
    expect(json.blobIv).toBe("aabbccddee001122");
    expect(json.blobAuthTag).toBe("aabbccddee0011223344556677889900");
    expect(json.aadVersion).toBe(1);
    expect(json.orgKeyVersion).toBe(1);
    // Should NOT contain decrypted fields
    expect(json.title).toBeUndefined();
    expect(json.password).toBeUndefined();
  });
});
