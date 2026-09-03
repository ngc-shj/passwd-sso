import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

const {
  mockAuditInfo,
  mockDeadLetterWarn,
  mockEnqueueAudit,
  mockUserFindUnique,
  mockTeamFindUnique,
  mockTransaction,
  mockExecuteRaw,
} = vi.hoisted(() => ({
  mockAuditInfo: vi.fn(),
  mockDeadLetterWarn: vi.fn(),
  mockEnqueueAudit: vi.fn().mockResolvedValue(undefined),
  mockUserFindUnique: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn().mockResolvedValue(0),
}));

// Nested form, not a flat `Pick<PrismaClient, "user" | "team" | ...>` — the flat
// form selects whole delegate members and demands every method on them (TS2740).
// This form compiles, and renaming a mocked member (or the Pick<> key it comes
// from) fails to compile, which is what pins the mock to the real signature.
type MockPrisma = Pick<PrismaClient, "$transaction" | "$executeRaw"> & {
  user: Pick<PrismaClient["user"], "findUnique">;
  team: Pick<PrismaClient["team"], "findUnique">;
};

vi.mock("@/lib/prisma", () => {
  const mockPrismaClient: MockPrisma = {
    $transaction: mockTransaction,
    $executeRaw: mockExecuteRaw,
    user: { findUnique: mockUserFindUnique },
    team: { findUnique: mockTeamFindUnique },
  };
  // withBypassRls (real implementation, see the tenant-rls mock below) calls
  // prisma.$transaction(async (tx) => {...}); tx must be this same mock client
  // so the $executeRaw / user / team calls made inside land on these spies.
  mockTransaction.mockImplementation((fn: (tx: MockPrisma) => unknown) => fn(mockPrismaClient));
  return { prisma: mockPrismaClient };
});

// The REAL withBypassRls — it is what turns the $transaction/$executeRaw mock
// above into a path that actually reaches resolveTenantId's DB lookups.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
}));

vi.mock("@/lib/audit/audit-outbox", () => ({
  enqueueAudit: mockEnqueueAudit,
  enqueueAuditInTx: vi.fn(),
}));

vi.mock("@/lib/audit/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: mockAuditInfo, enabled: true },
    deadLetterLogger: { warn: mockDeadLetterWarn },
  };
});

import { logAuditAsync, sanitizeMetadata, extractRequestMeta, resolveActorType } from "@/lib/audit/audit";

