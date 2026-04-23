import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));
const { mockWithBypassRls } = vi.hoisted(() => ({
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));
const {
  mockFindMany,
  mockCreate,
  mockUpdateMany,
  mockTransaction,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

const { mockTenantFindUnique } = vi.hoisted(() => ({
  mockTenantFindUnique: vi.fn().mockResolvedValue({ extensionTokenIdleTimeoutMinutes: 15 }),
}));
const { mockLogAuditAsync } = vi.hoisted(() => ({
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      create: mockCreate,
      update: mockUpdate,
      updateMany: mockUpdateMany,
    },
    tenant: { findUnique: mockTenantFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: (t: string) => `hashed_${t}`,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import {
  validateExtensionToken,
  parseScopes,
  hasScope,
  issueExtensionToken,
} from "./extension-token";

// ─── parseScopes ─────────────────────────────────────────────

describe("parseScopes", () => {
  it("parses valid CSV scopes", () => {
    expect(parseScopes("passwords:read,vault:unlock-data")).toEqual([
      "passwords:read",
      "vault:unlock-data",
    ]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseScopes(" passwords:read , , vault:unlock-data ")).toEqual([
      "passwords:read",
      "vault:unlock-data",
    ]);
  });

  it("drops unknown scopes", () => {
    expect(parseScopes("passwords:read,unknown:scope")).toEqual([
      "passwords:read",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseScopes("")).toEqual([]);
  });
});

// ─── hasScope ────────────────────────────────────────────────

describe("hasScope", () => {
  it("returns true when scope is present", () => {
    expect(hasScope(["passwords:read", "vault:unlock-data"], "passwords:read")).toBe(true);
  });

  it("returns false when scope is missing", () => {
    expect(hasScope(["passwords:read"], "vault:unlock-data")).toBe(false);
  });
});

// ─── validateExtensionToken ──────────────────────────────────

describe("validateExtensionToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
  });

  it("returns INVALID when no Authorization header", async () => {
    const req = createRequest("GET", "http://localhost/api/passwords");
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
  });

  it("returns INVALID when Authorization is not Bearer", async () => {
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Token ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
  });

  it("returns INVALID when token not found in DB", async () => {
    mockFindUnique.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
  });

  it("returns REVOKED when token is revoked", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: new Date("2025-01-01"),
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_REVOKED" });
  });

  it("returns EXPIRED when token is expired", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      scope: "passwords:read",
      expiresAt: new Date("2020-01-01"),
      revokedAt: null,
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_EXPIRED" });
  });

  it("returns ok with data for valid token", async () => {
    const expiresAt = new Date("2030-01-01");
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      scope: "passwords:read,vault:unlock-data",
      expiresAt,
      revokedAt: null,
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({
      ok: true,
      data: {
        tokenId: "t1",
        userId: "u1",
        scopes: ["passwords:read", "vault:unlock-data"],
        expiresAt,
      },
    });
  });

  it("updates lastUsedAt on valid token (best-effort)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    await validateExtensionToken(req);

    // Allow the void promise to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1" },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );
  });
});

// ─── issueExtensionToken ─────────────────────────────────────

describe("issueExtensionToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        extensionToken: {
          findMany: mockFindMany,
          create: mockCreate,
          updateMany: mockUpdateMany,
        },
      }),
    );
    mockFindMany.mockResolvedValue([]);
    mockCreate.mockResolvedValue({
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      scope: "passwords:read,vault:unlock-data",
    });
  });

  it("returns a 64-char hex token, expiresAt, and scopeCsv", async () => {
    const result = await issueExtensionToken({
      userId: "u1",
      tenantId: "t1",
      scope: "passwords:read,vault:unlock-data",
    });
    expect(result.token).toBe("a".repeat(64));
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.scopeCsv).toBe("passwords:read,vault:unlock-data");
  });

  it("creates the token via prisma.extensionToken.create with the hashed token", async () => {
    await issueExtensionToken({
      userId: "u1",
      tenantId: "t1",
      scope: "passwords:read",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          tenantId: "t1",
          tokenHash: "hashed_" + "a".repeat(64),
          scope: "passwords:read",
        }),
      }),
    );
  });

  it("revokes the oldest token when EXTENSION_TOKEN_MAX_ACTIVE is exceeded", async () => {
    mockFindMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }, { id: "t3" }]);
    await issueExtensionToken({
      userId: "u1",
      tenantId: "tenant-1",
      scope: "passwords:read",
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["t1"] } },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("does not revoke any tokens when count + 1 <= MAX", async () => {
    mockFindMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    await issueExtensionToken({
      userId: "u1",
      tenantId: "tenant-1",
      scope: "passwords:read",
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("invokes prisma.$transaction exactly once per call", async () => {
    await issueExtensionToken({
      userId: "u1",
      tenantId: "tenant-1",
      scope: "passwords:read",
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
