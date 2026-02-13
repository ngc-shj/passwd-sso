import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";

const { mockAuth, mockFindMany } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findMany: mockFindMany },
  },
}));

import { GET } from "@/app/api/share-links/mine/route";

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    entryType: ENTRY_TYPE.LOGIN,
    expiresAt: new Date(Date.now() + 86400_000), // +1 day
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    createdAt: new Date(),
    createdById: DEFAULT_SESSION.user.id,
    passwordEntryId: "pe-1",
    orgPasswordEntryId: null,
    passwordEntry: { id: "pe-1" },
    orgPasswordEntry: null,
    ...overrides,
  };
}

describe("GET /api/share-links/mine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns share links for authenticated user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const share = makeShare();
    mockFindMany.mockResolvedValue([share]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("share-1");
    expect(json.items[0].isActive).toBe(true);
    expect(json.items[0].hasPersonalEntry).toBe(true);
    expect(json.items[0].orgName).toBeNull();
    expect(json.nextCursor).toBeNull();
  });

  it("computes isActive=false when revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ revokedAt: new Date() }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("computes isActive=false when expired", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ expiresAt: new Date(Date.now() - 1000) }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("computes isActive=false when maxViews reached", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({ maxViews: 5, viewCount: 5 }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].isActive).toBe(false);
  });

  it("includes orgName from orgPasswordEntry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      makeShare({
        passwordEntryId: null,
        orgPasswordEntryId: "ope-1",
        passwordEntry: null,
        orgPasswordEntry: { id: "ope-1", org: { name: "Acme Corp" } },
      }),
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    const res = await GET(req as never);
    const { json } = await parseResponse(res);

    expect(json.items[0].orgName).toBe("Acme Corp");
    expect(json.items[0].hasPersonalEntry).toBe(false);
  });

  it("filters by status=active", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=active"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
      })
    );
  });

  it("filters by status=expired", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=expired"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          expiresAt: { lte: expect.any(Date) },
        }),
      })
    );
  });

  it("filters by status=revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?status=revoked"
    );
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: { not: null },
        }),
      })
    );
  });

  it("supports cursor-based pagination", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Return 31 items to trigger hasMore
    const shares = Array.from({ length: 31 }, (_, i) =>
      makeShare({ id: `share-${i}` })
    );
    mockFindMany.mockResolvedValue(shares);

    const req = createRequest(
      "GET",
      "http://localhost/api/share-links/mine?cursor=share-prev"
    );
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(30);
    expect(json.nextCursor).toBe("share-29");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "share-prev" },
        skip: 1,
        take: 31,
      })
    );
  });

  it("queries only authenticated user's shares", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/share-links/mine");
    await GET(req as never);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );
  });
});
