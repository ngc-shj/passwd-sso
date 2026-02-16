import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaUser } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

describe("GET /api/vault/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/vault/status"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/vault/status"));
    expect(res.status).toBe(404);
  });

  it("returns setupRequired: true when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: null,
      accountSalt: null,
      keyVersion: 0,
      recoveryKeySetAt: null,
    });
    const res = await GET(new Request("http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({
      setupRequired: true,
      accountSalt: null,
      keyVersion: 0,
      hasRecoveryKey: false,
    });
  });

  it("returns setupRequired: false when vault is set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "a".repeat(64),
      keyVersion: 1,
      recoveryKeySetAt: null,
    });
    const res = await GET(new Request("http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.setupRequired).toBe(false);
    expect(json.accountSalt).toBe("a".repeat(64));
    expect(json.keyVersion).toBe(1);
    expect(json.hasRecoveryKey).toBe(false);
  });

  it("returns hasRecoveryKey: true when recovery key is set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "a".repeat(64),
      keyVersion: 1,
      recoveryKeySetAt: new Date(),
    });
    const res = await GET(new Request("http://localhost/api/vault/status"));
    const json = await res.json();
    expect(json.hasRecoveryKey).toBe(true);
  });
});
