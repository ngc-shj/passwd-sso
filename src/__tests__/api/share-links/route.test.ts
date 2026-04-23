import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";

const { mockAuth, mockCreate, mockFindMany, mockFindUnique, mockWithUserTenantRls, mockWithBypassRls, mockLogAuditInTx } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockCreate: vi.fn(),
    mockFindMany: vi.fn(),
    mockFindUnique: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn({})),
    mockLogAuditInTx: vi.fn(),
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
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
  encryptShareData: () => ({
    ciphertext: "encrypted",
    iv: "i".repeat(24),
    authTag: "t".repeat(32),
    masterKeyVersion: 1,
  }),
  generateAccessPassword: () => "test-access-password-base64url-43ch",
  hashAccessPassword: () => "hashed-access-password",
}));
vi.mock("@/lib/auth/team-auth", () => ({
  requireTeamPermission: vi.fn(),
  TeamAuthError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
  withTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/team-policy", () => ({
  assertPolicyAllowsSharing: vi.fn(),
  assertPolicySharePassword: vi.fn(),
  PolicyViolationError: class extends Error {},
}));

const { mockCheck } = vi.hoisted(() => ({
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

import { POST, GET } from "@/app/api/share-links/route";

// Valid UUID v4 for test (matches z.string().uuid() validation)
const VALID_ENTRY_ID = "00000000-0000-4000-a000-000000000020";

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
      tenantId: "tenant-1",
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

    expect(status).toBe(201);
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
    mockCheck.mockResolvedValueOnce({ allowed: false });

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
    mockFindUnique.mockResolvedValue({ teamId: "team-123", tenantId: "tenant-1" });
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

    expect(status).toBe(201);
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

    const { requireTeamPermission } = await import("@/lib/auth/team-auth");
    const { TeamAuthError: RealTeamAuthError } = await import("@/lib/auth/team-auth");
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

  it("filters password field with HIDE_PASSWORD permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
      tenantId: "tenant-1",
    });
    mockCreate.mockResolvedValue({
      id: "share-hp",
      expiresAt: new Date(Date.now() + 86400000),
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret", username: "user1", cvv: "123" },
        expiresIn: "1d",
        permissions: ["HIDE_PASSWORD"],
      },
    });
    const res = await POST(req as never);
    const { status } = await parseResponse(res);
    expect(status).toBe(201);

    // Verify permissions are saved to DB
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          permissions: ["HIDE_PASSWORD"],
        }),
      }),
    );
  });

  it("filters to overview only with OVERVIEW_ONLY permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
      tenantId: "tenant-1",
    });
    mockCreate.mockResolvedValue({
      id: "share-ov",
      expiresAt: new Date(Date.now() + 86400000),
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret", username: "user1", url: "https://example.com" },
        expiresIn: "1d",
        permissions: ["OVERVIEW_ONLY"],
      },
    });
    const res = await POST(req as never);
    const { status } = await parseResponse(res);
    expect(status).toBe(201);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          permissions: ["OVERVIEW_ONLY"],
        }),
      }),
    );
  });

  it("returns accessPassword when requirePassword is true (personal share)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
      tenantId: "tenant-1",
    });
    mockCreate.mockResolvedValue({
      id: "share-pw",
      expiresAt: new Date(Date.now() + 86400000),
    });

    const req = createRequest("POST", "http://localhost/api/share-links", {
      body: {
        passwordEntryId: VALID_ENTRY_ID,
        data: { title: "Test", password: "secret" },
        expiresIn: "1d",
        requirePassword: true,
      },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.accessPassword).toBe("test-access-password-base64url-43ch");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accessPasswordHash: "hashed-access-password",
        }),
      })
    );
  });

  it("does not return accessPassword when requirePassword is absent", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
      tenantId: "tenant-1",
    });
    mockCreate.mockResolvedValue({
      id: "share-nopw",
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

    expect(status).toBe(201);
    expect(json.accessPassword).toBeUndefined();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accessPasswordHash: null,
        }),
      })
    );
  });

  it("returns 403 when team policy requires password but requirePassword is false", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({ teamId: "team-123", entryType: ENTRY_TYPE.LOGIN, tenantId: "tenant-1" });

    const { assertPolicySharePassword } = await import("@/lib/team-policy");
    const { PolicyViolationError: RealPVE } = await import("@/lib/team-policy");
    vi.mocked(assertPolicySharePassword).mockRejectedValueOnce(
      new RealPVE("Share password is required by team policy")
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
    expect(json.error).toBe("POLICY_SHARE_PASSWORD_REQUIRED");
  });

  it("saves empty permissions with VIEW_ALL (default)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: ENTRY_TYPE.LOGIN,
      tenantId: "tenant-1",
    });
    mockCreate.mockResolvedValue({
      id: "share-va",
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
    const { status } = await parseResponse(res);
    expect(status).toBe(201);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          permissions: [],
        }),
      }),
    );
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
