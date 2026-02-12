import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockExtTokenFindUnique, mockExtTokenUpdate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaVaultKey: { findUnique: vi.fn() },
  mockExtTokenFindUnique: vi.fn(),
  mockExtTokenUpdate: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
    extensionToken: { findUnique: mockExtTokenFindUnique, update: mockExtTokenUpdate },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));

import { GET } from "./route";

const req = () => createRequest("GET", "http://localhost/api/vault/unlock/data");
const reqWithAuth = (token: string) =>
  createRequest("GET", "http://localhost/api/vault/unlock/data", {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("GET /api/vault/unlock/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockExtTokenUpdate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("accepts extension token with vault:unlock-data scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue({
      id: "tok-1",
      userId: "token-user",
      scope: "vault:unlock-data",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      passphraseVerifierHmac: null,
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(reqWithAuth("a".repeat(64)));
    expect(res.status).toBe(200);
  });

  it("returns 403 when extension token lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue({
      id: "tok-2",
      userId: "token-user",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });

    const res = await GET(reqWithAuth("b".repeat(64)));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it("returns encrypted key data with verification artifact", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt-hex",
      encryptedSecretKey: "enc-key",
      secretKeyIv: "iv-hex",
      secretKeyAuthTag: "tag-hex",
      keyVersion: 1,
      passphraseVerifierHmac: null,
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
      hasVerifier: false,
      verificationArtifact: {
        ciphertext: "v-cipher",
        iv: "v-iv",
        authTag: "v-tag",
      },
    });
  });

  it("returns null verificationArtifact when vaultKey not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "salt",
      encryptedSecretKey: "key",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      keyVersion: 1,
    });
    mockPrismaVaultKey.findUnique.mockResolvedValue(null);

    const res = await GET(req());
    const json = await res.json();
    expect(json.verificationArtifact).toBeNull();
    expect(json.userId).toBe("test-user-id");
  });
});
