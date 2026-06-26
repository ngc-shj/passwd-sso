import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockCheckAuth, mockIssueAutofill, mockLogAudit, mockWarn, mockError, mockCheckRateLimitOrFail } = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockIssueAutofill: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn(),
}));

vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/auth/tokens/mobile-token", () => ({ issueAutofillToken: mockIssueAutofill }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: () => ({}),
}));
// Mock the rate-limit translator so the real helper (and its transitive prisma
// import) never loads; the 429/503 mapping itself is covered in rate-limit-audit.test.ts.
vi.mock("@/lib/security/rate-limit-audit", () => ({ checkRateLimitOrFail: mockCheckRateLimitOrFail }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() },
  getLogger: () => ({ warn: mockWarn, error: mockError, info: vi.fn(), debug: vi.fn() }),
}));

import { POST } from "./route";

const VALID_JWK = { kty: "EC", crv: "P-256", x: "eHh4", y: "eXl5" };

function post(body: unknown) {
  return createRequest("POST", "http://localhost/api/mobile/autofill-token", { body });
}

describe("POST /api/mobile/autofill-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
    // Default: rate limit allows the request through (helper returns null).
    mockCheckRateLimitOrFail.mockResolvedValue(null);
  });

  it("mints a token bound to the supplied jwk for an authenticated host token", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    mockIssueAutofill.mockResolvedValue({
      token: "secret-token",
      expiresAt: new Date("2026-06-13T00:05:00.000Z"),
      cnfJkt: "ignored",
      scope: "passwords:write",
    });

    const res = await POST(post({ jwk: VALID_JWK }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json.token).toBe("secret-token");
    expect(json.scope).toEqual(["passwords:write"]);
    // The mint is rate-limited per authenticated user under the correct scope.
    expect(mockCheckRateLimitOrFail).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "rl:mobile_autofill_token:u1",
        scope: "mobile.autofill_token",
        userId: "u1",
        tenantId: "t1",
      }),
    );
    // The route computes cnf.jkt from the body jwk and binds the token to it.
    const passed = mockIssueAutofill.mock.calls[0][0];
    expect(passed).toMatchObject({ userId: "u1", tenantId: "t1" });
    expect(passed.cnfJkt).toEqual(expect.any(String));
    expect(json.cnfJkt).toBe(passed.cnfJkt);
  });

  it("returns the auth failure response when checkAuth fails", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects a session caller (only the host token may broker an AutoFill token)", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId: "u1" } });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects a non-IOS_APP token (BROWSER_EXTENSION shares the scope but may not mint)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "BROWSER_EXTENSION" },
    });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("rejects an IOS_AUTOFILL token (cannot rotate its own kind)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_AUTOFILL" },
    });
    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(401);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("400 on a malformed jwk (missing coordinates)", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    const res = await POST(post({ jwk: { kty: "EC", crv: "P-256" } }));
    expect(res.status).toBe(400);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("400 on a non-P-256 jwk", async () => {
    mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "token", userId: "u1", tenantId: "t1", clientKind: "IOS_APP" } });
    const res = await POST(post({ jwk: { kty: "EC", crv: "P-384", x: "a", y: "b" } }));
    expect(res.status).toBe(400);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("429 when the per-user mint budget is exhausted (does NOT mint)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u-rl", tenantId: "t1", clientKind: "IOS_APP" },
    });
    mockCheckRateLimitOrFail.mockResolvedValueOnce(
      Response.json({ error: "RATE_LIMIT_EXCEEDED" }, { status: 429 }),
    );

    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(429);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the limiter reports redisErrored (does NOT mint)", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u-rl", tenantId: "t1", clientKind: "IOS_APP" },
    });
    mockCheckRateLimitOrFail.mockResolvedValueOnce(
      Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }),
    );

    const res = await POST(post({ jwk: VALID_JWK }));
    expect(res.status).toBe(503);
    expect(mockIssueAutofill).not.toHaveBeenCalled();
  });
});
