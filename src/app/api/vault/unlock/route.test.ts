import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockRateLimiter } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaVaultKey: { findUnique: vi.fn() },
  mockRateLimiter: { check: vi.fn(), clear: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));

import { POST } from "./route";

const AUTH_HASH = "a".repeat(64);
const SERVER_SALT = "b".repeat(64);
const SERVER_HASH = createHash("sha256")
  .update(AUTH_HASH + SERVER_SALT)
  .digest("hex");

function makeUnlockRequest(authHash: string = AUTH_HASH) {
  return createRequest("POST", "http://localhost:3000/api/vault/unlock", {
    body: { authHash },
  });
}

describe("POST /api/vault/unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: `user-${Date.now()}-${Math.random()}` } });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);
    mockRateLimiter.check.mockResolvedValue(true);
    mockRateLimiter.clear.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/vault/unlock", {
      body: { authHash: "short" },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(404);
  });

  it("returns 401 when authHash is wrong", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
    });
    const wrongHash = "f".repeat(64);
    const res = await POST(makeUnlockRequest(wrongHash));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.valid).toBe(false);
  });

  it("returns 200 with encrypted key on correct authHash", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      accountSalt: "salt",
      keyVersion: 1,
    });

    const res = await POST(makeUnlockRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.valid).toBe(true);
    expect(json.encryptedSecretKey).toBe("enc-key");
    expect(json.keyVersion).toBe(1);
  });

  it("returns verification artifact when vaultKey exists", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      accountSalt: "salt",
      keyVersion: 1,
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue({
      verificationCiphertext: "v-cipher",
      verificationIv: "v-iv",
      verificationAuthTag: "v-tag",
    });

    const res = await POST(makeUnlockRequest());
    const json = await res.json();
    expect(json.verificationArtifact).toEqual({
      ciphertext: "v-cipher",
      iv: "v-iv",
      authTag: "v-tag",
    });
  });

  it("returns 429 when rate limiter denies request", async () => {
    mockRateLimiter.check.mockResolvedValue(false);

    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(429);
  });

  it("clears rate limit on successful unlock", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      accountSalt: "salt",
      keyVersion: 1,
    });

    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(200);
    expect(mockRateLimiter.clear).toHaveBeenCalledWith(
      expect.stringContaining("rl:vault_unlock:")
    );
  });

  it("uses userId-only rate key (no IP)", async () => {
    const userId = "test-user-rate";
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockRateLimiter.check.mockResolvedValue(false);

    await POST(makeUnlockRequest());
    expect(mockRateLimiter.check).toHaveBeenCalledWith(`rl:vault_unlock:${userId}`);
  });
});
