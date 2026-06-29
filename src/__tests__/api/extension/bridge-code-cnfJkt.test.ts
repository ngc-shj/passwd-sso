/**
 * C4 — POST /api/extension/bridge-code rewrite tests.
 *
 * Verifies the new contract: cnfJkt comes from the verifier-derived
 * thumbprint of the DPoP proof's own JWK, body is `z.object({}).strict()`
 * (any client-supplied field is rejected), Origin is checked against
 * EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS, env-unset fails closed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const ALLOWED_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ATTACKER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
// 43-char base64url thumbprint — the value the verifier would return.
const VERIFIER_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

const {
  mockAuth,
  mockRequireRecentCurrentAuthMethod,
  mockRateLimitCheck,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockBridgeCodeFindMany,
  mockBridgeCodeUpdateMany,
  mockBridgeCodeCreate,
  mockUserFindUnique,
  mockLogAuditAsync,
  mockCheckRateLimitOrFail,
  mockCheckIpRateLimit,
  mockCheckAccessRestrictionWithAudit,
  mockVerifyDpop,
  mockDerivePasskeyState,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireRecentCurrentAuthMethod: vi.fn(),
  mockRateLimitCheck: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockBridgeCodeFindMany: vi.fn(),
  mockBridgeCodeUpdateMany: vi.fn(),
  mockBridgeCodeCreate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockLogAuditAsync: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn(),
  mockCheckIpRateLimit: vi.fn(),
  mockCheckAccessRestrictionWithAudit: vi.fn(),
  mockVerifyDpop: vi.fn(),
  mockDerivePasskeyState: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/security/ip-rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn(() => "10.0.0.1"),
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessRestrictionWithAudit,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE" },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      findMany: mockBridgeCodeFindMany,
      updateMany: mockBridgeCodeUpdateMany,
      create: mockBridgeCodeCreate,
    },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  extractRequestMeta: vi.fn(() => ({ ip: "10.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn(() => ({ scope: "PERSONAL", userId: "user-1" })),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: vi.fn(() => "a".repeat(64)),
  hashToken: vi.fn(() => "hash-abc"),
}));
vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ has: vi.fn(() => false), add: vi.fn() })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "http://localhost:3000/api/extension/bridge-code"),
}));
vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { POST } from "@/app/api/extension/bridge-code/route";
import { __resetAllowlistForTests } from "@/lib/http/cors";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";

function makeRequest(opts: {
  origin?: string | null;
  cookie?: string;
  dpop?: string | null;
  body?: unknown;
} = {}): import("next/server").NextRequest {
  const headers: Record<string, string> = {};
  if (opts.origin !== null && opts.origin !== undefined) headers.Origin = opts.origin;
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.dpop !== null && opts.dpop !== undefined) headers.DPoP = opts.dpop;
  return createRequest(
    "POST",
    "http://localhost:3000/api/extension/bridge-code",
    { headers, body: opts.body ?? {} },
  );
}

describe("POST /api/extension/bridge-code — C4 rewrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPasskeyAuditForTests();
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", ALLOWED_ORIGIN);
    __resetAllowlistForTests();

    mockCheckIpRateLimit.mockResolvedValue({ allowed: true });
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCheckAccessRestrictionWithAudit.mockResolvedValue({ allowed: true });
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          extensionBridgeCode: {
            findMany: mockBridgeCodeFindMany,
            updateMany: mockBridgeCodeUpdateMany,
            create: mockBridgeCodeCreate,
          },
        }),
    );
    mockBridgeCodeFindMany.mockResolvedValue([]);
    mockBridgeCodeCreate.mockResolvedValue({});
    mockLogAuditAsync.mockResolvedValue(undefined);
    mockVerifyDpop.mockResolvedValue({ ok: true, jkt: VERIFIER_JKT, claims: {} });
    // Default: passkey enforcement off (gate is a no-op for existing tests).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAllowlistForTests();
  });

  it("body {} + DPoP + cookie + allowlisted Origin → 201 with verifier-derived cnf_jkt", async () => {
    const res = await POST(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        cookie: "authjs.session-token=sess",
        dpop: "valid-dpop-proof",
        body: {},
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json).toHaveProperty("code");
    expect(json).toHaveProperty("expiresAt");
    // Persisted cnf_jkt equals the verifier-returned thumbprint.
    expect(mockBridgeCodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cnfJkt: VERIFIER_JKT }),
      }),
    );
  });

  it("body { cnfJkt } + valid DPoP + cookie + Origin → 400 (strict schema rejects unknown field)", async () => {
    const res = await POST(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        cookie: "authjs.session-token=sess",
        dpop: "valid-dpop-proof",
        body: { cnfJkt: "attacker-supplied-thumbprint-base64url-43char" },
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    const detailsStr = JSON.stringify(json.details);
    expect(detailsStr.toLowerCase()).toContain("unrecognized");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
    // Most importantly: the verifier was never asked, and even if it had
    // been the DB persist did not happen — body-supplied cnfJkt is dead-on-arrival.
    expect(mockVerifyDpop).not.toHaveBeenCalled();
  });

  it("body {} + DPoP + cookie + wrong Origin → 403", async () => {
    const res = await POST(
      makeRequest({
        origin: ATTACKER_ORIGIN,
        cookie: "authjs.session-token=sess",
        dpop: "valid-dpop-proof",
        body: {},
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    // No auth/DPoP/DB work happened past the Origin gate.
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockVerifyDpop).not.toHaveBeenCalled();
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("body {} + DPoP + no cookie → 401 (auth() returns null)", async () => {
    mockAuth.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        dpop: "valid-dpop-proof",
        body: {},
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("body {} + no DPoP header + cookie + Origin → 401 (verifyDpopProof returns HEADER_MISSING)", async () => {
    mockVerifyDpop.mockResolvedValueOnce({ ok: false, error: "DPOP_HEADER_MISSING" });

    const res = await POST(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        cookie: "authjs.session-token=sess",
        dpop: null,
        body: {},
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("body {} + valid DPoP + cookie + Origin + EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS unset → 403 (fail-closed)", async () => {
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", "");
    __resetAllowlistForTests();

    const res = await POST(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        cookie: "authjs.session-token=sess",
        dpop: "valid-dpop-proof",
        body: {},
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockBridgeCodeCreate).not.toHaveBeenCalled();
  });
});
