import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockWithBypassRls, mockLogAuditAsync, mockPersonalAuditBase } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAuditAsync: vi.fn(),
  mockPersonalAuditBase: vi.fn((_, userId: string) => ({ scope: "PERSONAL", userId })),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  personalAuditBase: mockPersonalAuditBase,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve({ allowed: true }) }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { GET } from "./route";
import { EA_STATUS } from "@/lib/constants";

const activatedGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeId: "grantee-1",
  status: EA_STATUS.ACTIVATED,
  revokedAt: null,
  waitExpiresAt: null,
  ownerEphemeralPublicKey: '{"kty":"EC"}',
  encryptedSecretKey: "aabb",
  secretKeyIv: "112233445566778899aabbcc",
  secretKeyAuthTag: "112233445566778899aabbccddeeff00",
  hkdfSalt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  wrapVersion: 1,
  keyVersion: 1,
  keyAlgorithm: "ECDH-P256",
  granteeKeyPair: {
    encryptedPrivateKey: "ccdd",
    privateKeyIv: "112233445566778899aabbcc",
    privateKeyAuthTag: "112233445566778899aabbccddeeff00",
  },
  owner: { name: "Owner", email: "owner@test.com" },
};

describe("GET /api/emergency-access/[id]/vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue(activatedGrant);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not grantee", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not ACTIVATED", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      ...activatedGrant,
      status: EA_STATUS.IDLE,
      waitExpiresAt: null,
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when grant is STALE", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      ...activatedGrant,
      status: EA_STATUS.STALE,
      waitExpiresAt: null,
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("auto-activates when wait period expired (CAS path)", async () => {
    // First findUnique (route's initial load): returns REQUESTED grant with elapsed waitExpiresAt
    // Second findUnique (autoPromoteIfElapsed eligibility): same REQUESTED grant
    // Third findUnique (autoPromoteIfElapsed post-promotion refetch): returns ACTIVATED grant
    const requestedGrant = {
      ...activatedGrant,
      status: EA_STATUS.REQUESTED,
      waitExpiresAt: new Date("2020-01-01"),
    };
    mockPrismaGrant.findUnique
      .mockResolvedValueOnce(requestedGrant)  // route initial load
      .mockResolvedValueOnce({ status: EA_STATUS.REQUESTED, waitExpiresAt: new Date("2020-01-01"), granteeId: "grantee-1" }) // eligibility check
      .mockResolvedValueOnce({ ...activatedGrant, status: EA_STATUS.ACTIVATED }); // post-promotion refetch
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 1 });

    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    expect(mockPrismaGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: EA_STATUS.ACTIVATED }),
      })
    );
  });

  it("returns ECDH data when ACTIVATED", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.grantId).toBe("grant-1");
    expect(json.ownerId).toBe("owner-1");
    expect(json.granteeId).toBe("grantee-1");
    expect(json.ownerEphemeralPublicKey).toBeTruthy();
    expect(json.encryptedSecretKey).toBeTruthy();
    expect(json.hkdfSalt).toBeTruthy();
    expect(json.wrapVersion).toBe(1);
    expect(json.keyVersion).toBe(1);
    expect(json.granteeKeyPair).toBeTruthy();
    expect(mockWithBypassRls).toHaveBeenCalled();
  });

  it("returns 403 with GRANT_REVOKED when promoted grant was revoked concurrently", async () => {
    const requestedGrant = {
      ...activatedGrant,
      status: EA_STATUS.REQUESTED,
      waitExpiresAt: new Date("2020-01-01"),
    };
    // eligibility passes, transition succeeds, but refetch shows revokedAt set
    mockPrismaGrant.findUnique
      .mockResolvedValueOnce(requestedGrant)  // route initial load
      .mockResolvedValueOnce({ status: EA_STATUS.REQUESTED, waitExpiresAt: new Date("2020-01-01"), granteeId: "grantee-1" }) // eligibility check
      .mockResolvedValueOnce({ ...activatedGrant, status: EA_STATUS.ACTIVATED, revokedAt: new Date() }); // refetch — revoked
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 1 });

    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });
});
