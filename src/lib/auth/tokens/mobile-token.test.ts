import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { DPOP_VERIFY_ERROR } from "@/lib/auth/dpop/verify";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockExtFindMany,
  mockExtCreate,
  mockExtUpdate,
  mockExtUpdateMany,
  mockTransaction,
  mockWithBypassRls,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockExtFindMany: vi.fn(),
  mockExtCreate: vi.fn(),
  mockExtUpdate: vi.fn(),
  mockExtUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockWithUserTenantRls: vi.fn(async (_u: string, fn: () => unknown) => fn()),
}));

const { mockVerifyDpop, mockGetJtiCache } = vi.hoisted(() => ({
  mockVerifyDpop: vi.fn(),
  mockGetJtiCache: vi.fn(() => ({ hasOrRecord: vi.fn().mockResolvedValue(false) })),
}));

const { mockLogAuditAsync, mockRevokeFamily } = vi.hoisted(() => ({
  mockLogAuditAsync: vi.fn(),
  mockRevokeFamily: vi.fn().mockResolvedValue({ rowsRevoked: 0 }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findMany: mockExtFindMany,
      create: mockExtCreate,
      update: mockExtUpdate,
      updateMany: mockExtUpdateMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/crypto/crypto-server", () => {
  let counter = 0;
  return {
    generateShareToken: () => {
      counter += 1;
      return `tok_${counter}_` + "x".repeat(60 - String(counter).length);
    },
    hashToken: (t: string) => `hashed_${t}`,
  };
});

vi.mock("@/lib/auth/dpop/verify", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyDpopProof: mockVerifyDpop,
}));

vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: mockGetJtiCache,
}));

vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  logAuditAsync: mockLogAuditAsync,
}));

vi.mock("./extension-token", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  revokeExtensionTokenFamily: mockRevokeFamily,
}));

// ─── Now import the module under test ────────────────────────

import {
  issueIosToken,
  validateIosTokenDpop,
  refreshIosToken,
  IOS_TOKEN_IDLE_TIMEOUT_MS,
  IOS_TOKEN_ABSOLUTE_TIMEOUT_MS,
  REFRESH_REPLAY_GRACE_MS,
  _resetRotationCacheForTests,
} from "./mobile-token";

// ─── Shared test fixtures ────────────────────────────────────

const USER_ID = "00000000-0000-4000-8000-000000000001";
const TENANT_ID = "00000000-0000-4000-8000-000000000002";
const FAMILY_ID = "00000000-0000-4000-8000-000000000003";
const DEVICE_PUBKEY = "MFkwEw…fakeDER…AQAB";
const CNF_JKT = "abc123fakeJktThumbprint";

function setupTransactionPassthrough() {
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      extensionToken: {
        findMany: mockExtFindMany,
        create: mockExtCreate,
        updateMany: mockExtUpdateMany,
      },
    }),
  );
}

function happyAccessRowResponse(overrides: Partial<{ id: string }> = {}) {
  return {
    id: overrides.id ?? "row-access-1",
    expiresAt: new Date(Date.now() + IOS_TOKEN_IDLE_TIMEOUT_MS),
    familyId: FAMILY_ID,
    familyCreatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupTransactionPassthrough();
  mockExtFindMany.mockResolvedValue([]);
  mockExtCreate.mockResolvedValue(happyAccessRowResponse());
  mockExtUpdate.mockResolvedValue({});
  mockExtUpdateMany.mockResolvedValue({ count: 0 });
  mockGetJtiCache.mockReturnValue({
    hasOrRecord: vi.fn().mockResolvedValue(false),
  });
  mockRevokeFamily.mockResolvedValue({ rowsRevoked: 1 });
  _resetRotationCacheForTests();
});

// ─── issueIosToken ───────────────────────────────────────────

