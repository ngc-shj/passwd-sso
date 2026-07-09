import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockAuth,
  mockMobileBridgeCodeCreate,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockGetAppOrigin,
  mockRequireRecentCurrentAuthMethod,
  mockEnforceAccessRestriction,
  mockCheckRateLimitOrFail,
  mockLogAuditAsync,
  mockDerivePasskeyState,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMobileBridgeCodeCreate: vi.fn(),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockWithUserTenantRls: vi.fn(
    async (_u: string, fn: (tenantId: string) => unknown) =>
      fn("22222222-2222-2222-2222-222222222222"),
  ),
  mockGetAppOrigin: vi.fn(() => "https://example.test"),
  mockRequireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  mockDerivePasskeyState: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mobileBridgeCode: { create: mockMobileBridgeCodeCreate },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/url-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-helpers")>();
  return { ...actual, getAppOrigin: mockGetAppOrigin };
});

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "f".repeat(64),
  hashToken: () => "h".repeat(64),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));

vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));

vi.mock("@/lib/audit/audit", () => ({
  extractRequestMeta: () => ({ ip: "1.2.3.4", userAgent: "test", acceptLanguage: null }),
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { GET } from "./route";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";

// C6: device_jkt is the RFC 7638 JWK thumbprint (43 base64url chars). The
// legacy device_pubkey field (base64url SPKI-DER) was removed because the
// server's SHA-256(SPKI) was never equal to the verifier's JWK thumbprint.
const VALID = {
  client_kind: "ios",
  state: "Vp8XR_zg2v9MhUv8tRgHqf-RJfuJ_kqJUYHOG-WEyT0",
  code_challenge: "Z9wHNpVlwKmGM57J7TmKEXJlhhPYiqVdNNgF1MIv7DM",
  device_jkt: "Z9wHNpVlwKmGM57J7TmKEXJlhhPYiqVdNNgF1MIv7DM",
};

function buildUrl(params: Partial<typeof VALID>): string {
  const u = new URL("https://example.test/api/mobile/authorize");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

describe("GET /api/mobile/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPasskeyAuditForTests();
    mockGetAppOrigin.mockReturnValue("https://example.test");
    mockAuth.mockResolvedValue({ user: { id: "11111111-1111-1111-1111-111111111111" } });
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockWithUserTenantRls.mockImplementation(
      async (_u: string, fn: (tenantId: string) => unknown) =>
        fn("22222222-2222-2222-2222-222222222222"),
    );
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockLogAuditAsync.mockResolvedValue(undefined);
    mockMobileBridgeCodeCreate.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000003" });
    // Default: passkey enforcement off (does not block).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  it("redirects to the iOS custom-scheme callback with code+state on a valid request", async () => {
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(u.protocol).toBe("passwd-sso:");
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("passwd-sso://auth/callback");
    expect(u.searchParams.get("code")).toBe("f".repeat(64));
    expect(u.searchParams.get("state")).toBe(VALID.state);
    expect(mockMobileBridgeCodeCreate).toHaveBeenCalledTimes(1);
    expect(mockMobileBridgeCodeCreate.mock.calls[0][0].data).toMatchObject({
      userId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
      state: VALID.state,
      codeChallenge: VALID.code_challenge,
      deviceJkt: VALID.device_jkt,
    });
    // Bridge-code issuance is audited; the code itself is never logged.
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync.mock.calls[0][0]).toMatchObject({
      action: "MOBILE_BRIDGE_CODE_ISSUED",
      targetType: "MobileBridgeCode",
      metadata: { deviceJkt: VALID.device_jkt },
    });
  });

  it("redirects to the sign-in page (callbackUrl=self) when no Auth.js session is present", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(u.origin).toBe("https://example.test");
    expect(u.pathname).toBe("/ja/auth/signin");
    // callbackUrl points back to the authorize endpoint so Auth.js returns here
    // after sign-in to issue the bridge code on the second pass.
    expect(u.searchParams.get("callbackUrl")).toContain("/api/mobile/authorize");
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns the access-restriction denial when the client IP is not allowed", async () => {
    mockEnforceAccessRestriction.mockResolvedValueOnce(
      Response.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(403);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response and writes no code when the per-user limiter blocks", async () => {
    mockCheckRateLimitOrFail.mockResolvedValueOnce(
      Response.json({ error: "RATE_LIMITED" }, { status: 429 }),
    );
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(429);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("fails closed with 503 and writes no code when the limiter reports redisErrored", async () => {
    // The authorize limiter is fail-closed on Redis error, so when Redis is
    // unavailable (redisErrored) checkRateLimitOrFail returns a 503
    // SERVICE_UNAVAILABLE response. The route must propagate it before issuing
    // any bridge code (fail closed, not open).
    mockCheckRateLimitOrFail.mockResolvedValueOnce(
      Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }),
    );
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(503);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when no app origin is configured and the request is unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    mockGetAppOrigin.mockReturnValue(undefined as unknown as string);
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(500);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("redirects to sign-in when session step-up is required (stale session, not a JSON 403 dead-end)", async () => {
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));

    const res = await GET(createRequest("GET", buildUrl(VALID)));
    // A stale session bounces through sign-in exactly like the no-session path
    // (the ephemeral ASWebAuthenticationSession browser follows the redirect and
    // returns here on the second pass) — not a JSON 403 dead-end.
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location") ?? "");
    expect(u.pathname).toBe("/ja/auth/signin");
    expect(u.searchParams.get("callbackUrl")).toContain("/api/mobile/authorize");
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
    // Gate called with the request ONLY — a custom maxAgeMs here would diverge
    // from the sign-in page's freshness evaluation and re-open the loop.
    expect(mockRequireRecentCurrentAuthMethod).toHaveBeenCalledTimes(1);
    expect(mockRequireRecentCurrentAuthMethod.mock.calls[0]).toHaveLength(1);
  });

  it("returns 400 when client_kind is missing", async () => {
    const params = { ...VALID, client_kind: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when client_kind is not 'ios'", async () => {
    const res = await GET(
      createRequest("GET", buildUrl({ ...VALID, client_kind: "android" })),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when state is missing", async () => {
    const params = { ...VALID, state: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when code_challenge is missing", async () => {
    const params = { ...VALID, code_challenge: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when device_jkt is missing", async () => {
    const params = { ...VALID, device_jkt: undefined };
    const res = await GET(createRequest("GET", buildUrl(params)));
    expect(res.status).toBe(400);
  });

  it("returns 400 when device_jkt is not exactly 43 base64url chars (C6 shape gate)", async () => {
    const res = await GET(createRequest("GET", buildUrl({ ...VALID, device_jkt: "tooshort" })));
    expect(res.status).toBe(400);
  });

  it("returns 400 when state is not base64url", async () => {
    const res = await GET(
      createRequest("GET", buildUrl({ ...VALID, state: "has spaces!@#" })),
    );
    expect(res.status).toBe(400);
  });

  it("ignores attacker-supplied redirect_uri query parameter", async () => {
    // Append a redirect_uri to the request URL.
    const u = new URL(buildUrl(VALID));
    u.searchParams.set("redirect_uri", "https://attacker.example/steal");
    const res = await GET(createRequest("GET", u.toString()));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("passwd-sso://auth/callback")).toBe(true);
    expect(loc).not.toContain("attacker.example");
  });

  it("propagates a tenant-resolution failure as a 500 (no row written)", async () => {
    mockWithUserTenantRls.mockRejectedValueOnce(new Error("TENANT_NOT_RESOLVED"));
    await expect(GET(createRequest("GET", buildUrl(VALID)))).rejects.toThrow(
      "TENANT_NOT_RESOLVED",
    );
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  // ── C3: Passkey enforcement gate ──────────────────────────────────────────

  it("C3: off (requirePasskey=false) → bridge code minted", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    // Non-vacuity: redirected to the iOS callback with a code (not passkey_required).
    expect(loc.startsWith("passwd-sso://auth/callback")).toBe(true);
    expect(loc).not.toContain("passkey_required");
    expect(mockMobileBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C3: on + hasPasskey → bridge code minted", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: true,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).not.toContain("passkey_required");
    expect(mockMobileBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C3: on + no passkey + within grace → bridge code minted", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).not.toContain("passkey_required");
    expect(mockMobileBridgeCodeCreate).toHaveBeenCalledTimes(1);
  });

  it("C3: on + no passkey + grace expired → 302 passkey_required, no bridge code, audit emitted once", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("passwd-sso://auth/callback");
    expect(u.searchParams.get("error")).toBe("passkey_required");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Non-vacuity: bridge code must NOT have been created.
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
    // Exactly one PASSKEY_ENFORCEMENT_BLOCKED audit emit.
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        metadata: { blockedPath: "/api/mobile/authorize" },
      }),
    );
    const blockedCalls = mockLogAuditAsync.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C3: enabledAt=null → immediate 302 passkey_required", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: 7,
    });
    const res = await GET(createRequest("GET", buildUrl(VALID)));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("passkey_required");
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });

  it("C3: audit dedup — second blocked attempt on same path does not emit a second audit", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    await GET(createRequest("GET", buildUrl(VALID)));
    await GET(createRequest("GET", buildUrl(VALID)));
    const blockedCalls = mockLogAuditAsync.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C3: derivePasskeyState throws → fail closed (no bridge code, error propagates)", async () => {
    mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));
    await expect(GET(createRequest("GET", buildUrl(VALID)))).rejects.toThrow("DB error");
    expect(mockMobileBridgeCodeCreate).not.toHaveBeenCalled();
  });
});
