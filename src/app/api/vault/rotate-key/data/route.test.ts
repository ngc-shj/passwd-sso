import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { ATTACHMENT_MANIFEST_CAP } from "@/lib/validations/common";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaPasswordEntryHistory, mockPrismaUser, mockPrismaAttachment, mockWithUserTenantRls, mockRateLimiterCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: { findMany: vi.fn() },
  mockPrismaPasswordEntryHistory: { findMany: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaAttachment: { findMany: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimiterCheck: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaPasswordEntryHistory,
    user: mockPrismaUser,
    attachment: mockPrismaAttachment,
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

const sampleEntry = {
  id: "00000000-0000-4000-a000-000000000001",
  encryptedBlob: "blob",
  blobIv: "a".repeat(24),
  blobAuthTag: "b".repeat(32),
  encryptedOverview: "overview",
  overviewIv: "c".repeat(24),
  overviewAuthTag: "d".repeat(32),
  keyVersion: 1,
  aadVersion: 1,
};

const sampleHistory = {
  id: "00000000-0000-4000-a000-000000000002",
  entryId: "00000000-0000-4000-a000-000000000001",
  encryptedBlob: "blob",
  blobIv: "a".repeat(24),
  blobAuthTag: "b".repeat(32),
  keyVersion: 1,
  aadVersion: 1,
};

// Helper to build a mode-2 attachment row
function makeMode2Row(id: string, entryId: string) {
  return {
    id,
    passwordEntryId: entryId,
    cekEncrypted: Buffer.from("fake-cek-bytes"),
    cekIv: "a".repeat(24),
    cekAuthTag: "b".repeat(32),
    cekKeyVersion: 1,
    cekWrapAadVersion: 1,
  };
}

// Helper to build a mode-0 attachment row
function makeMode0Row(id: string, entryId: string) {
  return { id, passwordEntryId: entryId };
}

describe("GET /api/vault/rotate-key/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaPasswordEntry.findMany.mockResolvedValue([sampleEntry]);
    mockPrismaPasswordEntryHistory.findMany.mockResolvedValue([sampleHistory]);
    mockPrismaUser.findUnique.mockResolvedValue({
      encryptedEcdhPrivateKey: "x".repeat(100),
      ecdhPrivateKeyIv: "a".repeat(24),
      ecdhPrivateKeyAuthTag: "b".repeat(32),
    });
    // Default: no mode-2 or mode-0 attachments
    mockPrismaAttachment.findMany.mockResolvedValue([]);
    mockWithUserTenantRls.mockImplementation(async (_userId: string, fn: () => unknown) => fn());
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(429);
  });

  it("returns entries, historyEntries, ecdhPrivateKey, and attachment arrays on success", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].id).toBe("00000000-0000-4000-a000-000000000001");
    expect(json.historyEntries).toHaveLength(1);
    expect(json.historyEntries[0].id).toBe("00000000-0000-4000-a000-000000000002");
    expect(json.ecdhPrivateKey).not.toBeNull();
    expect(json.ecdhPrivateKey.encryptedEcdhPrivateKey).toBe("x".repeat(100));
    // Phase B fields are present
    expect(Array.isArray(json.mode2Attachments)).toBe(true);
    expect(Array.isArray(json.mode0Attachments)).toBe(true);
    expect(typeof json.mode0AttachmentsOverflow).toBe("boolean");
  });

  it("returns null ecdhPrivateKey when user has no ECDH keys", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      encryptedEcdhPrivateKey: null,
      ecdhPrivateKeyIv: null,
      ecdhPrivateKeyAuthTag: null,
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ecdhPrivateKey).toBeNull();
  });

  it("returns empty arrays when user has no entries or history", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    mockPrismaPasswordEntryHistory.findMany.mockResolvedValue([]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(0);
    expect(json.historyEntries).toHaveLength(0);
  });

  it("scopes queries to authenticated user via withUserTenantRls", async () => {
    await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(mockWithUserTenantRls).toHaveBeenCalledWith("user-1", expect.any(Function));
  });

  // ── Phase B: mode-2 attachment CEK fields ────────────────────────────

  it("returns mode2Attachments array with CEK fields when mode-2 attachments exist", async () => {
    const entryId = "00000000-0000-4000-a000-000000000001";
    const attId1 = "00000000-0000-4000-a000-000000000010";
    const attId2 = "00000000-0000-4000-a000-000000000011";
    // The route calls attachment.findMany twice: once for mode-2, once for mode-0.
    // We mock the first call (mode-2) to return rows, second call (mode-0) returns [].
    mockPrismaAttachment.findMany
      .mockResolvedValueOnce([makeMode2Row(attId1, entryId), makeMode2Row(attId2, entryId)])
      .mockResolvedValueOnce([]);

    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode2Attachments).toHaveLength(2);
    const att = json.mode2Attachments[0];
    expect(att.id).toBe(attId1);
    expect(att.entryId).toBe(entryId);
    // cekEncrypted is base64-encoded
    expect(typeof att.cekEncrypted).toBe("string");
    expect(att.cekIv).toBe("a".repeat(24));
    expect(att.cekAuthTag).toBe("b".repeat(32));
    expect(att.cekKeyVersion).toBe(1);
    expect(att.cekWrapAadVersion).toBe(1);
  });

  // ── Phase B: mode-0 attachment fields (D1 field names) ───────────────

  it("returns mode0Attachments array with { id, entryId } shape", async () => {
    const entryId = "00000000-0000-4000-a000-000000000001";
    const attId1 = "00000000-0000-4000-a000-000000000020";
    const attId2 = "00000000-0000-4000-a000-000000000021";
    // First call: mode-2 returns [], second call: mode-0 returns rows
    mockPrismaAttachment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeMode0Row(attId1, entryId), makeMode0Row(attId2, entryId)]);

    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode0Attachments).toHaveLength(2);
    expect(json.mode0Attachments[0]).toEqual({ id: attId1, entryId });
    expect(json.mode0Attachments[1]).toEqual({ id: attId2, entryId });
    // D1: must NOT contain mode0AttachmentIds
    expect(json).not.toHaveProperty("mode0AttachmentIds");
    expect(json.mode0AttachmentsOverflow).toBe(false);
  });

  it("returns mode0AttachmentsOverflow: true when more than ATTACHMENT_MANIFEST_CAP mode-0 rows exist", async () => {
    // Route over-fetches by 1 to detect overflow without a separate count query
    const overflowRows = Array.from({ length: ATTACHMENT_MANIFEST_CAP + 1 }, (_, i) => ({
      id: `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
      passwordEntryId: "00000000-0000-4000-a000-000000000001",
    }));
    mockPrismaAttachment.findMany
      .mockResolvedValueOnce([])     // mode-2 call returns empty
      .mockResolvedValueOnce(overflowRows); // mode-0 call returns CAP+1

    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode0AttachmentsOverflow).toBe(true);
    // The response should only contain up to ATTACHMENT_MANIFEST_CAP items
    expect(json.mode0Attachments.length).toBeLessThanOrEqual(ATTACHMENT_MANIFEST_CAP);
  });
});