describe("issueIosToken", () => {
  it("creates an IOS_APP row with cnfJkt + devicePubkey + IOS scopes", async () => {
    const result = await issueIosToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
      ip: "1.2.3.4",
      userAgent: "TestAgent/1.0",
    });

    expect(result.accessToken).toMatch(/^tok_/);
    expect(result.refreshToken).toMatch(/^tok_/);
    expect(result.accessToken).not.toBe(result.refreshToken);
    expect(result.familyId).toBeTruthy();
    expect(result.tokenId).toBe("row-access-1");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // First .create call = access row.
    expect(mockExtCreate).toHaveBeenCalledTimes(2);
    const accessCall = mockExtCreate.mock.calls[0][0];
    expect(accessCall.data).toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      clientKind: "IOS_APP",
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
      lastUsedIp: "1.2.3.4",
      lastUsedUserAgent: "TestAgent/1.0",
      scope: "passwords:read,passwords:write,vault:unlock-data",
    });

    const refreshCall = mockExtCreate.mock.calls[1][0];
    expect(refreshCall.data.clientKind).toBe("IOS_APP");
    expect(refreshCall.data.tokenHash).not.toBe(accessCall.data.tokenHash);
  });

  it("generates a new familyId when none is provided", async () => {
    const result = await issueIosToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });
    expect(result.familyId).toBeTruthy();
    expect(typeof result.familyId).toBe("string");
  });

  it("preserves familyId + familyCreatedAt when provided (refresh-rotation path)", async () => {
    const existingFamilyCreatedAt = new Date("2026-04-01T00:00:00.000Z");
    mockExtCreate.mockResolvedValueOnce({
      id: "row-access-2",
      expiresAt: new Date(),
      familyId: FAMILY_ID,
      familyCreatedAt: existingFamilyCreatedAt,
    });

    await issueIosToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
      familyId: FAMILY_ID,
      familyCreatedAt: existingFamilyCreatedAt,
    });

    const accessCall = mockExtCreate.mock.calls[0][0];
    expect(accessCall.data.familyId).toBe(FAMILY_ID);
    expect(accessCall.data.familyCreatedAt).toEqual(existingFamilyCreatedAt);
  });

  it("revokes oldest active rows when issuing would exceed EXTENSION_TOKEN_MAX_ACTIVE", async () => {
    // EXTENSION_TOKEN_MAX_ACTIVE = 3, and an iOS issuance creates 2 rows.
    // With 2 already active, +2 new = 4 > 3 → revoke 1 oldest.
    mockExtFindMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);

    await issueIosToken({
      userId: USER_ID,
      tenantId: TENANT_ID,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });

    expect(mockExtUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["old-1"] } },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });
});

// ─── validateIosTokenDpop ────────────────────────────────────

