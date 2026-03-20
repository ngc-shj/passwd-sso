import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaPasswordEntryHistory, mockPrismaUser, mockWithUserTenantRls, mockRateLimiterCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: { findMany: vi.fn() },
  mockPrismaPasswordEntryHistory: { findMany: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimiterCheck: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaPasswordEntryHistory,
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/rate-limit", () => ({
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
  id: "tz4a98xxat96iws9zmbrgj3a",
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
  id: "kx7b29yybu97jxt0amcshk4b",
  entryId: "tz4a98xxat96iws9zmbrgj3a",
  encryptedBlob: "blob",
  blobIv: "a".repeat(24),
  blobAuthTag: "b".repeat(32),
  keyVersion: 1,
  aadVersion: 1,
};

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
    // withUserTenantRls resolves all three queries in Promise.all
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

  it("returns entries, historyEntries, and ecdhPrivateKey on success", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/vault/rotate-key/data")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].id).toBe("tz4a98xxat96iws9zmbrgj3a");
    expect(json.historyEntries).toHaveLength(1);
    expect(json.historyEntries[0].id).toBe("kx7b29yybu97jxt0amcshk4b");
    expect(json.ecdhPrivateKey).not.toBeNull();
    expect(json.ecdhPrivateKey.encryptedEcdhPrivateKey).toBe("x".repeat(100));
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
});
