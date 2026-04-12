import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

const { mockAuditInfo, mockEnqueueAudit } = vi.hoisted(() => ({
  mockAuditInfo: vi.fn(),
  mockEnqueueAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
}));

vi.mock("@/lib/audit-outbox", () => ({
  enqueueAudit: mockEnqueueAudit,
  enqueueAuditInTx: vi.fn(),
}));

vi.mock("@/lib/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: mockAuditInfo, enabled: true },
  };
});

import { logAudit, sanitizeMetadata, extractRequestMeta, resolveActorType } from "@/lib/audit";

describe("logAudit", () => {
  it("pushes entry to FIFO and emits pino log synchronously", () => {
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
    });

    // pino emit happens synchronously in logAudit
    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          userId: "user-1",
          actorType: "HUMAN",
          serviceAccountId: null,
          teamId: null,
          targetType: null,
          targetId: null,
          ip: null,
          userAgent: null,
        }),
      }),
      "audit.AUTH_LOGIN",
    );
  });

  it("passes optional fields to the pino logger", () => {
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "user-1",
      teamId: "team-1",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "entry-1",
      metadata: { key: "value" },
      ip: "192.168.1.1",
      userAgent: "TestAgent/1.0",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: "user-1",
          teamId: "team-1",
          targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
          targetId: "entry-1",
          metadata: { key: "value" },
          ip: "192.168.1.1",
          userAgent: "TestAgent/1.0",
        }),
      }),
      "audit.ENTRY_CREATE",
    );
  });

  it("truncates metadata larger than 10KB before emitting pino log", () => {
    mockAuditInfo.mockReturnValue(undefined);

    const largeMetadata: Record<string, unknown> = {
      data: "x".repeat(15_000),
    };

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: "user-1",
      metadata: largeMetadata,
    });

    // pino receives sanitized (truncated) metadata
    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          metadata: expect.objectContaining({
            _truncated: true,
            _originalSize: expect.any(Number),
          }),
        }),
      }),
      "audit.ENTRY_UPDATE",
    );
  });

  it("truncates user-agent to 512 chars", () => {
    mockAuditInfo.mockReturnValue(undefined);
    const longUA = "A".repeat(1000);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
      userAgent: longUA,
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          userAgent: "A".repeat(512),
        }),
      }),
      "audit.AUTH_LOGIN",
    );
  });

  it("does not throw when auditLogger.info throws", () => {
    mockAuditInfo.mockImplementation(() => {
      throw new Error("pino error");
    });

    expect(() =>
      logAudit({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "user-1",
      })
    ).not.toThrow();
  });

  it("passes actorType SERVICE_ACCOUNT and serviceAccountId to pino logger", () => {
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "user-1",
      actorType: "SERVICE_ACCOUNT",
      serviceAccountId: "sa-1",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          actorType: "SERVICE_ACCOUNT",
          serviceAccountId: "sa-1",
        }),
      }),
      expect.any(String),
    );
  });
});

describe("sanitizeMetadata", () => {
  it("returns null/undefined as-is", () => {
    expect(sanitizeMetadata(null)).toBeNull();
    expect(sanitizeMetadata(undefined)).toBeUndefined();
  });

  it("returns primitive values as-is", () => {
    expect(sanitizeMetadata("hello")).toBe("hello");
    expect(sanitizeMetadata(42)).toBe(42);
    expect(sanitizeMetadata(true)).toBe(true);
  });

  it("strips top-level blocklist keys", () => {
    const input = {
      filename: "export.csv",
      password: "secret123",
      count: 5,
      token: "bearer-xyz",
    };
    expect(sanitizeMetadata(input)).toEqual({
      filename: "export.csv",
      count: 5,
    });
  });

  it("strips nested blocklist keys recursively", () => {
    const input = {
      outer: {
        inner: {
          token: "hidden",
          visible: "ok",
        },
        secretKey: "also-hidden",
        name: "keep",
      },
    };
    expect(sanitizeMetadata(input)).toEqual({
      outer: {
        inner: {
          visible: "ok",
        },
        name: "keep",
      },
    });
  });

  it("strips blocklist keys inside arrays", () => {
    const input = {
      items: [
        { id: "1", password: "secret" },
        { id: "2", token: "bearer" },
        { id: "3" },
      ],
    };
    expect(sanitizeMetadata(input)).toEqual({
      items: [
        { id: "1" },
        { id: "2" },
        { id: "3" },
      ],
    });
  });

  it("removes undefined from arrays (no holes)", () => {
    // An object with only blocklist keys becomes undefined,
    // which should be filtered from the array
    const input = {
      items: [
        { password: "secret" },
        { id: "keep" },
        { token: "hidden" },
      ],
    };
    const result = sanitizeMetadata(input) as Record<string, unknown>;
    const items = result.items as unknown[];
    expect(items).toEqual([{ id: "keep" }]);
    expect(items).not.toContain(undefined);
  });

  it("preserves normal keys at all levels", () => {
    const input = {
      filename: "passwords.csv",
      format: "csv",
      stats: {
        entryCount: 42,
        failedCount: 0,
      },
    };
    expect(sanitizeMetadata(input)).toEqual(input);
  });

  it("returns undefined when all keys are blocklisted", () => {
    const input = {
      password: "secret",
      token: "xyz",
    };
    expect(sanitizeMetadata(input)).toBeUndefined();
  });
});