describe("validateIosTokenDpop", () => {
  const baseRow = {
    id: "row-1",
    userId: USER_ID,
    tenantId: TENANT_ID,
    cnfJkt: CNF_JKT,
    scope: "passwords:read,passwords:write,vault:unlock-data",
    expiresAt: new Date(Date.now() + 60_000),
    familyId: FAMILY_ID,
    familyCreatedAt: new Date(),
  };

  function makeReq() {
    return createRequest("GET", "https://app.example.com/api/passwords", {
      headers: {
        Authorization: "Bearer access_xyz",
        DPoP: "fake.dpop.proof",
        "user-agent": "iOS-Test/1.0",
        "x-forwarded-for": "10.0.0.1",
      },
    });
  }

  it("returns ok with ValidatedExtensionToken shape on valid DPoP", async () => {
    mockVerifyDpop.mockResolvedValue({
      ok: true,
      claims: { jti: "j1", htm: "GET", htu: "x", iat: 1, cnf: { jkt: CNF_JKT } },
      jkt: CNF_JKT,
    });

    const result = await validateIosTokenDpop({
      req: makeReq(),
      expectedHtm: "GET",
      expectedHtu: "https://app.example.com/api/passwords",
      accessToken: "access_xyz",
      row: baseRow,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        tokenId: "row-1",
        userId: USER_ID,
        tenantId: TENANT_ID,
        scopes: ["passwords:read", "passwords:write", "vault:unlock-data"],
        expiresAt: baseRow.expiresAt,
        familyId: FAMILY_ID,
        familyCreatedAt: baseRow.familyCreatedAt,
      });
    }
  });

  it("triggers a best-effort lastUsedIp/lastUsedUserAgent update on success", async () => {
    mockVerifyDpop.mockResolvedValue({
      ok: true,
      claims: { jti: "j1", htm: "GET", htu: "x", iat: 1, cnf: { jkt: CNF_JKT } },
      jkt: CNF_JKT,
    });

    await validateIosTokenDpop({
      req: makeReq(),
      expectedHtm: "GET",
      expectedHtu: "https://app.example.com/api/passwords",
      accessToken: "access_xyz",
      row: baseRow,
    });

    // Best-effort update is `void`-fired; allow a microtask to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockExtUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-1" },
        data: expect.objectContaining({
          lastUsedIp: "10.0.0.1",
          lastUsedUserAgent: "iOS-Test/1.0",
          lastUsedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("returns INVALID when row.cnfJkt is missing", async () => {
    const result = await validateIosTokenDpop({
      req: makeReq(),
      expectedHtm: "GET",
      expectedHtu: "x",
      accessToken: "a",
      row: { ...baseRow, cnfJkt: null },
    });
    expect(result).toEqual({ ok: false, error: "EXTENSION_TOKEN_INVALID" });
    expect(mockVerifyDpop).not.toHaveBeenCalled();
  });

  it.each([
    DPOP_VERIFY_ERROR.HEADER_MISSING,
    DPOP_VERIFY_ERROR.SIG_INVALID,
    DPOP_VERIFY_ERROR.HTU_MISMATCH,
    DPOP_VERIFY_ERROR.IAT_OUT_OF_WINDOW,
    DPOP_VERIFY_ERROR.JTI_REPLAY,
    DPOP_VERIFY_ERROR.ATH_MISMATCH,
    DPOP_VERIFY_ERROR.CNF_JKT_MISMATCH,
  ])("maps %s -> EXTENSION_TOKEN_DPOP_INVALID with dpopError preserved", async (errCode) => {
    mockVerifyDpop.mockResolvedValue({ ok: false, error: errCode });

    const result = await validateIosTokenDpop({
      req: makeReq(),
      expectedHtm: "GET",
      expectedHtu: "x",
      accessToken: "a",
      row: baseRow,
    });

    expect(result).toEqual({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: errCode,
    });
  });
});

// ─── refreshIosToken ─────────────────────────────────────────

describe("refreshIosToken", () => {
  const baseRow = {
    id: "row-old",
    userId: USER_ID,
    tenantId: TENANT_ID,
    cnfJkt: CNF_JKT,
    scope: "passwords:read,passwords:write,vault:unlock-data",
    expiresAt: new Date(Date.now() + 60_000),
    familyId: FAMILY_ID,
    familyCreatedAt: new Date(Date.now() - 60_000),
    revokedAt: null as Date | null,
    tokenHash: "hashed_old_refresh",
    devicePubkey: DEVICE_PUBKEY,
  };

  function makeReq() {
    return createRequest("POST", "https://app.example.com/api/mobile/refresh", {
      headers: { "user-agent": "iOS-Test/1.0", "x-forwarded-for": "10.0.0.1" },
    });
  }

  it("happy path: rotates the family, issues a new pair, audits MOBILE_TOKEN_REFRESHED", async () => {
    mockExtCreate.mockResolvedValueOnce(
      happyAccessRowResponse({ id: "row-new-access" }),
    );

    const result = await refreshIosToken({
      req: makeReq(),
      bodyBytes: new TextEncoder().encode(JSON.stringify({ refresh: "x" })),
      oldRow: baseRow,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBeUndefined();
      expect(result.token.tokenId).toBe("row-new-access");
    }

    // Old family rows revoked.
    expect(mockExtUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );

    // MOBILE_TOKEN_REFRESHED audit emitted with sameDeviceKey=true.
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_TOKEN_REFRESHED",
        userId: USER_ID,
        tenantId: TENANT_ID,
        targetType: "ExtensionToken",
        targetId: "row-new-access",
        metadata: expect.objectContaining({
          familyId: FAMILY_ID,
          sameDeviceKey: true,
        }),
      }),
    );
    expect(mockRevokeFamily).not.toHaveBeenCalled();
  });

  it("legitimate retry-after-network-failure: same body within grace window returns the cached new token, no re-audit", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ refresh: "x" }));

    // First call: happy rotation.
    mockExtCreate.mockResolvedValueOnce(
      happyAccessRowResponse({ id: "row-new-1" }),
    );
    const first = await refreshIosToken({
      req: makeReq(),
      bodyBytes: body,
      oldRow: baseRow,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });
    expect(first.ok).toBe(true);

    mockLogAuditAsync.mockClear();
    mockRevokeFamily.mockClear();

    // Second call: same body, oldRow now flagged as revoked (network retry).
    const second = await refreshIosToken({
      req: makeReq(),
      bodyBytes: body,
      oldRow: { ...baseRow, revokedAt: new Date() },
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });

    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.replayed).toBe(true);
      expect(second.token.accessToken).toBe(first.token.accessToken);
    }
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    expect(mockRevokeFamily).not.toHaveBeenCalled();
  });

  it("replay (different body, revoked token): revokes family, emits MOBILE_TOKEN_REPLAY_DETECTED with rich metadata", async () => {
    const result = await refreshIosToken({
      req: makeReq(),
      bodyBytes: new TextEncoder().encode("DIFFERENT"),
      oldRow: { ...baseRow, revokedAt: new Date() },
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });

    expect(result).toEqual({ ok: false, error: "REFRESH_REPLAY_DETECTED" });
    expect(mockRevokeFamily).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        userId: USER_ID,
        tenantId: TENANT_ID,
        reason: "replay_detected",
      }),
    );
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_TOKEN_REPLAY_DETECTED",
        userId: USER_ID,
        tenantId: TENANT_ID,
        targetType: "ExtensionToken",
        targetId: FAMILY_ID,
        metadata: expect.objectContaining({
          familyId: FAMILY_ID,
          replayKind: "refresh_token_reuse",
          sameDeviceKey: true,
          devicePubkeyFingerprint: expect.any(String),
        }),
      }),
    );
  });

  it("replay with different device key: sameDeviceKey=false in metadata", async () => {
    await refreshIosToken({
      req: makeReq(),
      bodyBytes: new TextEncoder().encode("X"),
      oldRow: { ...baseRow, revokedAt: new Date() },
      devicePubkey: "OTHER_DEVICE_PUBKEY",
      cnfJkt: "OTHER_JKT",
    });

    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MOBILE_TOKEN_REPLAY_DETECTED",
        metadata: expect.objectContaining({ sameDeviceKey: false }),
      }),
    );
  });

  it("replay grace window expired: same body but > 5s later → treated as replay", async () => {
    const body = new TextEncoder().encode("body");
    const baseNow = 1_000_000_000_000;

    mockExtCreate.mockResolvedValueOnce(
      happyAccessRowResponse({ id: "row-new-1" }),
    );
    await refreshIosToken({
      req: makeReq(),
      bodyBytes: body,
      oldRow: baseRow,
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
      now: () => baseNow,
    });

    mockLogAuditAsync.mockClear();
    mockRevokeFamily.mockClear();

    const result = await refreshIosToken({
      req: makeReq(),
      bodyBytes: body,
      oldRow: { ...baseRow, revokedAt: new Date(baseNow) },
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
      now: () => baseNow + REFRESH_REPLAY_GRACE_MS + 1,
    });

    expect(result).toEqual({ ok: false, error: "REFRESH_REPLAY_DETECTED" });
    expect(mockRevokeFamily).toHaveBeenCalled();
  });

  it("family absolute expiry: returns REFRESH_TOKEN_FAMILY_EXPIRED + revokes family", async () => {
    const ancient = new Date(Date.now() - IOS_TOKEN_ABSOLUTE_TIMEOUT_MS - 1_000);
    const result = await refreshIosToken({
      req: makeReq(),
      bodyBytes: new TextEncoder().encode("x"),
      oldRow: { ...baseRow, familyCreatedAt: ancient },
      devicePubkey: DEVICE_PUBKEY,
      cnfJkt: CNF_JKT,
    });

    expect(result).toEqual({ ok: false, error: "REFRESH_TOKEN_FAMILY_EXPIRED" });
    expect(mockRevokeFamily).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "family_expired" }),
    );
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });
});
