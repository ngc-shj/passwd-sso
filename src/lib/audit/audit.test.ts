import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { AuthResult } from "@/lib/auth/session/auth-or-token";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
  BYPASS_PURPOSE: { AUDIT_WRITE: "audit_write" },
}));

vi.mock("@/lib/audit/audit-outbox", () => ({
  enqueueAudit: vi.fn(async () => undefined),
  enqueueAuditInTx: vi.fn(async () => undefined),
  enqueueAuditBulk: vi.fn(async () => undefined),
}));

const { auditLoggerInfoSpy, deadLetterWarnSpy } = vi.hoisted(() => ({
  auditLoggerInfoSpy: vi.fn(),
  deadLetterWarnSpy: vi.fn(),
}));
vi.mock("@/lib/audit/audit-logger", () => ({
  auditLogger: { info: auditLoggerInfoSpy },
  deadLetterLogger: { warn: deadLetterWarnSpy },
  METADATA_BLOCKLIST: new Set([
    "password",
    "passphrase",
    "secret",
    "secretKey",
    "encryptedBlob",
    "encryptedOverview",
    "encryptedData",
    "encryptedSecretKey",
    "encryptedTeamKey",
    "masterPasswordServerHash",
    "token",
    "tokenHash",
    "accessToken",
    "refreshToken",
    "idToken",
    "accountSalt",
    "passphraseVerifierHmac",
    "storedVersion",
    "entries",
  ]),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn(() => "1.2.3.4"),
}));

