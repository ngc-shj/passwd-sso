import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockRateLimiterCheck,
  mockWithBypassRls,
  mockWebAuthnCredentialCount,
  mockUserFindUnique,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockWebAuthnCredentialCount: vi.fn(),
  mockUserFindUnique: vi.fn(),
}));

vi.mock("@/lib/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { count: mockWebAuthnCredentialCount },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";
import { MS_PER_DAY } from "@/lib/constants/time";

function authOk(userId = "user-1") {
  return { ok: true, auth: { type: "session", userId } };
}

function authFail(status = 401) {
  return {
    ok: false,
    response: NextResponse.json({ error: "UNAUTHORIZED" }, { status }),
  };
}

function tenantWith(overrides: {
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: Date | null;
  passkeyGracePeriodDays?: number | null;
}) {
  return {
    tenant: {
      requirePasskey: overrides.requirePasskey ?? false,
      requirePasskeyEnabledAt: overrides.requirePasskeyEnabledAt ?? null,
      passkeyGracePeriodDays: overrides.passkeyGracePeriodDays ?? null,
    },
  };
}

describe("GET /api/user/passkey-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue(authOk());
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({ requirePasskey: false }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(401);
  });

  it("returns required: false when tenant requirePasskey is false", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({ requirePasskey: false }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.required).toBe(false);
  });

  it("returns hasPasskey: true when user has WebAuthn credentials", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(2);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({ requirePasskey: true }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasPasskey).toBe(true);
  });

  it("returns hasPasskey: false when user has no credentials", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({ requirePasskey: true }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasPasskey).toBe(false);
  });

  it("returns correct gracePeriodRemaining within grace period", async () => {
    const enabledAt = new Date(Date.now() - 2 * MS_PER_DAY); // 2 days ago
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({
        requirePasskey: true,
        requirePasskeyEnabledAt: enabledAt,
        passkeyGracePeriodDays: 7,
      }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // 7 days grace - 2 days elapsed = 5 days remaining (ceil)
    expect(json.gracePeriodRemaining).toBeGreaterThanOrEqual(4);
    expect(json.gracePeriodRemaining).toBeLessThanOrEqual(5);
  });

  it("returns gracePeriodRemaining: 0 when grace period has expired", async () => {
    const enabledAt = new Date(Date.now() - 10 * MS_PER_DAY); // 10 days ago
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({
        requirePasskey: true,
        requirePasskeyEnabledAt: enabledAt,
        passkeyGracePeriodDays: 7, // only 7 day grace, 10 elapsed → expired
      }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gracePeriodRemaining).toBe(0);
  });

  it("returns gracePeriodRemaining: null when hasPasskey is true", async () => {
    const enabledAt = new Date(Date.now() - 1 * MS_PER_DAY); // 1 day ago
    mockWebAuthnCredentialCount.mockResolvedValue(1); // has passkey
    mockUserFindUnique.mockResolvedValue(
      tenantWith({
        requirePasskey: true,
        requirePasskeyEnabledAt: enabledAt,
        passkeyGracePeriodDays: 7,
      }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gracePeriodRemaining).toBeNull();
  });

  it("returns gracePeriodRemaining: null when required is false", async () => {
    const enabledAt = new Date(Date.now() - 1 * MS_PER_DAY);
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockUserFindUnique.mockResolvedValue(
      tenantWith({
        requirePasskey: false, // not required
        requirePasskeyEnabledAt: enabledAt,
        passkeyGracePeriodDays: 7,
      }),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gracePeriodRemaining).toBeNull();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/passkey-status"),
    );
    expect(res.status).toBe(429);
  });
});
