import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaUser,
  mockPrismaVaultKey,
  mockRateLimiter,
  mockCheckLockout,
  mockRecordFailure,
  mockResetLockout,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), updateMany: vi.fn() },
  mockPrismaVaultKey: { findUnique: vi.fn() },
  mockRateLimiter: { check: vi.fn(), clear: vi.fn() },
  mockCheckLockout: vi.fn(),
  mockRecordFailure: vi.fn(),
  mockResetLockout: vi.fn(),
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
vi.mock("@/lib/crypto-server", () => ({
  hmacVerifier: vi.fn().mockReturnValue("a".repeat(64)),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/account-lockout", () => ({
  checkLockout: mockCheckLockout,
  recordFailure: mockRecordFailure,
  resetLockout: mockResetLockout,
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
    mockCheckLockout.mockResolvedValue({ locked: false, lockedUntil: null });
    mockRecordFailure.mockResolvedValue({ locked: false, lockedUntil: null, attempts: 1 });
    mockResetLockout.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/vault/unlock", {
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

  // ── Account Lockout tests ──────────────────────────────────

  it("returns 403 when account is locked (rate limiter not called)", async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    mockCheckLockout.mockResolvedValue({ locked: true, lockedUntil });

    const res = await POST(makeUnlockRequest());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("ACCOUNT_LOCKED");
    expect(json.lockedUntil).toBe(lockedUntil.toISOString());
    // Rate limiter should NOT be called when locked out
    expect(mockRateLimiter.check).not.toHaveBeenCalled();
  });

  it("calls recordFailure on wrong passphrase", async () => {
    const userId = "user-fail-test";
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
    });

    const res = await POST(makeUnlockRequest("f".repeat(64)));
    expect(res.status).toBe(401);
    expect(mockRecordFailure).toHaveBeenCalledWith(userId, expect.anything());
  });

  it("returns 403 when recordFailure indicates lockout", async () => {
    const lockedUntil = new Date(Date.now() + 900_000);
    mockRecordFailure.mockResolvedValue({ locked: true, lockedUntil, attempts: 5 });
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
    });

    const res = await POST(makeUnlockRequest("f".repeat(64)));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("ACCOUNT_LOCKED");
  });

  it("returns 503 with Retry-After when recordFailure returns null (lock_timeout)", async () => {
    mockRecordFailure.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: SERVER_HASH,
      masterPasswordServerSalt: SERVER_SALT,
    });

    const res = await POST(makeUnlockRequest("f".repeat(64)));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("calls resetLockout on successful unlock", async () => {
    const userId = "user-success-test";
    mockAuth.mockResolvedValue({ user: { id: userId } });
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
    expect(mockResetLockout).toHaveBeenCalledWith(userId);
  });

  it("returns 200 even if resetLockout fails", async () => {
    mockResetLockout.mockRejectedValue(new Error("reset error"));
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
    expect(mockResetLockout).toHaveBeenCalled();
  });
});