describe("resolveActorType", () => {
  it("returns SERVICE_ACCOUNT for service_account auth", () => {
    const auth = {
      type: "service_account" as const,
      serviceAccountId: "sa-1",
      tenantId: "t1",
      tokenId: "tok-1",
      scopes: [] as never[],
    };
    expect(resolveActorType(auth)).toBe("SERVICE_ACCOUNT");
  });

  it("returns HUMAN for session auth", () => {
    const auth = { type: "session" as const, userId: "u1" };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("returns HUMAN for token auth", () => {
    const auth = { type: "token" as const, userId: "u1", scopes: [] as never[] };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("returns HUMAN for api_key auth", () => {
    const auth = {
      type: "api_key" as const,
      userId: "u1",
      tenantId: "t1",
      apiKeyId: "ak1",
      scopes: [] as never[],
    };
    expect(resolveActorType(auth)).toBe("HUMAN");
  });

  it("returns MCP_AGENT for mcp_token auth", () => {
    const auth = {
      type: "mcp_token" as const,
      userId: "u1",
      tenantId: "t1",
      tokenId: "tok-1",
      mcpClientId: "mcpc_abc",
      scopes: [] as never[],
    };
    expect(resolveActorType(auth)).toBe("MCP_AGENT");
  });

  it("returns MCP_AGENT for mcp_token auth with userId null", () => {
    const auth = {
      type: "mcp_token" as const,
      userId: null,
      tenantId: "t1",
      tokenId: "tok-1",
      mcpClientId: "mcpc_abc",
      scopes: [] as never[],
    };
    expect(resolveActorType(auth)).toBe("MCP_AGENT");
  });
});

describe("extractRequestMeta", () => {
  it("extracts IP from x-forwarded-for header", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": "203.0.113.1, 10.0.0.1",
        "user-agent": "Mozilla/5.0",
      },
    });

    const result = extractRequestMeta(req);

    // rightmost-untrusted: "203.0.113.1, 10.0.0.1" → "10.0.0.1" is rightmost untrusted
    expect(result.ip).toBe("10.0.0.1");
    expect(result.userAgent).toBe("Mozilla/5.0");
  });

  it("falls back to x-real-ip when no x-forwarded-for", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "x-real-ip": "198.51.100.10",
        "user-agent": "TestAgent",
      },
    });

    const result = extractRequestMeta(req);

    expect(result.ip).toBe("198.51.100.10");
    expect(result.userAgent).toBe("TestAgent");
  });

  it("returns null IP when no proxy headers", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "user-agent": "TestAgent",
      },
    });

    const result = extractRequestMeta(req);

    expect(result.ip).toBeNull();
    expect(result.userAgent).toBe("TestAgent");
  });

  it("returns null userAgent when no user-agent header", () => {
    const req = new NextRequest("http://localhost/api/test");

    const result = extractRequestMeta(req);

    expect(result.ip).toBeNull();
    expect(result.userAgent).toBeNull();
  });
});
