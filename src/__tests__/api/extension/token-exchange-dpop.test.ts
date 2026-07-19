import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";
const VALID_CODE = "a".repeat(64);

const {
  mockVerifyDpop,
  mockWithBypassRls,
  mockRateLimitCheck,
  mockIssueExtensionToken,
  mockLogAuditAsync,
  mockCheckIpRateLimit,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => ({
  mockVerifyDpop: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockRateLimitCheck: vi.fn(),
  mockIssueExtensionToken: vi.fn(),
  mockLogAuditAsync: vi.fn(),
  mockCheckIpRateLimit: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/dpop/verify", () => ({
  verifyDpopProof: mockVerifyDpop,
  computeAth: vi.fn((token: string) => `ath-${token}`),
  DPOP_VERIFY_ERROR: {
    HEADER_MISSING: "DPOP_HEADER_MISSING",
    SIG_INVALID: "DPOP_SIG_INVALID",
  },
}));
vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ hasOrRecord: vi.fn().mockResolvedValue(false) })),
}));
vi.mock("@/lib/auth/dpop/htu-canonical", () => ({
  canonicalHtu: vi.fn(() => "https://localhost:3000/api/extension/token/exchange"),
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE" },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })),
}));
vi.mock("@/lib/security/ip-rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
}));
vi.mock("@/lib/auth/tokens/extension-token", () => ({
  issueExtensionToken: mockIssueExtensionToken,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: vi.fn(() => ({ scope: "personal", userId: "user-1" })),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: vi.fn(() => "hash-abc"),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

import { POST } from "@/app/api/extension/token/exchange/route";

const CONSUMED_RECORD = {
  userId: "user-1",
  tenantId: "tenant-1",
  scope: "extension:read",
  cnfJkt: VALID_CNF_JKT,
};

const ISSUED_TOKEN = {
  token: "issued-token-xyz",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  scopeCsv: "extension:read",
  cnfJkt: VALID_CNF_JKT,
};

describe("POST /api/extension/token/exchange — DPoP enforcement (C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIpRateLimit.mockResolvedValue({ allowed: true });
    // Limiter-layer mock: default allowed:true keeps the production
    // checkRateLimitOrFail mapping in path.
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockLogAuditAsync.mockResolvedValue(undefined);
    mockIssueExtensionToken.mockResolvedValue(ISSUED_TOKEN);
    // Tenant IP access restriction allows by default (helper returns null).
    mockEnforceAccessRestriction.mockResolvedValue(null);

    // New order (C5): findUnique returns consumed record, then CAS consume
    // succeeds (count=1). DPoP verify runs between the two.
    mockWithBypassRls
      .mockResolvedValueOnce(CONSUMED_RECORD) // findUnique
      .mockResolvedValueOnce({ count: 1 }); // updateMany CAS
  });

  it("returns 201 with token and cnfJkt when DPoP proof is valid", async () => {
    mockVerifyDpop.mockResolvedValue({ ok: true, claims: {}, jkt: VALID_CNF_JKT });

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/exchange",
      {
        body: { code: VALID_CODE },
        headers: { "dpop": "valid-dpop-proof" },
      },
    );

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.cnfJkt).toBe(VALID_CNF_JKT);
    expect(json.token).toBe(ISSUED_TOKEN.token);

    // Symmetric vacuous-pass guard: verifyDpopProof MUST have been called exactly once
    // with the expected parameters — proves the check isn't dead code.
    expect(mockVerifyDpop).toHaveBeenCalledTimes(1);
    // Verify the call: expectedCnfJkt and expectedHtm are set; expectedAth is absent
    // (no access token at exchange time — this is the pre-token step).
    const dpopCallArgs = mockVerifyDpop.mock.calls[0][1] as Record<string, unknown>;
    expect(dpopCallArgs.expectedCnfJkt).toBe(VALID_CNF_JKT);
    expect(dpopCallArgs.expectedHtm).toBe("POST");
    expect("expectedAth" in dpopCallArgs).toBe(false);

    // cnfJkt must be passed to issueExtensionToken
    expect(mockIssueExtensionToken).toHaveBeenCalledWith(
      expect.objectContaining({ cnfJkt: VALID_CNF_JKT }),
    );
  });

  it("returns 401 when DPoP header is missing", async () => {
    mockVerifyDpop.mockResolvedValue({
      ok: false,
      error: "DPOP_HEADER_MISSING",
    });

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/exchange",
      { body: { code: VALID_CODE } },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    // verifyDpopProof must still be called — the rejection is not bypassed
    expect(mockVerifyDpop).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when DPoP is signed by wrong key", async () => {
    mockVerifyDpop.mockResolvedValue({
      ok: false,
      error: "DPOP_SIG_INVALID",
    });

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/exchange",
      {
        body: { code: VALID_CODE },
        headers: { "dpop": "wrong-key-proof" },
      },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    // Audit must carry dpopError metadata
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ dpopError: "DPOP_SIG_INVALID" }),
      }),
    );
  });

  it("returns 401 when code is unknown (findUnique returns null) — no DPoP involvement", async () => {
    // C5 order: findUnique fast-fails on null → 401 without touching DPoP or CAS.
    mockWithBypassRls.mockReset();
    mockWithBypassRls.mockResolvedValueOnce(null);

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/exchange",
      {
        body: { code: VALID_CODE },
        headers: { "dpop": "any-dpop-proof" },
      },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    // No cnfJkt to verify against — DPoP not invoked.
    expect(mockVerifyDpop).not.toHaveBeenCalled();
    // Only one withBypassRls call (findUnique) — CAS never happened.
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  // C5: invalid DPoP must not consume the bridge code.
  it("returns 401 on invalid DPoP — bridge code is NOT consumed (no CAS)", async () => {
    mockVerifyDpop.mockResolvedValue({ ok: false, error: "DPOP_SIG_INVALID" });
    mockWithBypassRls.mockReset();
    mockWithBypassRls.mockResolvedValueOnce(CONSUMED_RECORD);

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/exchange",
      {
        body: { code: VALID_CODE },
        headers: { "dpop": "tampered-proof" },
      },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
    expect(mockVerifyDpop).toHaveBeenCalledTimes(1);
    // findUnique only — CAS updateMany did NOT run.
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    // Failure audit still fires (we have userId + tenantId from the SELECT).
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ dpopError: "DPOP_SIG_INVALID" }),
      }),
    );
  });
});
