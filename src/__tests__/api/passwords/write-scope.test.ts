import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockAuthOrToken, mockCreate, mockFindUnique, mockUpdate, mockTransaction, mockHistoryCreate, mockHistoryFindMany, mockHistoryDeleteMany, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuthOrToken: vi.fn(),
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockHistoryCreate: vi.fn(),
  mockHistoryFindMany: vi.fn(),
  mockHistoryDeleteMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth-or-token", () => ({ authOrToken: mockAuthOrToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: {
      create: mockCreate,
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: mockFindUnique,
      update: mockUpdate,
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    passwordEntryHistory: {
      create: mockHistoryCreate,
      findMany: mockHistoryFindMany,
      deleteMany: mockHistoryDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "@/app/api/passwords/route";
import { PUT } from "@/app/api/passwords/[id]/route";

// iv = 12 bytes (24 hex chars), authTag = 16 bytes (32 hex chars)
const validIv = "a".repeat(24);
const validAuthTag = "b".repeat(32);

const validBody = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  encryptedBlob: { ciphertext: "aabbccdd", iv: validIv, authTag: validAuthTag },
  encryptedOverview: { ciphertext: "11223344", iv: validIv, authTag: validAuthTag },
  keyVersion: 1,
  aadVersion: 1,
  entryType: "LOGIN",
};

describe("passwords:write scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/passwords", () => {
    it("allows session-authenticated requests", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
      mockCreate.mockResolvedValue({
        id: "new-id",
        encryptedOverview: "1122",
        overviewIv: "3344",
        overviewAuthTag: "5566",
        keyVersion: 1,
        aadVersion: 1,
        entryType: "LOGIN",
        requireReprompt: false,
        expiresAt: null,
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createRequest("POST", "http://localhost/api/passwords", { body: validBody });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("allows extension token with passwords:write scope", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-1",
        scopes: ["passwords:read", "passwords:write"],
      });
      mockCreate.mockResolvedValue({
        id: "new-id",
        encryptedOverview: "1122",
        overviewIv: "3344",
        overviewAuthTag: "5566",
        keyVersion: 1,
        aadVersion: 1,
        entryType: "LOGIN",
        requireReprompt: false,
        expiresAt: null,
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createRequest("POST", "http://localhost/api/passwords", {
        body: validBody,
        headers: { Authorization: "Bearer test-token" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("rejects extension token without passwords:write scope (403)", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });

      const req = createRequest("POST", "http://localhost/api/passwords", {
        body: validBody,
        headers: { Authorization: "Bearer test-token" },
      });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);
      expect(status).toBe(403);
      expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
    });

    it("returns 401 when no auth", async () => {
      mockAuthOrToken.mockResolvedValue(null);

      const req = createRequest("POST", "http://localhost/api/passwords", { body: validBody });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);
      expect(status).toBe(401);
      expect(json.error).toBe("UNAUTHORIZED");
    });
  });

  describe("PUT /api/passwords/[id]", () => {
    const updateBody = {
      encryptedBlob: { ciphertext: "aabbccdd", iv: validIv, authTag: validAuthTag },
      encryptedOverview: { ciphertext: "11223344", iv: validIv, authTag: validAuthTag },
    };

    it("allows session-authenticated requests", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
      mockFindUnique.mockResolvedValue({
        id: "p1",
        userId: "user-1",
        encryptedBlob: "old",
        blobIv: "old",
        blobAuthTag: "old",
        keyVersion: 1,
        aadVersion: 1,
      });
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          passwordEntryHistory: {
            create: mockHistoryCreate.mockResolvedValue({}),
            findMany: mockHistoryFindMany.mockResolvedValue([]),
            deleteMany: mockHistoryDeleteMany.mockResolvedValue({}),
          },
        });
      });
      mockUpdate.mockResolvedValue({
        id: "p1",
        encryptedOverview: "1122",
        overviewIv: "3344",
        overviewAuthTag: "5566",
        keyVersion: 1,
        aadVersion: 1,
        entryType: "LOGIN",
        requireReprompt: false,
        expiresAt: null,
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createRequest("PUT", "http://localhost/api/passwords/p1", { body: updateBody });
      const res = await PUT(req, createParams({ id: "p1" }));
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("rejects extension token without passwords:write scope (403)", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });

      const req = createRequest("PUT", "http://localhost/api/passwords/p1", {
        body: updateBody,
        headers: { Authorization: "Bearer test-token" },
      });
      const res = await PUT(req, createParams({ id: "p1" }));
      const { status, json } = await parseResponse(res);
      expect(status).toBe(403);
      expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
    });

    it("returns 401 when no auth", async () => {
      mockAuthOrToken.mockResolvedValue(null);

      const req = createRequest("PUT", "http://localhost/api/passwords/p1", { body: updateBody });
      const res = await PUT(req, createParams({ id: "p1" }));
      const { status, json } = await parseResponse(res);
      expect(status).toBe(401);
      expect(json.error).toBe("UNAUTHORIZED");
    });

    it("allows extension token with passwords:write scope", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "token",
        userId: "user-1",
        scopes: ["passwords:read", "passwords:write"],
      });
      mockFindUnique.mockResolvedValue({
        id: "p1",
        userId: "user-1",
        encryptedBlob: "old",
        blobIv: "old",
        blobAuthTag: "old",
        keyVersion: 1,
        aadVersion: 1,
      });
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          passwordEntryHistory: {
            create: mockHistoryCreate.mockResolvedValue({}),
            findMany: mockHistoryFindMany.mockResolvedValue([]),
            deleteMany: mockHistoryDeleteMany.mockResolvedValue({}),
          },
        });
      });
      mockUpdate.mockResolvedValue({
        id: "p1",
        encryptedOverview: "1122",
        overviewIv: "3344",
        overviewAuthTag: "5566",
        keyVersion: 1,
        aadVersion: 1,
        entryType: "LOGIN",
        requireReprompt: false,
        expiresAt: null,
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const req = createRequest("PUT", "http://localhost/api/passwords/p1", {
        body: updateBody,
        headers: { Authorization: "Bearer test-token" },
      });
      const res = await PUT(req, createParams({ id: "p1" }));
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("returns 403 when entry belongs to another user", async () => {
      mockAuthOrToken.mockResolvedValue({ type: "token", userId: "user-1", scopes: ["passwords:write"] });
      mockFindUnique.mockResolvedValue({
        id: "p1",
        userId: "other-user",
      });

      const req = createRequest("PUT", "http://localhost/api/passwords/p1", {
        body: updateBody,
        headers: { Authorization: "Bearer test-token" },
      });
      const res = await PUT(req, createParams({ id: "p1" }));
      const { status, json } = await parseResponse(res);
      expect(status).toBe(403);
      expect(json.error).toBe("FORBIDDEN");
    });
  });
});
