import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockPrismaUser,
  mockPrismaVaultKey,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaVaultKey: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

function authOk(userId = "test-user-id", type = "session") {
  const auth = type === "token"
    ? { type, userId, scopes: [] as string[] }
    : { type, userId };
  return { ok: true, auth };
}

function authFail(status = 401, error = "UNAUTHORIZED") {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

const req = () => createRequest("GET", "http://localhost/api/vault/unlock/data");

describe("GET /api/vault/unlock/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue(authOk());
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("accepts extension token with vault:unlock-data scope", async () => {
    mockCheckAuth.mockResolvedValue(authOk("token-user", "token"));
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      passphraseVerifierHmac: null,
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("returns 403 when extension token lacks required scope", async () => {
    mockCheckAuth.mockResolvedValue(
      authFail(403, "EXTENSION_TOKEN_SCOPE_INSUFFICIENT"),
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it("returns encrypted key data with verification artifact and ECDH fields", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      passphraseVerifierHmac: null,
      ecdhPublicKey: "ecdh-pub-jwk",
      encryptedEcdhPrivateKey: "ecdh-priv-enc",
      ecdhPrivateKeyIv: "ecdh-iv",
      ecdhPrivateKeyAuthTag: "ecdh-tag",
      tenant: { vaultAutoLockMinutes: 10 },
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue({
      verificationCiphertext: "v-cipher",
      verificationIv: "v-iv",
      verificationAuthTag: "v-tag",
    });

    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({
      userId: "test-user-id",
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
      hasVerifier: false,
      verificationArtifact: {
        ciphertext: "v-cipher",
        iv: "v-iv",
        authTag: "v-tag",
      },
      ecdhPublicKey: "ecdh-pub-jwk",
      encryptedEcdhPrivateKey: "ecdh-priv-enc",
      ecdhPrivateKeyIv: "ecdh-iv",
      ecdhPrivateKeyAuthTag: "ecdh-tag",
      vaultAutoLockMinutes: 10,
    });
  });

  it("includes ECDH fields when using extension token", async () => {
    mockCheckAuth.mockResolvedValue(authOk("token-user", "token"));
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      passphraseVerifierHmac: null,
      ecdhPublicKey: "ecdh-pub",
      encryptedEcdhPrivateKey: "ecdh-priv-enc",
      ecdhPrivateKeyIv: "ecdh-iv",
      ecdhPrivateKeyAuthTag: "ecdh-tag",
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ecdhPublicKey).toBe("ecdh-pub");
    expect(json.encryptedEcdhPrivateKey).toBe("ecdh-priv-enc");
    expect(json.ecdhPrivateKeyIv).toBe("ecdh-iv");
    expect(json.ecdhPrivateKeyAuthTag).toBe("ecdh-tag");
  });

  it("returns hasVerifier: true when passphraseVerifierHmac is set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
      passphraseVerifierHmac: "some-hmac-value",
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.hasVerifier).toBe(true);
  });

  it("returns null verificationArtifact when vaultKey not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt",
      encryptedSecretKey: "key",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      keyVersion: 1,
      kdfType: 0,
      kdfIterations: 600_000,
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(req());
    const json = await res.json();
    expect(json.verificationArtifact).toBeNull();
    expect(json.userId).toBe("test-user-id");
  });
});
