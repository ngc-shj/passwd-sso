import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockFindUnique },
    passwordEntryHistory: { findMany: mockFindMany },
  },
}));

import { GET } from "@/app/api/passwords/[id]/history/route";

describe("GET /api/passwords/[id]/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history");
    const res = await GET(req, createParams({ id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history");
    const res = await GET(req, createParams({ id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({ userId: "other-user" });
    const req = createRequest("GET", "http://localhost/api/passwords/p1/history");
    const res = await GET(req, createParams({ id: "p1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns history entries with encrypted blobs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    const changedAt = new Date("2025-01-15T10:00:00Z");
    mockFindMany.mockResolvedValue([
      {
        id: "h1",
        entryId: "p1",
        encryptedBlob: "cipher1",
        blobIv: "iv1",
        blobAuthTag: "tag1",
        keyVersion: 1,
        aadVersion: 0,
        changedAt,
      },
    ]);

    const req = createRequest("GET", "http://localhost/api/passwords/p1/history");
    const res = await GET(req, createParams({ id: "p1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0]).toEqual({
      id: "h1",
      entryId: "p1",
      encryptedBlob: { ciphertext: "cipher1", iv: "iv1", authTag: "tag1" },
      keyVersion: 1,
      aadVersion: 0,
      changedAt: changedAt.toISOString(),
    });
  });
});
