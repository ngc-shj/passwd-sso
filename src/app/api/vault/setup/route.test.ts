import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockTransaction, mockRateLimiter } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaVaultKey: { create: vi.fn() },
  mockTransaction: vi.fn(),
  mockRateLimiter: { check: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/crypto-server", () => ({
  hmacVerifier: vi.fn().mockReturnValue("a".repeat(64)),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const validBody = {
  encryptedSecretKey: "encrypted-key-data",
  secretKeyIv: "a".repeat(24),
  secretKeyAuthTag: "b".repeat(32),
  accountSalt: "c".repeat(64),
  authHash: "d".repeat(64),
  verifierHash: "a".repeat(64),
  verificationArtifact: {
    ciphertext: "verification-cipher",
    iv: "e".repeat(24),
    authTag: "f".repeat(32),
  },
  // ECDH key pair for org E2E
  ecdhPublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
  encryptedEcdhPrivateKey: "encrypted-ecdh-private-key-data",
  ecdhPrivateKeyIv: "a".repeat(24),
  ecdhPrivateKeyAuthTag: "b".repeat(32),
};

describe("POST /api/vault/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRateLimiter.check.mockResolvedValue(true);
    mockTransaction.mockResolvedValue([{}, {}]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: validBody }));
    expect(res.status).toBe(401);
  });

  it("returns 409 when vault already set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: new Date() });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: validBody }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VAULT_ALREADY_SETUP");
  });

  it("returns 400 on malformed JSON", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/vault/setup", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: { authHash: "short" } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when secretKeyIv has wrong length", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", {
      body: { ...validBody, secretKeyIv: "short" },
    }));
    expect(res.status).toBe(400);
  });

  it("creates vault successfully (201)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: validBody }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("stores ECDH key pair fields in user update", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: validBody }));
    expect(res.status).toBe(201);

    // Verify user.update was called with ECDH fields
    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ecdhPublicKey: validBody.ecdhPublicKey,
          encryptedEcdhPrivateKey: validBody.encryptedEcdhPrivateKey,
          ecdhPrivateKeyIv: validBody.ecdhPrivateKeyIv,
          ecdhPrivateKeyAuthTag: validBody.ecdhPrivateKeyAuthTag,
        }),
      }),
    );
  });

  it("returns 400 when ECDH fields are missing", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const { ecdhPublicKey, encryptedEcdhPrivateKey, ecdhPrivateKeyIv, ecdhPrivateKeyAuthTag, ...bodyWithoutEcdh } = validBody;
    void ecdhPublicKey; void encryptedEcdhPrivateKey; void ecdhPrivateKeyIv; void ecdhPrivateKeyAuthTag;
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", { body: bodyWithoutEcdh }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when ecdhPrivateKeyIv has wrong format", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/setup", {
      body: { ...validBody, ecdhPrivateKeyIv: "short" },
    }));
    expect(res.status).toBe(400);
  });
});