import {
  buildOutboxPayload,
  sanitizeMetadata,
  resolveActorType,
  logAuditAsync,
  logAuditBulkAsync,
  logAuditInTx,
  extractRequestMeta,
  personalAuditBase,
  teamAuditBase,
  tenantAuditBase,
  type AuditLogParams,
} from "./audit";
import { ACTOR_TYPE, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { enqueueAudit, enqueueAuditBulk, enqueueAuditInTx } from "@/lib/audit/audit-outbox";
import { prisma } from "@/lib/prisma";

const TENANT_A = "550e8400-e29b-41d4-a716-446655440000";
const USER_A = "660e8400-e29b-41d4-a716-446655440001";
const TEAM_A = "770e8400-e29b-41d4-a716-446655440002";

const mockedEnqueue = vi.mocked(enqueueAudit);
const mockedEnqueueBulk = vi.mocked(enqueueAuditBulk);
const mockedEnqueueInTx = vi.mocked(enqueueAuditInTx);
const mockedFindUser = vi.mocked(prisma.user.findUnique);
const mockedFindTeam = vi.mocked(prisma.team.findUnique);

beforeEach(() => {
  auditLoggerInfoSpy.mockReset();
  deadLetterWarnSpy.mockReset();
  mockedEnqueue.mockReset().mockResolvedValue(undefined);
  mockedEnqueueBulk.mockReset().mockResolvedValue(undefined);
  mockedEnqueueInTx.mockReset().mockResolvedValue(undefined);
  mockedFindUser.mockReset();
  mockedFindTeam.mockReset();
});

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

const baseParams: AuditLogParams = {
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.AUTH_LOGIN,
  userId: USER_A,
  tenantId: TENANT_A,
};

describe("resolveActorType", () => {
  it.each([
    ["session", ACTOR_TYPE.HUMAN],
    ["token", ACTOR_TYPE.HUMAN],
    ["api_key", ACTOR_TYPE.HUMAN],
    ["service_account", ACTOR_TYPE.SERVICE_ACCOUNT],
    ["mcp_token", ACTOR_TYPE.MCP_AGENT],
  ] as const)("maps auth.type=%s → %s", (type, expected) => {
    const auth = { type } as AuthResult;
    expect(resolveActorType(auth)).toBe(expected);
  });
});

describe("sanitizeMetadata", () => {
  it("returns null/undefined unchanged", () => {
    expect(sanitizeMetadata(null)).toBeNull();
    expect(sanitizeMetadata(undefined)).toBeUndefined();
  });

  it("removes blocklisted top-level keys", () => {
    const result = sanitizeMetadata({ password: "x", visible: "y" });
    expect(result).toEqual({ visible: "y" });
  });

  it("recursively strips blocklisted keys from nested objects", () => {
    const result = sanitizeMetadata({
      outer: { token: "x", visible: "y" },
      keep: 1,
    });
    expect(result).toEqual({ outer: { visible: "y" }, keep: 1 });
  });

  it("returns undefined for object that becomes empty after stripping", () => {
    const result = sanitizeMetadata({ password: "x" });
    expect(result).toBeUndefined();
  });

  it("filters arrays of objects, removing blocklisted keys per element", () => {
    const result = sanitizeMetadata([
      { password: "x", visible: "y" },
      { keep: 1 },
    ]);
    expect(result).toEqual([{ visible: "y" }, { keep: 1 }]);
  });

  it("filters undefined entries from arrays after sanitization", () => {
    const result = sanitizeMetadata([{ password: "x" }, { keep: 1 }]);
    expect(result).toEqual([{ keep: 1 }]);
  });

  it("returns primitive values unchanged", () => {
    expect(sanitizeMetadata("hello")).toBe("hello");
    expect(sanitizeMetadata(42)).toBe(42);
    expect(sanitizeMetadata(true)).toBe(true);
  });
});

describe("buildOutboxPayload", () => {
  it("defaults actorType to HUMAN", () => {
    const payload = buildOutboxPayload(baseParams);
    expect(payload.actorType).toBe(ACTOR_TYPE.HUMAN);
  });

  it("preserves explicit actorType override", () => {
    const payload = buildOutboxPayload({ ...baseParams, actorType: ACTOR_TYPE.SYSTEM });
    expect(payload.actorType).toBe(ACTOR_TYPE.SYSTEM);
  });

  it("nullifies missing optional fields (serviceAccountId / teamId / target / ip / userAgent)", () => {
    const payload = buildOutboxPayload(baseParams);
    expect(payload.serviceAccountId).toBeNull();
    expect(payload.teamId).toBeNull();
    expect(payload.targetType).toBeNull();
    expect(payload.targetId).toBeNull();
    expect(payload.ip).toBeNull();
    expect(payload.userAgent).toBeNull();
  });

  it("sanitizes metadata (drops blocklisted keys)", () => {
    const payload = buildOutboxPayload({
      ...baseParams,
      metadata: { password: "x", keep: 1 },
    });
    expect(payload.metadata).toEqual({ keep: 1 });
  });

  it("truncates oversize metadata to a sentinel _truncated marker", () => {
    const huge = "x".repeat(100_000);
    const payload = buildOutboxPayload({
      ...baseParams,
      metadata: { huge },
    });
    expect(payload.metadata).toEqual(
      expect.objectContaining({ _truncated: true }),
    );
    expect(payload.metadata).not.toHaveProperty("huge");
  });

  it("passes through metadata unchanged when within byte limit", () => {
    const payload = buildOutboxPayload({
      ...baseParams,
      metadata: { foo: "bar" },
    });
    expect(payload.metadata).toEqual({ foo: "bar" });
  });

  it("truncates userAgent at USER_AGENT_MAX_LENGTH", () => {
    const longUa = "a".repeat(2000);
    const payload = buildOutboxPayload({ ...baseParams, userAgent: longUa });
    // USER_AGENT_MAX_LENGTH = 512 per validations/common.server
    expect(payload.userAgent?.length).toBeLessThanOrEqual(512);
  });

  it("preserves ip and userAgent when supplied", () => {
    const payload = buildOutboxPayload({
      ...baseParams,
      ip: "10.0.0.1",
      userAgent: "Mozilla",
    });
    expect(payload.ip).toBe("10.0.0.1");
    expect(payload.userAgent).toBe("Mozilla");
  });
});

describe("logAuditInTx", () => {
  it("delegates to enqueueAuditInTx with mapped payload", async () => {
    const tx = {} as Parameters<typeof logAuditInTx>[0];
    await logAuditInTx(tx, TENANT_A, baseParams);

    expect(mockedEnqueueInTx).toHaveBeenCalledOnce();
    const [calledTx, calledTenant, calledPayload] = mockedEnqueueInTx.mock.calls[0];
    expect(calledTx).toBe(tx);
    expect(calledTenant).toBe(TENANT_A);
    expect(calledPayload).toMatchObject({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      actorType: ACTOR_TYPE.HUMAN,
    });
  });
});

describe("logAuditAsync", () => {
  it("emits structured JSON via auditLogger.info", async () => {
    await logAuditAsync(baseParams);
    expect(auditLoggerInfoSpy).toHaveBeenCalledOnce();
    const [logArg, msg] = auditLoggerInfoSpy.mock.calls[0];
    expect(msg).toBe(`audit.${AUDIT_ACTION.AUTH_LOGIN}`);
    expect(logArg.audit.userId).toBe(USER_A);
    expect(logArg.audit.tenantId).toBe(TENANT_A);
  });

  it("enqueues outbox row with correct tenant + payload", async () => {
    await logAuditAsync(baseParams);
    expect(mockedEnqueue).toHaveBeenCalledOnce();
    const [calledTenant, calledPayload] = mockedEnqueue.mock.calls[0];
    expect(calledTenant).toBe(TENANT_A);
    expect(calledPayload).toMatchObject({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
    });
  });

  it("uses params.tenantId without DB lookup when provided", async () => {
    await logAuditAsync(baseParams);
    expect(mockedFindUser).not.toHaveBeenCalled();
    expect(mockedFindTeam).not.toHaveBeenCalled();
  });

  it("resolves tenantId from team when only teamId is provided", async () => {
    mockedFindTeam.mockResolvedValue({
      tenantId: TENANT_A,
    } as unknown as Awaited<ReturnType<typeof mockedFindTeam>>);
    await logAuditAsync({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      teamId: TEAM_A,
    });
    expect(mockedFindTeam).toHaveBeenCalledWith({
      where: { id: TEAM_A },
      select: { tenantId: true },
    });
    expect(mockedEnqueue).toHaveBeenCalledOnce();
    expect(mockedEnqueue.mock.calls[0][0]).toBe(TENANT_A);
  });

  it("resolves tenantId from user when only userId is provided", async () => {
    mockedFindUser.mockResolvedValue({
      tenantId: TENANT_A,
    } as unknown as Awaited<ReturnType<typeof mockedFindUser>>);
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
    });
    expect(mockedFindUser).toHaveBeenCalledWith({
      where: { id: USER_A },
      select: { tenantId: true },
    });
    expect(mockedEnqueue).toHaveBeenCalledOnce();
  });

  it("does not query user table when userId is non-UUID (defense-in-depth)", async () => {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "not-a-uuid",
    });
    expect(mockedFindUser).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
  });

  it("dead-letters when tenant cannot be resolved", async () => {
    mockedFindUser.mockResolvedValue(null);
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
    });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
    const entry = deadLetterWarnSpy.mock.calls[0][0];
    expect(entry.reason).toBe("tenant_not_found");
  });

  it("never throws when enqueueAudit fails (caller-fail-safe)", async () => {
    mockedEnqueue.mockRejectedValue(new Error("DB unreachable"));
    await expect(logAuditAsync(baseParams)).resolves.toBeUndefined();
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
    const entry = deadLetterWarnSpy.mock.calls[0][0];
    expect(entry.reason).toBe("logAuditAsync_failed");
    expect(entry.error).toContain("DB unreachable");
  });

  it("dead-letter payload never includes raw metadata", async () => {
    mockedEnqueue.mockRejectedValue(new Error("boom"));
    await logAuditAsync({
      ...baseParams,
      metadata: { password: "must-not-leak" },
    });
    const entry = deadLetterWarnSpy.mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain("must-not-leak");
  });

  it("does not throw when auditLogger.info itself throws (forwarding-fail-safe)", async () => {
    auditLoggerInfoSpy.mockImplementationOnce(() => {
      throw new Error("logger broken");
    });
    await expect(logAuditAsync(baseParams)).resolves.toBeUndefined();
    expect(mockedEnqueue).toHaveBeenCalledOnce();
  });
});

