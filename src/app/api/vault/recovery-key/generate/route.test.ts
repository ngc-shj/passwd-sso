import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockRateLimiter, mockLogAudit, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockRateLimiter: { check: vi.fn() },
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hmacVerifier: vi.fn((v: string) => `hmac_${v}`),
  verifyPassphraseVerifier: vi.fn((client: string, stored: string, _storedVersion: number) =>
    client === stored ? ({ ok: true } as const) : ({ ok: false, reason: "WRONG_PASSPHRASE" } as const)
  ),
}));
vi.mock("@/lib/crypto/verifier-version", () => ({
  VERIFIER_VERSION: 1,
  getCurrentVerifierVersion: () => 1,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { POST } from "./route";

const validBody = {
  currentVerifierHash: "a".repeat(64),
  encryptedSecretKey: "encrypted-recovery-data",
  secretKeyIv: "b".repeat(24),
  secretKeyAuthTag: "c".repeat(32),
  hkdfSalt: "d".repeat(64),
  verifierHash: "e".repeat(64),
};

const userWithVault = {
  vaultSetupAt: new Date(),
  passphraseVerifierHmac: "a".repeat(64),
  passphraseVerifierVersion: 1,
  recoveryVerifierVersion: 1,
  recoveryKeySetAt: null,
  recoveryKeyInvalidatedAt: null,
  tenantId: "test-tenant-id",
};

const URL = "http://localhost/api/vault/recovery-key/generate";

describe("POST /api/vault/recovery-key/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue({ allowed: true });
    mockPrismaUser.findUnique.mockResolvedValue(userWithVault);
    mockPrismaUser.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue({ allowed: false });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(429);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", URL, { body: { foo: "bar" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_SETUP");
  });

  it("returns 409 when verifier not set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: null,
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VERIFIER_NOT_SET");
  });

  it("forwards user.passphraseVerifierVersion (read from DB) to verifyPassphraseVerifier", async () => {
    const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
    const mockVerify = vi.mocked(verifyPassphraseVerifier);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierVersion: 999,
    });
    await POST(createRequest("POST", URL, { body: validBody }));
    expect(mockVerify).toHaveBeenCalledWith(
      validBody.currentVerifierHash,
      userWithVault.passphraseVerifierHmac,
      999,
    );
  });

  it("returns 401 when passphrase verification fails", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: "f".repeat(64),
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("saves recovery key data and logs RECOVERY_KEY_CREATED", async () => {
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          recoveryEncryptedSecretKey: validBody.encryptedSecretKey,
          recoverySecretKeyIv: validBody.secretKeyIv,
          recoverySecretKeyAuthTag: validBody.secretKeyAuthTag,
          recoveryHkdfSalt: validBody.hkdfSalt,
          recoveryVerifierHmac: `hmac_${validBody.verifierHash}`,
          recoveryVerifierVersion: VERIFIER_VERSION,
        }),
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RECOVERY_KEY_CREATED",
        userId: "user-1",
      }),
    );
  });

  it("logs RECOVERY_KEY_REGENERATED when recovery key already exists", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      recoveryKeySetAt: new Date("2025-01-01"),
      recoveryKeyInvalidatedAt: null,
    });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RECOVERY_KEY_REGENERATED",
      }),
    );
  });

  it("logs RECOVERY_KEY_REGENERATED when recovery was invalidated by rotation (#433/F21+S5)", async () => {
    // Post-rotation state: recoveryKeySetAt was cleared during rotation,
    // recoveryKeyInvalidatedAt was stamped. The user clicks regenerate.
    // Per F21 the action MUST be REGENERATED (not CREATED) so the audit
    // trail and dialog UX both reflect "lost via rotation, re-generating"
    // instead of first-time setup.
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: new Date(),
    });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RECOVERY_KEY_REGENERATED",
      }),
    );
  });

  it("emits VERIFIER_PEPPER_MISSING audit and returns 401 when pepper version is missing", async () => {
    const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
    vi.mocked(verifyPassphraseVerifier).mockReturnValueOnce({ ok: false, reason: "MISSING_PEPPER_VERSION" });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("INVALID_PASSPHRASE");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VERIFIER_PEPPER_MISSING",
        scope: "TENANT",
        userId: "user-1",
        tenantId: "test-tenant-id",
      }),
    );
  });
});
