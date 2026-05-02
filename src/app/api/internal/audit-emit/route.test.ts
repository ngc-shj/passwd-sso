import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

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
        body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED },
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
        body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        userId: "user-1",
      }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("includes metadata in logAuditAsync call", async () => {
    const meta = { redirectedPath: "/dashboard", reason: "no_passkey" };
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED, metadata: meta },
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
        body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {},
      }),
    );
  });

  it("returns 400 when metadata exceeds 20 top-level keys", async () => {
    const tooManyKeys: Record<string, number> = {};
    for (let i = 0; i < 21; i++) tooManyKeys[`k${i}`] = i;

    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: tooManyKeys,
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("accepts metadata with exactly 20 top-level keys (boundary)", async () => {
    const exactKeys: Record<string, number> = {};
    for (let i = 0; i < 20; i++) exactKeys[`k${i}`] = i;

    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: exactKeys,
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 when metadata serialized size exceeds 4KB", async () => {
    // 5KB string in a single value to exceed the 4096-byte cap regardless of
    // top-level key count.
    const largePayload = { blob: "a".repeat(5 * 1024) };

    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: largePayload,
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects deeply nested payloads via the byte cap", async () => {
    // Build a deep object whose serialized size easily blows past 4KB.
    let deep: Record<string, unknown> = { leaf: "x".repeat(100) };
    for (let i = 0; i < 50; i++) {
      deep = { nested: deep, padding: "y".repeat(100) };
    }

    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: deep,
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 400 when metadata is not an object", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/internal/audit-emit", {
        body: {
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: "not-an-object",
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  describe("SETTINGS_IA_MIGRATION_V1_SEEN (client-attested action)", () => {
    it("emits with PERSONAL scope and returns 200", async () => {
      const res = await POST(
        createRequest("POST", "http://localhost/api/internal/audit-emit", {
          body: {
            action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
            scope: AUDIT_SCOPE.PERSONAL,
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
          userId: "user-1",
        }),
      );
    });

    it("rejects TENANT scope with 400 (per-action whitelist)", async () => {
      const res = await POST(
        createRequest("POST", "http://localhost/api/internal/audit-emit", {
          body: {
            action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
            scope: AUDIT_SCOPE.TENANT,
          },
        }),
      );
      expect(res.status).toBe(400);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("rejects any metadata with 400 (CLIENT_ATTESTED_ACTIONS gate)", async () => {
      const res = await POST(
        createRequest("POST", "http://localhost/api/internal/audit-emit", {
          body: {
            action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
            scope: AUDIT_SCOPE.PERSONAL,
            metadata: { anything: "at all" },
          },
        }),
      );
      expect(res.status).toBe(400);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });

  describe("scope backward compatibility", () => {
    it("PASSKEY_ENFORCEMENT_BLOCKED with no scope defaults to TENANT", async () => {
      // Existing proxy self-fetch caller does not send `scope` — verify the
      // schema default keeps the old behavior intact.
      const res = await POST(
        createRequest("POST", "http://localhost/api/internal/audit-emit", {
          body: { action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED },
        }),
      );
      expect(res.status).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AUDIT_SCOPE.TENANT,
        }),
      );
    });

    it("PASSKEY_ENFORCEMENT_BLOCKED with explicit PERSONAL scope is accepted (no per-action restriction)", async () => {
      // Actions not listed in ACTION_ALLOWED_SCOPES accept any scope.
      const res = await POST(
        createRequest("POST", "http://localhost/api/internal/audit-emit", {
          body: {
            action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
            scope: AUDIT_SCOPE.PERSONAL,
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
        }),
      );
    });
  });
});