describe("logAuditBulkAsync", () => {
  it("returns early on empty list", async () => {
    await logAuditBulkAsync([]);
    expect(mockedEnqueueBulk).not.toHaveBeenCalled();
    expect(auditLoggerInfoSpy).not.toHaveBeenCalled();
  });

  it("emits one logger info per param entry", async () => {
    await logAuditBulkAsync([baseParams, baseParams, baseParams]);
    expect(auditLoggerInfoSpy).toHaveBeenCalledTimes(3);
  });

  it("calls enqueueAuditBulk once with all payloads", async () => {
    await logAuditBulkAsync([baseParams, baseParams]);
    expect(mockedEnqueueBulk).toHaveBeenCalledOnce();
    const [tenantId, payloads] = mockedEnqueueBulk.mock.calls[0];
    expect(tenantId).toBe(TENANT_A);
    expect(payloads).toHaveLength(2);
  });

  it("dead-letters every entry when tenant resolution fails", async () => {
    mockedFindUser.mockResolvedValue(null);
    await logAuditBulkAsync([
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: USER_A },
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: USER_A },
    ]);
    expect(mockedEnqueueBulk).not.toHaveBeenCalled();
    expect(deadLetterWarnSpy).toHaveBeenCalledTimes(2);
  });

  it("dead-letters every entry when enqueueAuditBulk fails", async () => {
    mockedEnqueueBulk.mockRejectedValue(new Error("bulk insert error"));
    await logAuditBulkAsync([baseParams, baseParams]);
    expect(deadLetterWarnSpy).toHaveBeenCalledTimes(2);
  });

  it("never throws even when logger.info throws inside the loop", async () => {
    auditLoggerInfoSpy.mockImplementation(() => {
      throw new Error("logger broken");
    });
    await expect(logAuditBulkAsync([baseParams, baseParams])).resolves.toBeUndefined();
    expect(mockedEnqueueBulk).toHaveBeenCalledOnce();
  });
});

