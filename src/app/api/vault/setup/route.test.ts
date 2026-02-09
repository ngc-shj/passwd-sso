import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaVaultKey: { create: vi.fn() },
  mockTransaction: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const validBody = {
  encryptedSecretKey: "encrypted-key-data",
  secretKeyIv: "a".repeat(24),
  secretKeyAuthTag: "b".repeat(32),
  accountSalt: "c".repeat(64),
  authHash: "d".repeat(64),
  verificationArtifact: {
    ciphertext: "verification-cipher",
    iv: "e".repeat(24),
    authTag: "f".repeat(32),
  },
};

describe("POST /api/vault/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
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
    expect(json.error).toBe("Vault already set up");
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
});
