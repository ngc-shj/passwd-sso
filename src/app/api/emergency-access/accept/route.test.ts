import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockPrismaGrant,
  mockPrismaUser,
  mockTxGrantUpdateMany,
  mockTxKeyPairCreate,
  mockSendEmail,
  mockWithBypassRls,
  mockCheck,
  mockCreateRateLimiter,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockAuth: vi.fn(),
    mockPrismaGrant: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    mockPrismaUser: { findUnique: vi.fn() },
    mockTxGrantUpdateMany: vi.fn(),
    mockTxKeyPairCreate: vi.fn(),
    mockSendEmail: vi.fn(),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockCheck,
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockCheck, clear: vi.fn() })),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    emergencyAccessKeyPair: { create: mockTxKeyPairCreate },
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hashed-${t}`,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

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
  status: EA_STATUS.PENDING,
  tokenExpiresAt: new Date("2099-01-01"),
  tokenHash: "hashed-valid-token",
};

describe("POST /api/emergency-access/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "grantee@test.com" } });
    mockPrismaGrant.findUnique.mockResolvedValue(validGrant);
    mockTxGrantUpdateMany.mockResolvedValue({ count: 1 });
    // transition({ db: tx }) runs directly on the withBypassRls callback's tx
    // (the mocked prisma), so the CAS updateMany lands on mockPrismaGrant.
    mockPrismaGrant.updateMany.mockImplementation((...args) => mockTxGrantUpdateMany(...args));
    mockTxKeyPairCreate.mockResolvedValue({});
    mockPrismaUser.findUnique.mockResolvedValue({ email: "owner@test.com", name: "Owner Name" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(401);
  });

  it("looks up grant by tokenHash", async () => {
    await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(mockPrismaGrant.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: "hashed-valid-token" },
    });
  });

  it("returns 404 when token invalid", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when CAS finds no still-PENDING row (invitation already used)", async () => {
    mockTxGrantUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
      body: validBody,
    }));
    expect(res.status).toBe(410);
    expect(mockTxKeyPairCreate).not.toHaveBeenCalled();
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
    expect(json.status).toBe(EA_STATUS.ACCEPTED);
    // Atomicity: the CAS transition + escrow keyPair.create run inside one
    // withBypassRls scope (findUnique + CAS + owner lookup = 3 calls).
    expect(mockWithBypassRls).toHaveBeenCalled();
    expect(mockTxGrantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "grant-1",
          tokenHash: "hashed-valid-token",
          status: { in: expect.arrayContaining([EA_STATUS.PENDING]) },
        }),
        data: expect.objectContaining({ status: EA_STATUS.ACCEPTED }),
      }),
    );
    expect(mockTxKeyPairCreate).toHaveBeenCalled();
    // Sends accepted email to owner
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@test.com",
        subject: expect.stringContaining("accepted"),
      })
    );
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(createRequest("POST", "http://localhost/api/emergency-access/accept", {
          body: validBody,
        })),
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockTxKeyPairCreate, mockTxGrantUpdateMany],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
