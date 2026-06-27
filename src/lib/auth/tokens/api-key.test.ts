import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockApiKeyFindUnique, mockTenantMemberFindUnique, mockApiKeyUpdate } = vi.hoisted(() => ({
  mockApiKeyFindUnique: vi.fn(),
  mockTenantMemberFindUnique: vi.fn(),
  mockApiKeyUpdate: vi.fn().mockResolvedValue({}),
}));

const { mockWithBypassRls } = vi.hoisted(() => ({
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn({
    apiKey: {
      findUnique: mockApiKeyFindUnique,
      update: mockApiKeyUpdate,
    },
    tenantMember: {
      findUnique: mockTenantMemberFindUnique,
    },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));

import { createRequest } from "@/__tests__/helpers/request-builder";
import { parseApiKeyScopes, hasApiKeyScope, validateApiKey } from "./api-key";
import { API_KEY_LAST_USED_THROTTLE_MS } from "@/lib/constants/auth/api-key";

// ─── parseApiKeyScopes ───────────────────────────────────────

describe("parseApiKeyScopes", () => {
  it("parses valid CSV scopes", () => {
    expect(parseApiKeyScopes("passwords:read,tags:read")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("drops unknown scopes", () => {
    expect(parseApiKeyScopes("passwords:read,admin:delete")).toEqual([
      "passwords:read",
    ]);
  });

  it("handles empty string", () => {
    expect(parseApiKeyScopes("")).toEqual([]);
  });

  it("handles whitespace in CSV", () => {
    expect(parseApiKeyScopes(" passwords:read , tags:read ")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("handles single scope", () => {
    expect(parseApiKeyScopes("vault:status")).toEqual(["vault:status"]);
  });
});

// ─── hasApiKeyScope ──────────────────────────────────────────

describe("hasApiKeyScope", () => {
  it("returns true when scope is present", () => {
    expect(hasApiKeyScope(["passwords:read", "tags:read"], "passwords:read")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(hasApiKeyScope(["passwords:read"], "passwords:write")).toBe(false);
  });

  it("returns false for empty scopes array", () => {
    expect(hasApiKeyScope([], "passwords:read")).toBe(false);
  });
});

// ─── validateApiKey — deactivated-user checks (C13) ─────────

const VALID_KEY = "api_validkeyvalue";
const TENANT_ID = "tenant-00000000-0000-4000-8000-000000000001";
const USER_ID = "user-00000000-0000-4000-8000-000000000001";

const VALID_KEY_ROW = {
  id: "key-id",
  userId: USER_ID,
  tenantId: TENANT_ID,
  scope: "passwords:read",
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  // R19: lastUsedAt must be present so the throttle guard evaluates correctly.
  // Without it, the field reads as undefined (stale) → always-update, masking throttle.
  lastUsedAt: null,
};

function makeReq(token = VALID_KEY) {
  return createRequest("GET", "http://localhost/api/v1/passwords", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("validateApiKey — deactivated-user (C13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) deactivated-in-token-tenant ⇒ API_KEY_INVALID", async () => {
    mockApiKeyFindUnique.mockResolvedValue(VALID_KEY_ROW);
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const result = await validateApiKey(makeReq());
    expect(result).toEqual({ ok: false, error: "API_KEY_INVALID" });
  });

  it("(b) deactivated in token tenant but ACTIVE in another tenant ⇒ API_KEY_INVALID", async () => {
    // The check is tenant-scoped to the token's tenantId — there is only one
    // findUnique call (for TENANT_ID). A deactivated row there is sufficient.
    mockApiKeyFindUnique.mockResolvedValue(VALID_KEY_ROW);
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const result = await validateApiKey(makeReq());
    expect(result).toEqual({ ok: false, error: "API_KEY_INVALID" });

    // Verify the membership lookup used the token's own tenantId
    expect(mockTenantMemberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_userId: { tenantId: TENANT_ID, userId: USER_ID } },
      }),
    );
  });

  it("(c) active membership ⇒ valid", async () => {
    mockApiKeyFindUnique.mockResolvedValue(VALID_KEY_ROW);
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: null });

    const result = await validateApiKey(makeReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBe(USER_ID);
      expect(result.data.tenantId).toBe(TENANT_ID);
    }
  });

  it("no membership row (fail-closed) ⇒ API_KEY_INVALID", async () => {
    mockApiKeyFindUnique.mockResolvedValue(VALID_KEY_ROW);
    mockTenantMemberFindUnique.mockResolvedValue(null);

    const result = await validateApiKey(makeReq());
    expect(result).toEqual({ ok: false, error: "API_KEY_INVALID" });
  });

  // L2 — SCIM deactivation fail-open backstop.
  // SCIM user deactivation calls invalidateUserSessions, which sets revokedAt on
  // this api_key. If that invalidation THROWS (the SCIM handler logs and returns
  // 200 — a fail-open window), the token's revokedAt is NOT set. This test pins
  // the backstop that makes that fail-open safe: with revokedAt=null (token never
  // revoked) but the member deactivated, the membership check alone still rejects
  // the token on the next request. Independent of the revokedAt write.
  it("rejects a non-revoked token when the member is deactivated (SCIM fail-open backstop)", async () => {
    mockApiKeyFindUnique.mockResolvedValue({ ...VALID_KEY_ROW, revokedAt: null });
    mockTenantMemberFindUnique.mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });

    const result = await validateApiKey(makeReq());
    expect(result).toEqual({ ok: false, error: "API_KEY_INVALID" });
  });
});

// ─── validateApiKey — lastUsedAt throttle (C4) ───────────────

describe("validateApiKey — lastUsedAt throttle (C4)", () => {
  const ACTIVE_MEMBER = { deactivatedAt: null };
  const THROTTLE_MS = API_KEY_LAST_USED_THROTTLE_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockTenantMemberFindUnique.mockResolvedValue(ACTIVE_MEMBER);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("null lastUsedAt ⇒ update is issued", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mockApiKeyFindUnique.mockResolvedValue({
      ...VALID_KEY_ROW,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      lastUsedAt: null,
    });

    await validateApiKey(makeReq());

    expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1);
  });

  it("stale lastUsedAt (>5 min ago) ⇒ update is issued", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z")); // now = T+10min
    mockApiKeyFindUnique.mockResolvedValue({
      ...VALID_KEY_ROW,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      lastUsedAt: new Date("2026-01-01T00:00:00Z"), // 10 min ago (> threshold)
    });

    await validateApiKey(makeReq());

    expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1);
  });

  it("recent lastUsedAt (within 5 min) ⇒ update is NOT issued", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:04:00Z")); // now = T+4min
    mockApiKeyFindUnique.mockResolvedValue({
      ...VALID_KEY_ROW,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      lastUsedAt: new Date("2026-01-01T00:00:00Z"), // 4 min ago (within threshold)
    });

    await validateApiKey(makeReq());

    expect(mockApiKeyUpdate).not.toHaveBeenCalled();
  });

  it("lastUsedAt exactly at threshold boundary ⇒ update is NOT issued", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + THROTTLE_MS);
    mockApiKeyFindUnique.mockResolvedValue({
      ...VALID_KEY_ROW,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      lastUsedAt: new Date("2026-01-01T00:00:00Z"), // exactly THROTTLE_MS ago (not >)
    });

    await validateApiKey(makeReq());

    expect(mockApiKeyUpdate).not.toHaveBeenCalled();
  });
});
