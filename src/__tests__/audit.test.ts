import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

const { mockCreate, mockAuditInfo, mockTeamFindUnique, mockUserFindUnique, mockWithBypassRls } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockAuditInfo: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mockCreate },
    team: { findUnique: mockTeamFindUnique },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit-logger", () => ({
  auditLogger: { info: mockAuditInfo, enabled: true },
  METADATA_BLOCKLIST: new Set([
    "password", "passphrase", "secret", "secretKey",
    "encryptedBlob", "encryptedOverview", "encryptedData", "encryptedSecretKey",
    "encryptedTeamKey", "masterPasswordServerHash",
    "token", "tokenHash", "accessToken", "refreshToken", "idToken",
    "accountSalt", "passphraseVerifierHmac",
  ]),
}));

import { logAudit, sanitizeMetadata, extractRequestMeta } from "@/lib/audit";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("logAudit", () => {
  it("creates an audit log entry", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
    });
    await flushAsyncWork();

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "user-1",
        teamId: null,
        targetType: null,
        targetId: null,
        ip: null,
        userAgent: null,
      }),
    });
  });

  it("passes optional fields when provided", async () => {
    mockTeamFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});

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
    await flushAsyncWork();

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        scope: AUDIT_SCOPE.TEAM,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: "user-1",
        tenantId: "tenant-1",
        teamId: "team-1",
        targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
        targetId: "entry-1",
        metadata: { key: "value" },
        ip: "192.168.1.1",
        userAgent: "TestAgent/1.0",
      },
    });
  });

  it("truncates metadata larger than 10KB", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
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
    await flushAsyncWork();

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          _truncated: true,
          _originalSize: expect.any(Number),
        }),
      }),
    });
  });

  it("truncates user-agent to 512 chars", async () => {
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});

    const longUA = "A".repeat(1000);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
      userAgent: longUA,
    });
    await flushAsyncWork();

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

  it("calls auditLogger.info alongside DB write", async () => {
    mockTeamFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCreate.mockResolvedValue({});
    mockAuditInfo.mockReturnValue(undefined);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "user-1",
      teamId: "team-1",
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: "entry-1",
      metadata: { filename: "test.csv" },
      ip: "10.0.0.1",
      userAgent: "TestAgent/2.0",
    });
    await flushAsyncWork();

    // DB write
    expect(mockCreate).toHaveBeenCalled();

    // pino emit
    expect(mockAuditInfo).toHaveBeenCalledWith(
      {
        audit: {
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: "user-1",
          teamId: "team-1",
          targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
          targetId: "entry-1",
          metadata: { filename: "test.csv" },
          ip: "10.0.0.1",
          userAgent: "TestAgent/2.0",
        },
      },
      "audit.ENTRY_CREATE",
    );
  });

  it("does not throw when auditLogger.info throws", () => {
    mockCreate.mockResolvedValue({});
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

describe("extractRequestMeta", () => {
  it("extracts IP from x-forwarded-for header", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": "203.0.113.1, 10.0.0.1",
        "user-agent": "Mozilla/5.0",
      },
    });

    const result = extractRequestMeta(req);

    expect(result.ip).toBe("203.0.113.1");
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