describe("logAuditAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueAudit.mockResolvedValue(undefined);
    mockExecuteRaw.mockResolvedValue(0);
  });

  it("emits structured JSON to auditLogger", async () => {
    mockAuditInfo.mockReturnValue(undefined);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          userId: "user-1",
          actorType: "HUMAN",
          serviceAccountId: null,
          tenantId: null,
          teamId: null,
          targetType: null,
          targetId: null,
          ip: null,
          userAgent: null,
        }),
      }),
      "audit.AUTH_LOGIN",
    );
    // `user-1` is not a UUID, so assertEnqueueableUserId dead-letters it and
    // logAuditAsync returns BEFORE the outbox. Stated rather than left implicit:
    // every case in this group reads as end-to-end and stops at the structured
    // line, and C2's fail-loud clause is that an enqueue mock called zero times
    // without an assertion saying so is a failure, not coverage.
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("includes tenantId in structured emit when provided", async () => {
    mockAuditInfo.mockReturnValue(undefined);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
      tenantId: "tenant-1",
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          tenantId: "tenant-1",
        }),
      }),
      "audit.AUTH_LOGIN",
    );
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("passes optional fields to the auditLogger", async () => {
    mockAuditInfo.mockReturnValue(undefined);

    await logAuditAsync({
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
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("truncates metadata larger than 10KB before emitting", async () => {
    mockAuditInfo.mockReturnValue(undefined);

    const largeMetadata: Record<string, unknown> = {
      data: "x".repeat(15_000),
    };
    // R19 twin of src/lib/audit/audit.test.ts's C6 (CF17) criteria: the exact
    // byte count, not `expect.any(Number)` — the two trees must agree that
    // `_originalSize` is bytes, not UTF-16 code units. ASCII here, so the two
    // measures happen to coincide; the multi-byte case that tells them apart
    // is pinned in the co-located tree.
    const expectedOriginalSize = Buffer.byteLength(JSON.stringify(largeMetadata), "utf8");

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: "user-1",
      metadata: largeMetadata,
    });

    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          metadata: expect.objectContaining({
            _truncated: true,
            _originalSize: expectedOriginalSize,
          }),
        }),
      }),
      "audit.ENTRY_UPDATE",
    );
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("truncates user-agent to 512 chars", async () => {
    mockAuditInfo.mockReturnValue(undefined);
    const longUA = "A".repeat(1000);

    await logAuditAsync({
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
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("does not throw when auditLogger.info throws", async () => {
    mockAuditInfo.mockImplementation(() => {
      throw new Error("pino error");
    });

    await expect(
      logAuditAsync({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "user-1",
      })
    ).resolves.toBeUndefined();
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
  });

  it("does not throw when enqueueAudit rejects, and dead-letters the entry", async () => {
    mockEnqueueAudit.mockRejectedValueOnce(new Error("outbox write failed"));

    await expect(
      logAuditAsync({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
      })
    ).resolves.toBeUndefined();

    // "Did not throw" alone passes against a catch arm that swallows silently,
    // and a silent swallow is precisely what C10's still-log-only security
    // argument rests on NOT having become. The reason string is the channel that
    // says which catch ran.
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "logAuditAsync_failed" }),
      "audit.dead_letter",
    );
  });

  it("enqueues under the explicitly supplied tenantId, without resolving", async () => {
    // tenantId is supplied, so resolveTenantId's early return short-circuits
    // before either DB lookup — this is the allow arm for the sentinel cases
    // below: an explicit tenant must never be overridden by SYSTEM_TENANT_ID.
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
    });

    expect(mockDeadLetterWarn).not.toHaveBeenCalled();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
      }),
    );
    expect(mockEnqueueAudit.mock.calls[0][0]).not.toBe(SYSTEM_TENANT_ID);
  });

  it("records a UUID userId with no users row under SYSTEM_TENANT_ID", async () => {
    // Exercises the branch that used to be unreachable in this suite: a
    // well-formed UUID actor with no owning `users` row must resolve through
    // withBypassRls (real implementation) and the mocked $transaction /
    // $executeRaw / user.findUnique chain, landing under the sentinel rather
    // than dead-lettering.
    mockUserFindUnique.mockResolvedValue(null);

    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-00000000ffff",
    });

    // Asserted first: a mock-completeness regression (e.g. a missing
    // $executeRaw) throws inside withBypassRls and is caught by
    // logAuditAsync's outer try, which dead-letters instead of enqueuing —
    // this assertion is what tells that failure apart from a resolution-logic
    // regression, which instead fails the enqueue assertions below.
    expect(mockDeadLetterWarn).not.toHaveBeenCalled();
    expect(mockEnqueueAudit).toHaveBeenCalledOnce();
    expect(mockEnqueueAudit.mock.calls[0][0]).toBe(SYSTEM_TENANT_ID);
  });

  it("dead-letters a non-UUID actor with reason invalid_user_id", async () => {
    // The outbox worker refuses any payload whose userId fails UUID_RE —
    // assertEnqueueableUserId enforces that invariant before resolveTenantId
    // (and therefore before withBypassRls) ever runs.
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "user-1",
    });

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "invalid_user_id" }),
      "audit.dead_letter",
    );
  });

  it("passes actorType SERVICE_ACCOUNT and serviceAccountId", async () => {
    mockAuditInfo.mockReturnValue(undefined);

    await logAuditAsync({
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
    expect(mockEnqueueAudit).not.toHaveBeenCalled();
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
    const auth = {
      type: "token" as const,
      userId: "u1",
      tenantId: "t1",
      scopes: [] as never[],
      clientKind: "BROWSER_EXTENSION" as const,
    };
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

  it("resolveActorType(mcp_token auth) returns MCP_AGENT — the SYSTEM_ACTOR_ID/SYSTEM override for null userId is performed by the route handler, not this helper", () => {
    // resolveActorType always returns MCP_AGENT for mcp_token, regardless of userId.
    // The route handler substitutes SYSTEM_ACTOR_ID and actorType=SYSTEM when userId is null,
    // before calling logAuditAsync. This helper has no knowledge of that override.
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
