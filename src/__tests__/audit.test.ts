import { describe, it, expect, vi } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mockCreate },
  },
}));

import { logAudit, extractRequestMeta } from "@/lib/audit";

describe("logAudit", () => {
  it("creates an audit log entry", () => {
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "user-1",
        orgId: null,
        targetType: null,
        targetId: null,
        ip: null,
        userAgent: null,
      }),
    });
  });

  it("passes optional fields when provided", () => {
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: AUDIT_SCOPE.ORG,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "user-1",
      orgId: "org-1",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "entry-1",
      metadata: { key: "value" },
      ip: "192.168.1.1",
      userAgent: "TestAgent/1.0",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        scope: AUDIT_SCOPE.ORG,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: "user-1",
        orgId: "org-1",
        targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
        targetId: "entry-1",
        metadata: { key: "value" },
        ip: "192.168.1.1",
        userAgent: "TestAgent/1.0",
      },
    });
  });

  it("truncates metadata larger than 10KB", () => {
    mockCreate.mockResolvedValue({});

    const largeMetadata: Record<string, unknown> = {
      data: "x".repeat(15_000),
    };

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: "user-1",
      metadata: largeMetadata,
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          _truncated: true,
          _originalSize: expect.any(Number),
        }),
      }),
    });
  });

  it("truncates user-agent to 512 chars", () => {
    mockCreate.mockResolvedValue({});

    const longUA = "A".repeat(1000);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
      userAgent: longUA,
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userAgent: "A".repeat(512),
      }),
    });
  });

  it("does not throw when prisma.create rejects", () => {
    mockCreate.mockRejectedValue(new Error("DB error"));

    // Should not throw
    expect(() =>
      logAudit({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "user-1",
      })
    ).not.toThrow();
  });
});

describe("extractRequestMeta", () => {
  it("extracts IP from x-forwarded-for header", () => {
    const req = new Request("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": "203.0.113.1, 10.0.0.1",
        "user-agent": "Mozilla/5.0",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractRequestMeta(req as any);

    expect(result.ip).toBe("203.0.113.1");
    expect(result.userAgent).toBe("Mozilla/5.0");
  });

  it("falls back to x-real-ip when no x-forwarded-for", () => {
    const req = new Request("http://localhost/api/test", {
      headers: {
        "x-real-ip": "198.51.100.10",
        "user-agent": "TestAgent",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractRequestMeta(req as any);

    expect(result.ip).toBe("198.51.100.10");
    expect(result.userAgent).toBe("TestAgent");
  });

  it("returns null IP when no proxy headers", () => {
    const req = new Request("http://localhost/api/test", {
      headers: {
        "user-agent": "TestAgent",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractRequestMeta(req as any);

    expect(result.ip).toBeNull();
    expect(result.userAgent).toBe("TestAgent");
  });

  it("returns null userAgent when no user-agent header", () => {
    const req = new Request("http://localhost/api/test");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = extractRequestMeta(req as any);

    expect(result.ip).toBeNull();
    expect(result.userAgent).toBeNull();
  });
});
