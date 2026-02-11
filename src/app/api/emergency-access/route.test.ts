import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant },
}));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "mock-token-hex",
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve(true) }),
}));

import { POST, GET } from "./route";

describe("POST /api/emergency-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1", email: "owner@test.com" } });
    mockPrismaGrant.findFirst.mockResolvedValue(null);
    mockPrismaGrant.create.mockResolvedValue({
      id: "grant-1",
      token: "mock-token-hex",
      status: "PENDING",
      granteeEmail: "grantee@test.com",
      waitDays: 7,
      tokenExpiresAt: new Date("2099-01-01"),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(401);
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

  it("creates grant successfully", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBe("grant-1");
    expect(json.token).toBe("mock-token-hex");
    expect(json.status).toBe("PENDING");
    expect(mockPrismaGrant.create).toHaveBeenCalledTimes(1);
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

  it("returns grant list", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([
      {
        id: "grant-1",
        ownerId: "user-1",
        granteeId: null,
        granteeEmail: "grantee@test.com",
        status: "PENDING",
        waitDays: 7,
        keyAlgorithm: "ECDH-P256",
        token: "tok",
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
    expect(json[0].token).toBe("tok"); // owner sees token for PENDING
  });
});
