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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import {
  validateExtensionToken,
  parseScopes,
  hasScope,
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
