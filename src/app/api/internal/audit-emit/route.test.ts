import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockRateLimiterCheck,
  mockLogAudit,
  mockExtractRequestMeta,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockExtractRequestMeta: vi.fn().mockReturnValue({ ip: "10.0.0.1", userAgent: "TestAgent" }),
}));

vi.mock("@/lib/auth/session/check-auth", () => ({ checkAuth: mockCheckAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: mockExtractRequestMeta,
}));
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    AUDIT_ACTION: {
      ...(actual.AUDIT_ACTION as Record<string, string>),
      PASSKEY_ENFORCEMENT_BLOCKED: "PASSKEY_ENFORCEMENT_BLOCKED",
    },
    AUDIT_SCOPE: {
      ...(actual.AUDIT_SCOPE as Record<string, string>),
      TENANT: "TENANT",
    },
  };
});

import { POST } from "./route";

function authOk(userId = "user-1") {
  return { ok: true, auth: { type: "session", userId } };
}

function authFail(status = 401) {
  return {
    ok: false,
    response: NextResponse.json({ error: "UNAUTHORIZED" }, { status }),
  };
}

describe("POST /api/internal/audit-emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAuth.mockResolvedValue(authOk());
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "PASSKEY_ENFORCEMENT_BLOCKED" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when action is not in ALLOWED_ACTIONS", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "SOME_DISALLOWED_ACTION" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when action is missing", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 and calls logAuditAsync with correct params for PASSKEY_ENFORCEMENT_BLOCKED", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "PASSKEY_ENFORCEMENT_BLOCKED" },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        userId: "user-1",
      }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "PASSKEY_ENFORCEMENT_BLOCKED" },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("includes metadata in logAuditAsync call", async () => {
    const meta = { redirectedPath: "/dashboard", reason: "no_passkey" };
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "PASSKEY_ENFORCEMENT_BLOCKED", metadata: meta },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: meta,
        ip: "10.0.0.1",
        userAgent: "TestAgent",
      }),
    );
  });

  it("uses empty object as metadata when metadata is not provided", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: "PASSKEY_ENFORCEMENT_BLOCKED" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {},
      }),
    );
  });
});