describe("extractRequestMeta", () => {
  it("returns ip from extractClientIp + ua + accept-language headers", () => {
    const req = makeReq({
      "user-agent": "Mozilla/5.0",
      "accept-language": "ja-JP,ja;q=0.9",
    });
    const meta = extractRequestMeta(req);
    expect(meta.ip).toBe("1.2.3.4");
    expect(meta.userAgent).toBe("Mozilla/5.0");
    expect(meta.acceptLanguage).toBe("ja-JP,ja;q=0.9");
  });

  it("returns null for absent headers", () => {
    const req = makeReq({});
    const meta = extractRequestMeta(req);
    expect(meta.userAgent).toBeNull();
    expect(meta.acceptLanguage).toBeNull();
  });
});

describe("personalAuditBase / teamAuditBase / tenantAuditBase", () => {
  it("personalAuditBase fills scope=PERSONAL and request meta", () => {
    const req = makeReq({ "user-agent": "ua" });
    const base = personalAuditBase(req, USER_A);
    expect(base.scope).toBe(AUDIT_SCOPE.PERSONAL);
    expect(base.userId).toBe(USER_A);
    expect(base.userAgent).toBe("ua");
  });

  it("teamAuditBase fills scope=TEAM, userId, teamId, and request meta", () => {
    const req = makeReq({});
    const base = teamAuditBase(req, USER_A, TEAM_A);
    expect(base.scope).toBe(AUDIT_SCOPE.TEAM);
    expect(base.userId).toBe(USER_A);
    expect(base.teamId).toBe(TEAM_A);
  });

  it("tenantAuditBase fills scope=TENANT, userId, tenantId, and request meta", () => {
    const req = makeReq({});
    const base = tenantAuditBase(req, USER_A, TENANT_A);
    expect(base.scope).toBe(AUDIT_SCOPE.TENANT);
    expect(base.userId).toBe(USER_A);
    expect(base.tenantId).toBe(TENANT_A);
  });
});
