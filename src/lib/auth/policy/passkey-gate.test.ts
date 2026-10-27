import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { MS_PER_DAY } from "@/lib/constants/time";
import type { RateLimiterOptions } from "@/lib/security/rate-limit";

const {
  mockWebAuthnCredentialCount,
  mockTenantFindUnique,
  mockWithBypassRls,
  mockLogAuditAsync,
  mockLimiterCheck,
  mockCreateRateLimiter,
} = vi.hoisted(() => {
  const mockLimiterCheck = vi.fn();
  return {
    mockWebAuthnCredentialCount: vi.fn(),
    mockTenantFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockLogAuditAsync: vi.fn(),
    mockLimiterCheck,
    mockCreateRateLimiter: vi.fn((_options: RateLimiterOptions) => ({ check: mockLimiterCheck, clear: vi.fn() })),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  logAuditAsync: mockLogAuditAsync,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

import { passkeyGateBlocks, PASSKEY_GATE_CREDENTIAL } from "./passkey-gate";
import { PASSKEY_AUDIT_DEDUP_MS } from "./passkey-enforcement";

// Read before any per-test reset: the limiter is built once, at import.
const limiterOptions = mockCreateRateLimiter.mock.calls[0]?.[0];

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const KEY_ID = "key-1";

function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/v1/passwords", {
    headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "test-agent" },
  });
}

function gate(credentialId = KEY_ID) {
  return passkeyGateBlocks({
    req: makeReq(),
    userId: USER_ID,
    tenantId: TENANT_ID,
    credential: PASSKEY_GATE_CREDENTIAL.API_KEY,
    credentialId,
  });
}

function policy(p: {
  requirePasskey: boolean;
  enabledDaysAgo?: number | null;
  graceDays?: number | null;
}) {
  mockTenantFindUnique.mockResolvedValue({
    requirePasskey: p.requirePasskey,
    requirePasskeyEnabledAt:
      p.enabledDaysAgo == null ? null : new Date(Date.now() - p.enabledDaysAgo * MS_PER_DAY),
    passkeyGracePeriodDays: p.graceDays ?? null,
  });
}

describe("passkeyGateBlocks", () => {
  beforeEach(() => {
    mockWebAuthnCredentialCount.mockReset().mockResolvedValue(0);
    mockTenantFindUnique.mockReset();
    mockLogAuditAsync.mockReset().mockResolvedValue(undefined);
    mockLimiterCheck.mockReset().mockResolvedValue({ allowed: true });
    mockWithBypassRls.mockReset().mockImplementation(
      (_prisma: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          webAuthnCredential: { count: mockWebAuthnCredentialCount },
          tenant: { findUnique: mockTenantFindUnique },
        }),
    );
  });

  it("builds its audit limiter as one row per window, falling back to memory on a Redis error", () => {
    expect(limiterOptions).toEqual({ windowMs: PASSKEY_AUDIT_DEDUP_MS, max: 1 });
    expect(limiterOptions).not.toHaveProperty("failClosedOnRedisError");
  });

  it("derives the state in its own PASSKEY_ENFORCEMENT_STATE bypass, not a caller's transaction", async () => {
    policy({ requirePasskey: false });
    await gate();
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.PASSKEY_ENFORCEMENT_STATE,
    );
  });

  it("blocks a member without a passkey after the grace period and writes one audit row", async () => {
    policy({ requirePasskey: true, enabledDaysAgo: 8, graceDays: 7 });
    await expect(gate()).resolves.toBe(true);
    expect(mockLimiterCheck).toHaveBeenCalledWith(`rl:passkey_gate_audit:api_key:${KEY_ID}`);
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TENANT,
        userId: USER_ID,
        tenantId: TENANT_ID,
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        ip: "203.0.113.7",
        userAgent: "test-agent",
        metadata: { blockedPath: "api_key", credentialId: KEY_ID },
      }),
    );
  });

  it("keys the audit limiter per credential", async () => {
    policy({ requirePasskey: true, enabledDaysAgo: 8, graceDays: 7 });
    await gate("key-a");
    await gate("key-b");
    expect(mockLimiterCheck.mock.calls.map((c) => c[0])).toEqual([
      "rl:passkey_gate_audit:api_key:key-a",
      "rl:passkey_gate_audit:api_key:key-b",
    ]);
  });

  it("still blocks when the audit limiter refuses, without writing a row", async () => {
    policy({ requirePasskey: true, enabledDaysAgo: 8, graceDays: 7 });
    mockLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    await expect(gate()).resolves.toBe(true);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("enforces at once when requirePasskeyEnabledAt is null", async () => {
    policy({ requirePasskey: true, enabledDaysAgo: null, graceDays: 7 });
    await expect(gate()).resolves.toBe(true);
  });

  it.each([
    ["the member has a passkey", () => mockWebAuthnCredentialCount.mockResolvedValue(1)],
    ["the tenant has no requirement", () => policy({ requirePasskey: false })],
    ["the grace period is still running", () => policy({ requirePasskey: true, enabledDaysAgo: 6, graceDays: 7 })],
  ])("allows when %s, writing nothing", async (_label, arrange) => {
    policy({ requirePasskey: true, enabledDaysAgo: 8, graceDays: 7 });
    arrange();
    await expect(gate()).resolves.toBe(false);
    expect(mockLimiterCheck).not.toHaveBeenCalled();
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("rejects when the state cannot be derived", async () => {
    mockTenantFindUnique.mockResolvedValue(null);
    await expect(gate()).rejects.toThrow(/tenant tenant-1 not found/);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });
});
