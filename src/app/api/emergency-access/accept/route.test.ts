import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaKeyPair, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaKeyPair: {
    create: vi.fn(),
  },
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    emergencyAccessKeyPair: mockPrismaKeyPair,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve(true) }),
}));

import { POST } from "./route";

const validBody = {
  token: "valid-token",
  granteePublicKey: '{"kty":"EC","crv":"P-256","x":"abc","y":"def"}',
  encryptedPrivateKey: {
    ciphertext: "aabbcc",
    iv: "112233445566778899aabbcc",
    authTag: "112233445566778899aabbccddeeff00",
  },
};

const validGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeEmail: "grantee@test.com",
  status: "PENDING",
  tokenExpiresAt: new Date("2099-01-01"),
};

describe("POST /api/emergency-access/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "grantee@test.com" } });
    mockPrismaGrant.findUnique.mockResolvedValue(validGrant);
    mockTransaction.mockResolvedValue([{}, {}]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when token invalid", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when invitation not PENDING", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...validGrant, status: "ACCEPTED" });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(410);
  });

  it("returns 410 when invitation expired", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      ...validGrant,
      tokenExpiresAt: new Date("2020-01-01"),
    });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(410);
  });

  it("returns 403 when email doesn't match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "other@test.com" } });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(403);
  });

  it("returns 400 when accepting own grant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "owner-1", email: "grantee@test.com" } });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(400);
  });

  it("accepts invitation successfully", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("ACCEPTED");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
