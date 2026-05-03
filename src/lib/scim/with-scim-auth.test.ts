import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockValidateScimToken,
  mockEnforceAccessRestriction,
  mockCheckScimRateLimit,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockEnforceAccessRestriction: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));

import { authorizeScim } from "./with-scim-auth";

function fakeRequest(): NextRequest {
  return {
    headers: new Headers(),
    url: "https://app.example.com/api/scim/v2/Users",
    method: "GET",
  } as unknown as NextRequest;
}

const validatedToken = {
  tokenId: "tok1",
  tenantId: "tenant-1",
  createdById: "user-1",
  auditUserId: "user-1",
  actorType: "HUMAN" as const,
};

describe("authorizeScim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns ok=true and validated data on the happy path", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(validatedToken);

    expect(mockValidateScimToken).toHaveBeenCalledTimes(1);
    expect(mockEnforceAccessRestriction).toHaveBeenCalledTimes(1);
    expect(mockCheckScimRateLimit).toHaveBeenCalledWith("tenant-1");
  });

  it("returns 401 SCIM error when token validation fails", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_INVALID",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = (await res.response.json()) as { detail: string };
      expect(body.detail).toBe("SCIM_TOKEN_INVALID");
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockCheckScimRateLimit).not.toHaveBeenCalled();
  });

  it("returns the access-restriction response when the network policy denies", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    const denied = new Response("forbidden", { status: 403 });
    mockEnforceAccessRestriction.mockResolvedValue(denied);

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response).toBe(denied);
    }
    expect(mockCheckScimRateLimit).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: true, data: validatedToken });
    mockCheckScimRateLimit.mockResolvedValue(false);

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(429);
    }
  });

  it("propagates expired-token error code as 401 (no access check, no rate limit)", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_EXPIRED",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockCheckScimRateLimit).not.toHaveBeenCalled();
  });

  it("propagates revoked-token error code as 401 (no access check, no rate limit)", async () => {
    mockValidateScimToken.mockResolvedValue({
      ok: false,
      error: "SCIM_TOKEN_REVOKED",
    });

    const res = await authorizeScim(fakeRequest());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
  });
});
