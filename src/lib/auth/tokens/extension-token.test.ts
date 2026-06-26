import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockFindUnique, mockTenantMemberFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  // C13: active membership by default so existing valid-token tests pass.
  mockTenantMemberFindUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
}));
const { mockWithBypassRls } = vi.hoisted(() => ({
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
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

// Mock the shared DPoP helper to keep validateExtensionToken tests focused
// on dispatch/routing, not DPoP verification internals (those are covered
// by validate-token-dpop.test.ts and mobile-token.test.ts).
const { mockValidateTokenDpop } = vi.hoisted(() => ({
  mockValidateTokenDpop: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      create: mockCreate,
      updateMany: mockUpdateMany,
    },
    tenant: { findUnique: mockTenantFindUnique },
    // C13: tenantMember mock; active by default so existing tests pass.
    tenantMember: { findUnique: mockTenantMemberFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
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
vi.mock("@/lib/auth/dpop/validate-token-dpop", () => ({
  validateExtensionTokenDpop: mockValidateTokenDpop,
}));

import {
  validateExtensionToken,
  parseScopes,
  hasScope,
  issueExtensionToken,
} from "./extension-token";
import { EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const VALID_CNF_JKT = "A".repeat(43);
const FAMILY_ID = "fam-00000000-0000-4000-8000-000000000001";

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
    // C13: restore active-membership default after each test clears mocks.
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: null });
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
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: new Date("2025-01-01"),
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
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
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2020-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_EXPIRED" });
  });

  it("returns INVALID when BROWSER_EXTENSION row has null cnfJkt (post-migration invariant violation)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: null,
    });
    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    expect(mockValidateTokenDpop).not.toHaveBeenCalled();
  });

  it("dispatches BROWSER_EXTENSION to validateExtensionTokenDpop and returns ok on success", async () => {
    const expiresAt = new Date("2030-01-01");
    const familyCreatedAt = new Date();
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read,vault:unlock-data",
      expiresAt,
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt,
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "t1",
        userId: "u1",
        tenantId: "ten1",
        scopes: ["passwords:read", "vault:unlock-data"],
        expiresAt,
        familyId: FAMILY_ID,
        familyCreatedAt,
        cnfJkt: VALID_CNF_JKT,
      },
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        DPoP: "valid.dpop.proof",
      },
    });
    const result = await validateExtensionToken(req);

    expect(mockValidateTokenDpop).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cnfJkt).toBe(VALID_CNF_JKT);
    }
  });

  it("returns EXTENSION_TOKEN_DPOP_INVALID when BROWSER_EXTENSION DPoP fails", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: "DPOP_HEADER_MISSING",
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: "DPOP_HEADER_MISSING",
    });
  });

  it("dispatches IOS_AUTOFILL through the DPoP-required path (S-C1: no bearer-only bypass)", async () => {
    const expiresAt = new Date("2030-01-01");
    const familyCreatedAt = new Date();
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:write",
      expiresAt,
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt,
      clientKind: "IOS_AUTOFILL",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "t1",
        userId: "u1",
        tenantId: "ten1",
        scopes: ["passwords:write"],
        expiresAt,
        familyId: FAMILY_ID,
        familyCreatedAt,
        cnfJkt: VALID_CNF_JKT,
        clientKind: "IOS_AUTOFILL",
      },
    });

    const req = createRequest("POST", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}`, DPoP: "valid.dpop.proof" },
    });
    const result = await validateExtensionToken(req);

    expect(mockValidateTokenDpop).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scopes).toEqual(["passwords:write"]);
      expect(result.data.clientKind).toBe("IOS_AUTOFILL");
    }
  });

  it("returns INVALID for IOS_AUTOFILL when the DPoP proof is absent/invalid (no bypass)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:write",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "IOS_AUTOFILL",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: "DPOP_HEADER_MISSING",
    });

    const req = createRequest("POST", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);

    expect(mockValidateTokenDpop).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("returns INVALID for IOS_APP with null cnfJkt without calling DPoP helper", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "IOS_APP",
      cnfJkt: null,
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    expect(mockValidateTokenDpop).not.toHaveBeenCalled();
  });

  it("dispatches IOS_APP to validateExtensionTokenDpop and maps success", async () => {
    const expiresAt = new Date("2030-01-01");
    const familyCreatedAt = new Date();
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt,
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt,
      clientKind: "IOS_APP",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "t1",
        userId: "u1",
        tenantId: "ten1",
        scopes: ["passwords:read"],
        expiresAt,
        familyId: FAMILY_ID,
        familyCreatedAt,
        cnfJkt: VALID_CNF_JKT,
      },
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        DPoP: "valid.dpop.proof",
      },
    });
    const result = await validateExtensionToken(req);

    expect(mockValidateTokenDpop).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("maps IOS_APP DPoP failure to EXTENSION_TOKEN_INVALID (backward-compat)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "IOS_APP",
      cnfJkt: VALID_CNF_JKT,
    });
    mockValidateTokenDpop.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: "DPOP_SIG_INVALID",
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    // IOS_APP callers expect EXTENSION_TOKEN_INVALID for source-compat.
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
  });

  // ── C13: deactivated-user rejection ───────────────────────
  //
  // L2 — SCIM deactivation fail-open backstop: SCIM deactivation calls
  // invalidateUserSessions, which sets revokedAt on this extension token. If that
  // throws (the SCIM handler logs + returns 200 — a fail-open window), revokedAt
  // stays null. C13(a) below IS that scenario: revokedAt:null (token never
  // revoked) + member deactivated → EXTENSION_TOKEN_INVALID via the membership
  // check alone, BEFORE DPoP dispatch. This is what makes the SCIM fail-open safe.

  it("C13(a): deactivated-in-token-tenant ⇒ EXTENSION_TOKEN_INVALID (BROWSER_EXTENSION)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    // DPoP helper must NOT be called — rejected before dispatch
    expect(mockValidateTokenDpop).not.toHaveBeenCalled();
  });

  it("C13(b): deactivated in token tenant (cross-tenant guard) ⇒ EXTENSION_TOKEN_INVALID", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    // The lookup is scoped to the token's tenantId — a deactivated row there is invalid
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    expect(mockTenantMemberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_userId: { tenantId: "ten1", userId: "u1" } },
      }),
    );
  });

  it("C13(c): active membership ⇒ passes deactivation check (BROWSER_EXTENSION)", async () => {
    const expiresAt = new Date("2030-01-01");
    const familyCreatedAt = new Date();
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt,
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt,
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: null });
    mockValidateTokenDpop.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "t1",
        userId: "u1",
        tenantId: "ten1",
        scopes: ["passwords:read"],
        expiresAt,
        familyId: FAMILY_ID,
        familyCreatedAt,
        cnfJkt: VALID_CNF_JKT,
      },
    });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        DPoP: "valid.dpop.proof",
      },
    });
    const result = await validateExtensionToken(req);
    expect(result.ok).toBe(true);
  });

  it("C13 IOS_APP path: deactivated-in-token-tenant ⇒ EXTENSION_TOKEN_INVALID", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "IOS_APP",
      cnfJkt: VALID_CNF_JKT,
    });
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    // DPoP helper must NOT be called
    expect(mockValidateTokenDpop).not.toHaveBeenCalled();
  });

  it("C13 no-membership (fail-closed) ⇒ EXTENSION_TOKEN_INVALID", async () => {
    mockFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      tenantId: "ten1",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(),
      clientKind: "BROWSER_EXTENSION",
      cnfJkt: VALID_CNF_JKT,
    });
    mockTenantMemberFindUnique.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    const result = await validateExtensionToken(req);
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
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
      cnfJkt: VALID_CNF_JKT,
    });
  });

  it("returns a 64-char token, expiresAt, scopeCsv, and cnfJkt", async () => {
    const result = await issueExtensionToken({
      userId: "u1",
      tenantId: "t1",
      scope: "passwords:read,vault:unlock-data",
      cnfJkt: VALID_CNF_JKT,
    });
    expect(result.token).toBe("a".repeat(64));
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.scopeCsv).toBe("passwords:read,vault:unlock-data");
    expect(result.cnfJkt).toBe(VALID_CNF_JKT);
  });

  it("creates the token via prisma.extensionToken.create with the hashed token and cnfJkt", async () => {
    await issueExtensionToken({
      userId: "u1",
      tenantId: "t1",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          tenantId: "t1",
          tokenHash: "hashed_" + "a".repeat(64),
          scope: "passwords:read",
          cnfJkt: VALID_CNF_JKT,
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
      cnfJkt: VALID_CNF_JKT,
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
      cnfJkt: VALID_CNF_JKT,
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("invokes prisma.$transaction exactly once per call", async () => {
    await issueExtensionToken({
      userId: "u1",
      tenantId: "tenant-1",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("falls back to EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT when tenant.extensionTokenIdleTimeoutMinutes is null", async () => {
    mockTenantFindUnique.mockResolvedValueOnce({ extensionTokenIdleTimeoutMinutes: null });

    const before = Date.now();
    await issueExtensionToken({
      userId: "u1",
      tenantId: "t1",
      scope: "passwords:read",
      cnfJkt: VALID_CNF_JKT,
    });
    const after = Date.now();

    expect(mockCreate).toHaveBeenCalled();
    const callArg = mockCreate.mock.calls[0]?.[0] as { data: { expiresAt: Date } };
    const expiresAtMs = callArg.data.expiresAt.getTime();

    // expiresAt MUST equal `now + EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT min` (±small window).
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT * MS_PER_MINUTE);
    expect(expiresAtMs).toBeLessThanOrEqual(after + EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT * MS_PER_MINUTE);
  });
});
