import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaVaultKey: { findUnique: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
  },
}));

import { GET } from "./route";

describe("GET /api/vault/unlock/data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await GET();
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

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({
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

    const res = await GET();
    const json = await res.json();
    expect(json.verificationArtifact).toBeNull();
  });
});
