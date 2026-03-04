import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuthOrToken, mockPrismaUser, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuthOrToken: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth-or-token", () => ({ authOrToken: mockAuthOrToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GET /api/vault/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "test-user-id" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when scope insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when user not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
    expect(res.status).toBe(404);
  });

  it("returns setupRequired: true when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: null,
      accountSalt: null,
      keyVersion: 0,
      recoveryKeySetAt: null,
    });
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
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
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
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
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
    const json = await res.json();
    expect(json.hasRecoveryKey).toBe(true);
  });

  it("works with Bearer token auth", async () => {
    mockAuthOrToken.mockResolvedValue({
      type: "token",
      userId: "token-user-id",
      scopes: ["vault:unlock-data"],
    });
    mockPrismaUser.findUnique.mockResolvedValue({
      vaultSetupAt: new Date(),
      accountSalt: "b".repeat(64),
      keyVersion: 1,
      recoveryKeySetAt: null,
    });
    const res = await GET(new NextRequest("http://localhost/api/vault/status"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.accountSalt).toBe("b".repeat(64));
    expect(mockWithUserTenantRls).toHaveBeenCalledWith("token-user-id", expect.any(Function));
  });
});
