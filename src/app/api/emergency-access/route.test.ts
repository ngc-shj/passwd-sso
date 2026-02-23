import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockCheck, mockSendEmail } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockCheck: vi.fn().mockResolvedValue(true),
  mockSendEmail: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant, user: mockPrismaUser },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "mock-token-hex",
  hashToken: (t: string) => `hashed-${t}`,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));

import { POST, GET } from "./route";
import { EA_STATUS } from "@/lib/constants";

describe("POST /api/emergency-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1", email: "owner@test.com" } });
    mockPrismaGrant.findFirst.mockResolvedValue(null);
    mockPrismaGrant.create.mockResolvedValue({
      id: "grant-1",
      status: EA_STATUS.PENDING,
      granteeEmail: "grantee@test.com",
      waitDays: 7,
      tokenExpiresAt: new Date("2099-01-01"),
    });
    mockPrismaUser.findUnique.mockResolvedValue({ email: "owner@test.com", name: "Owner Name" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValueOnce(false);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(429);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = createRequest("POST", "http://localhost/api/emergency-access");
    vi.spyOn(req, "json").mockRejectedValue(new Error("parse error"));
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid waitDays", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 5 },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for self-invite", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "owner@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate grant", async () => {
    mockPrismaGrant.findFirst.mockResolvedValue({ id: "existing" });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(409);
  });

  it("creates grant with hashed token and returns plaintext token", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe("grant-1");
    expect(json.token).toBe("mock-token-hex"); // plaintext token in response
    expect(json.status).toBe(EA_STATUS.PENDING);
    // DB stores hashed token
    expect(mockPrismaGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: "hashed-mock-token-hex",
        }),
      })
    );
    // Sends invite email to grantee
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grantee@test.com",
        subject: expect.stringContaining("緊急アクセスの招待"),
      })
    );
  });
});

describe("GET /api/emergency-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@test.com" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns grant list without token hash", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([
      {
        id: "grant-1",
        ownerId: "user-1",
        granteeId: null,
        granteeEmail: "grantee@test.com",
        status: EA_STATUS.PENDING,
        waitDays: 7,
        keyAlgorithm: "ECDH-P256",
        tokenHash: "hashed-tok",
        requestedAt: null,
        activatedAt: null,
        waitExpiresAt: null,
        revokedAt: null,
        createdAt: new Date("2025-01-01"),
        owner: { id: "user-1", name: "Owner", email: "user@test.com", image: null },
        grantee: null,
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("grant-1");
    // Token hash is never exposed in GET
    expect(json[0].token).toBeUndefined();
    expect(json[0].tokenHash).toBeUndefined();
  });
});