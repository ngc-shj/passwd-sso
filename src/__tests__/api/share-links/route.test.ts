import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";

const { mockAuth, mockCreate, mockFindMany, mockFindUnique } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockCreate: vi.fn(),
    mockFindMany: vi.fn(),
    mockFindUnique: vi.fn(),
  })
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockFindUnique },
    teamPasswordEntry: { findUnique: mockFindUnique },
    passwordShare: { create: mockCreate, findMany: mockFindMany },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
  encryptShareData: () => ({
    ciphertext: "encrypted",
    iv: "i".repeat(24),
    authTag: "t".repeat(32),
    masterKeyVersion: 1,
  }),
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: vi.fn(),
  TeamAuthError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

const { mockCheck } = vi.hoisted(() => ({
  mockCheck: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

import { POST, GET } from "@/app/api/share-links/route";

// Valid CUID for test (matches z.string().cuid() validation)
const VALID_ENTRY_ID = "cm1234567890abcdefghijkl0";

describe("POST /api/share-links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret" },
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 400 for invalid body", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: { expiresIn: "invalid" },
    });
    const res = await POST(req as never);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });

  it("returns 400 VALIDATION_ERROR when personal share request omits data", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when team share includes data field (S-24)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        teamPasswordEntryId: VALID_ENTRY_ID,
        data: { title: "Leaked", password: "oops" },
        encryptedShareData: {
          ciphertext: "c",
          iv: "a".repeat(24),
          authTag: "b".repeat(32),
        },
        entryType: ENTRY_TYPE.LOGIN,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("creates a personal share link successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
    });
    mockCreate.mockResolvedValue({
      id: "share-1",
      expiresAt: new Date(Date.now() + 86400000),
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret" },
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.token).toBe("a".repeat(64));
    expect(json.url).toBe("/s/" + "a".repeat(64));
    expect(json.id).toBe("share-1");

    // Verify masterKeyVersion is saved to DB
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          masterKeyVersion: 1,
        }),
      })
    );
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValueOnce(false);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret" },
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("creates E2E team share link with client-encrypted data", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({ teamId: "team-123" });
    mockCreate.mockResolvedValue({
      id: "share-e2e",
      expiresAt: new Date(Date.now() + 86400000),
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        teamPasswordEntryId: VALID_ENTRY_ID,
        encryptedShareData: {
          ciphertext: "client-encrypted",
          iv: "c".repeat(24),
          authTag: "d".repeat(32),
        },
        entryType: ENTRY_TYPE.LOGIN,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("share-e2e");

    // Verify E2E sentinel masterKeyVersion=0 is saved
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          masterKeyVersion: 0,
          encryptedData: "client-encrypted",
          dataIv: "c".repeat(24),
          dataAuthTag: "d".repeat(32),
        }),
      })
    );
  });

  it("returns 400 on malformed JSON", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/share-links", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 404 when team entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        teamPasswordEntryId: VALID_ENTRY_ID,
        encryptedShareData: {
          ciphertext: "c",
          iv: "a".repeat(24),
          authTag: "b".repeat(32),
        },
        entryType: ENTRY_TYPE.LOGIN,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns TeamAuthError status for team entry permission denied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValueOnce({ teamId: "team-123" });

    const { requireTeamPermission } = await import("@/lib/team-auth");
    const { TeamAuthError: RealTeamAuthError } = await import("@/lib/team-auth");
    vi.mocked(requireTeamPermission).mockRejectedValueOnce(
      new RealTeamAuthError("INSUFFICIENT_PERMISSION", 403)
    );

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        teamPasswordEntryId: VALID_ENTRY_ID,
        encryptedShareData: {
          ciphertext: "c",
          iv: "a".repeat(24),
          authTag: "b".repeat(32),
        },
        entryType: ENTRY_TYPE.LOGIN,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("returns 404 when entry not owned by user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: "other-user",
      entryType: ENTRY_TYPE.LOGIN,
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret" },
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when team share omits encryptedShareData", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        teamPasswordEntryId: VALID_ENTRY_ID,
        expiresIn: "1d",
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/share-links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/share-links", {
      searchParams: { passwordEntryId: VALID_ENTRY_ID },
    });
    const res = await GET(req as never);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 400 without entryId param", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("GET", "http://localhost/api/share-links");
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns share links with isActive flag", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const now = new Date();
    const future = new Date(Date.now() + 86400000);
    const past = new Date(Date.now() - 86400000);

    mockFindMany.mockResolvedValue([
      {
        id: "s1",
        expiresAt: future,
        maxViews: null,
        viewCount: 5,
        revokedAt: null,
        createdAt: now,
      },
      {
        id: "s2",
        expiresAt: past,
        maxViews: 10,
        viewCount: 3,
        revokedAt: null,
        createdAt: now,
      },
      {
        id: "s3",
        expiresAt: future,
        maxViews: 5,
        viewCount: 5,
        revokedAt: null,
        createdAt: now,
      },
    ]);

    const req = createRequest("GET", "http://localhost/api/share-links", {
      searchParams: { passwordEntryId: VALID_ENTRY_ID },
    });
    const res = await GET(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);
    expect(json.items[0].isActive).toBe(true); // active
    expect(json.items[1].isActive).toBe(false); // expired
    expect(json.items[2].isActive).toBe(false); // maxViews reached
  });
});
