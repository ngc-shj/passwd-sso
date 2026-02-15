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
});
