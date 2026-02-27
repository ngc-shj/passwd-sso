import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockPrismaVaultKey, mockTransaction, mockMarkStale, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaVaultKey: {
    create: vi.fn(),
  },
  mockTransaction: vi.fn(),
  mockMarkStale: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    vaultKey: mockPrismaVaultKey,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/emergency-access-server", () => ({
  markGrantsStaleForOwner: mockMarkStale,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve(true), clear: vi.fn() }),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { createHash } from "crypto";
import { POST } from "./route";

const serverSalt = "a".repeat(64);
const currentAuthHash = "b".repeat(64);
const serverHash = createHash("sha256")
  .update(currentAuthHash + serverSalt)
  .digest("hex");

const validBody = {
  currentAuthHash,
  encryptedSecretKey: "new-encrypted-key",
  secretKeyIv: "c".repeat(24),
  secretKeyAuthTag: "d".repeat(32),
  accountSalt: "e".repeat(64),
  newAuthHash: "f".repeat(64),
  verificationArtifact: {
    ciphertext: "verify-cipher",
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
  },
};

describe("POST /api/vault/rotate-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      keyVersion: 1,
    });
    mockTransaction.mockResolvedValue([]);
    mockMarkStale.mockResolvedValue(0);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 for wrong current passphrase", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { ...validBody, currentAuthHash: "0".repeat(64) },
      })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/vault/rotate-key", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", {
        body: { currentAuthHash: "short" },
      })
    );
    expect(res.status).toBe(400);
  });

  it("rotates key successfully and bumps keyVersion", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.keyVersion).toBe(2);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("calls markGrantsStaleForOwner with new keyVersion", async () => {
    await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(mockMarkStale).toHaveBeenCalledWith("user-1", 2);
  });

  it("succeeds even if markGrantsStaleForOwner fails", async () => {
    mockMarkStale.mockRejectedValue(new Error("DB error"));
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    expect(res.status).toBe(200);
  });

  it("increments keyVersion from current value", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      keyVersion: 5,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/vault/rotate-key", { body: validBody })
    );
    const json = await res.json();
    expect(json.keyVersion).toBe(6);
    expect(mockMarkStale).toHaveBeenCalledWith("user-1", 6);
  });
});
