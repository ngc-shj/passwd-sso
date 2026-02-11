import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaUser: {
    findUnique: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/crypto-emergency", () => ({
  SUPPORTED_WRAP_VERSIONS: new Set([1]),
  SUPPORTED_KEY_ALGORITHMS: { 1: ["ECDH-P256"] },
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const validBody = {
  ownerEphemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"abc","y":"def"}',
  encryptedSecretKey: "aabbccddeeff",
  secretKeyIv: "112233445566778899aabbcc",
  secretKeyAuthTag: "112233445566778899aabbccddeeff00",
  hkdfSalt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  wrapVersion: 1,
  keyVersion: 1,
};

describe("POST /api/emergency-access/[id]/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.ACCEPTED,
      keyAlgorithm: "ECDH-P256",
    });
    mockPrismaGrant.update.mockResolvedValue({});
    mockPrismaUser.findUnique.mockResolvedValue({ keyVersion: 3 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when not owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    mockPrismaUser.findUnique.mockResolvedValue({ keyVersion: 1 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when status is not ACCEPTED", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: EA_STATUS.IDLE,
      keyAlgorithm: "ECDH-P256",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when owner user not found in DB", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("USER_NOT_FOUND");
  });

  it("returns 400 for unsupported wrapVersion", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", {
        body: { ...validBody, wrapVersion: 999 },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when keyAlgorithm is incompatible with wrapVersion", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.ACCEPTED,
      keyAlgorithm: "UNKNOWN-ALG",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INCOMPATIBLE_KEY_ALGORITHM");
  });

  it("confirms key escrow using owner's server-side keyVersion", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.IDLE);
    expect(json.keyVersion).toBe(3);
    expect(mockPrismaGrant.update).toHaveBeenCalledWith({
      where: { id: "grant-1" },
      data: expect.objectContaining({
        status: EA_STATUS.IDLE,
        keyVersion: 3,
        wrapVersion: 1,
      }),
    });
  });

  it("ignores client-sent keyVersion and uses server value", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ keyVersion: 5 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", {
        body: { ...validBody, keyVersion: 99 },
      }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(5);
    expect(mockPrismaGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ keyVersion: 5 }),
      }),
    );
  });

  it("re-escrows STALE grant back to IDLE", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.STALE,
      keyAlgorithm: "ECDH-P256",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.IDLE);
    expect(json.keyVersion).toBe(3);
  });
});