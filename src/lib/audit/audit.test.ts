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
  withBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(p)),
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
  logAuditAsyncBothScopes,
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
// From the REAL module, not re-typed: an expectation that spells the sentinel
// itself agrees with the test rather than with production.
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { AUDIT_IP_MAX_LENGTH } from "@/lib/validations/common.server";
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

  it.each([
    ["a BigInt", { n: 1n }],
    ["a circular reference", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
  ])("survives metadata that JSON.stringify refuses (%s)", (_label, metadata) => {
    // buildOutboxPayload runs OUTSIDE logAuditAsync's try, so a throw here
    // reached the caller and skipped the dead-letter arm — no outbox row, no
    // dead-letter line. The event must still be built; only the metadata is
    // replaced.
    const payload = buildOutboxPayload({ ...baseParams, metadata: metadata as Record<string, unknown> });
    // Exact match, not objectContaining: `_reason` is a fixed token precisely
    // because an error-derived one reduced to "unknown" for every reachable
    // trigger, and a field nothing asserts is how that went unnoticed.
    expect(payload.metadata).toEqual({ _unserializable: true, _reason: "stringify_failed" });
    // The rest of the row survives — an event whose metadata did not serialize
    // is still an event, and the actor/action are what a reader needs.
    expect(payload.action).toBe(baseParams.action);
    expect(payload.userId).toBe(baseParams.userId);
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

  it("truncates ip at AUDIT_IP_MAX_LENGTH", () => {
    // The DENY arm of the pair below. audit_logs.ip is @db.VarChar(45), and an
    // over-length value does not truncate at the column — it raises 22001 in
    // the outbox worker's insert. Unlike 22P02 that error does not echo the
    // offending value, so the row cycles through max_attempts and the audit
    // event is lost with nothing left to say what it was. `ip` is also the
    // narrower column of the two AND the one fed from a request header, which
    // is why it was the asymmetry worth closing.
    const payload = buildOutboxPayload({ ...baseParams, ip: "9".repeat(200) });
    expect(payload.ip?.length).toBe(AUDIT_IP_MAX_LENGTH);
  });

  it("preserves ip and userAgent when supplied", () => {
    // The ALLOW arm: a real address is longer than nothing and shorter than the
    // cap, and must pass through byte-identical. A truncation that fired on
    // every value would satisfy the deny arm above on its own.
    const payload = buildOutboxPayload({
      ...baseParams,
      ip: "10.0.0.1",
      userAgent: "Mozilla",
    });
    expect(payload.ip).toBe("10.0.0.1");
    expect(payload.userAgent).toBe("Mozilla");
  });

  it("preserves the longest address the column is sized for, and truncates one character past it", () => {
    // The boundary, stated rather than left to the cap's arithmetic. 45 is the
    // width of an IPv4-mapped IPv6 address WITHOUT a zone id — the form below —
    // which is what common.server.ts's own note says. An earlier version of this
    // comment claimed "with a zone id"; that is false, and it mattered, because
    // it implied a zone-carrying address fits when in fact this slice truncates
    // one. The constant is imported rather than spelled, but the length
    // assertion below is a deliberate TRIP-WIRE rather than something that
    // moves with it: widening the column must force a new `widest` fixture,
    // because the widest legal address for an arbitrary width cannot be
    // synthesised.
    const widest = "0000:0000:0000:0000:0000:ffff:255.255.255.255";
    expect(widest.length).toBe(AUDIT_IP_MAX_LENGTH);
    expect(buildOutboxPayload({ ...baseParams, ip: widest }).ip).toBe(widest);

    // One past it truncates — the arm that tells "bounds at the column width"
    // from "clamps everything", which the pass-through case above starts and
    // this one finishes.
    const zoned = `${widest}%eth0`;
    const truncated = buildOutboxPayload({ ...baseParams, ip: zoned }).ip;
    expect(truncated).toBe(widest);
    expect(truncated?.length).toBe(AUDIT_IP_MAX_LENGTH);
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

  it("still enqueues when metadata cannot be serialized, rather than aborting the caller's transaction", async () => {
    // The atomic path's half of truncateMetadata's catch, and a real behaviour
    // change: the throw used to propagate out of buildOutboxPayload and roll the
    // caller's BUSINESS transaction back, so a BigInt in a metadata field failed
    // the mutation too. It now commits with the marker.
    const tx = {} as Parameters<typeof logAuditInTx>[0];
    await logAuditInTx(tx, TENANT_A, { ...baseParams, metadata: { n: 1n } });

    expect(mockedEnqueueInTx).toHaveBeenCalledOnce();
    expect(mockedEnqueueInTx.mock.calls[0][2]).toMatchObject({
      metadata: { _unserializable: true, _reason: "stringify_failed" },
      action: AUDIT_ACTION.AUTH_LOGIN,
    });
  });

  it("passes serializable metadata through on the same path", async () => {
    // The allow arm: the catch must not have turned every metadata object into
    // a marker.
    const tx = {} as Parameters<typeof logAuditInTx>[0];
    await logAuditInTx(tx, TENANT_A, { ...baseParams, metadata: { keep: 1 } });

    expect(mockedEnqueueInTx.mock.calls[0][2]).toMatchObject({ metadata: { keep: 1 } });
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
    // A malformed id is NOT the unattributable class and must not be encoded as
    // one: audit-outbox-worker refuses a payload failing UUID_RE, so enqueuing
    // would cost a poison row that retries to max_attempts instead of one warn
    // line. It is dropped here under its own reason.
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
    expect(deadLetterWarnSpy.mock.calls[0][0].reason).toBe("invalid_user_id");
  });

  it("drops only the malformed entries in a bulk batch, not the whole batch", async () => {
    // The batch is not all-or-nothing: one bad id must neither poison the
    // enqueue nor silently ride along inside it.
    mockedFindUser.mockResolvedValue({
      tenantId: TENANT_A,
    } as unknown as Awaited<ReturnType<typeof mockedFindUser>>);
    await logAuditBulkAsync([
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: USER_A },
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: "not-a-uuid" },
    ]);
    expect(mockedEnqueueBulk).toHaveBeenCalledOnce();
    expect(mockedEnqueueBulk.mock.calls[0][1]).toHaveLength(1);
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
    expect(deadLetterWarnSpy.mock.calls[0][0].reason).toBe("invalid_user_id");
  });

  it("records an unresolvable tenant under SYSTEM_TENANT_ID instead of dropping it", async () => {
    // This replaces "dead-letters when tenant cannot be resolved". That branch
    // returned WITHOUT enqueuing, so the log line was the only record — and the
    // shipped forwarder excludes it. `__system__` is the encoding of "no owning
    // tenant" in a NOT NULL column, not a fallback to somebody else's tenant.
    mockedFindUser.mockResolvedValue(null);
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
    });
    expect(mockedEnqueue).toHaveBeenCalledOnce();
    expect(mockedEnqueue.mock.calls[0][0]).toBe(SYSTEM_TENANT_ID);
    expect(deadLetterWarnSpy).not.toHaveBeenCalled();
  });

  it("records an unresolvable TEAM under SYSTEM_TENANT_ID", async () => {
    // The team branch resolves first and is a distinct path through
    // resolveTenantId; the user-miss case above does not cover it.
    mockedFindTeam.mockResolvedValue(null);
    await logAuditAsync({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      teamId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mockedFindUser).not.toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledOnce();
    expect(mockedEnqueue.mock.calls[0][0]).toBe(SYSTEM_TENANT_ID);
    expect(deadLetterWarnSpy).not.toHaveBeenCalled();
  });

  it("still binds a RESOLVABLE tenant to its own id, not to SYSTEM_TENANT_ID", async () => {
    // The allow side. Without it, a fallback that fires unconditionally passes
    // every case above.
    mockedFindUser.mockResolvedValue({
      tenantId: TENANT_A,
    } as unknown as Awaited<ReturnType<typeof mockedFindUser>>);
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
    });
    expect(mockedEnqueue).toHaveBeenCalledOnce();
    expect(mockedEnqueue.mock.calls[0][0]).toBe(TENANT_A);
    expect(mockedEnqueue.mock.calls[0][0]).not.toBe(SYSTEM_TENANT_ID);
  });

  it("never throws when enqueueAudit fails (caller-fail-safe)", async () => {
    mockedEnqueue.mockRejectedValue(new Error("DB unreachable"));
    await expect(logAuditAsync(baseParams)).resolves.toBeUndefined();
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
    const entry = deadLetterWarnSpy.mock.calls[0][0];
    expect(entry.reason).toBe("logAuditAsync_failed");
    expect(entry.error).toEqual({ name: "Error", code: "unknown" });
  });

  it("dead-letter error field carries the SQLSTATE, not the message", async () => {
    // deadLetterLogger has no redact paths. What makes that safe is that every
    // field is bounded — so the message, which is where pg names the DB role
    // and Prisma names the failing query with its bound parameters, must not
    // reach it.
    mockedEnqueue.mockRejectedValue(
      Object.assign(
        new Error('permission denied for table audit_outbox; role "passwd_app"'),
        { code: "P2010", meta: { driverAdapterError: { cause: { code: "42501" } } } },
      ),
    );
    await logAuditAsync(baseParams);
    const entry = deadLetterWarnSpy.mock.calls[0][0];
    expect(entry.error).toEqual({ name: "Error", code: "42501" });
    expect(JSON.stringify(entry)).not.toContain("passwd_app");
    expect(JSON.stringify(entry)).not.toContain("permission denied");
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

describe("logAuditAsyncBothScopes", () => {
  it("emits exactly two outbox entries — one PERSONAL, one TENANT", async () => {
    await logAuditAsyncBothScopes({
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      tenantId: TENANT_A,
    });
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    const scopes = mockedEnqueue.mock.calls.map((c) => c[1].scope);
    // Order is non-deterministic under Promise.all but the SET must equal
    // {PERSONAL, TENANT}.
    expect(new Set(scopes)).toEqual(
      new Set([AUDIT_SCOPE.PERSONAL, AUDIT_SCOPE.TENANT]),
    );
  });

  it("propagates the shared base fields to both scope emissions", async () => {
    await logAuditAsyncBothScopes({
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      tenantId: TENANT_A,
      metadata: { ip: "1.2.3.4" },
      targetId: "target-x",
    });
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    for (const [, payload] of mockedEnqueue.mock.calls) {
      expect(payload.action).toBe(AUDIT_ACTION.AUTH_LOGIN);
      expect(payload.userId).toBe(USER_A);
      expect(payload.targetId).toBe("target-x");
      expect(payload.metadata).toEqual({ ip: "1.2.3.4" });
    }
  });

  it("does not throw when one inner emission's enqueue rejects (fan-out is fail-safe)", async () => {
    // First call (PERSONAL) succeeds, second (TENANT) rejects. logAuditAsync
    // never throws, so logAuditAsyncBothScopes never throws either.
    mockedEnqueue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DB down for TENANT"));
    await expect(
      logAuditAsyncBothScopes({
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: USER_A,
        tenantId: TENANT_A,
      }),
    ).resolves.toBeUndefined();
    // Dead-letter path fires for the failed emission.
    expect(deadLetterWarnSpy).toHaveBeenCalledOnce();
  });

  it("runs the two emissions in parallel (Promise.all, not sequential)", async () => {
    // Capture invocation order via mock.invocationCallOrder. Both calls land
    // before either resolves because mockedEnqueue is synchronously resolved.
    await logAuditAsyncBothScopes({
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: USER_A,
      tenantId: TENANT_A,
    });
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    // Both calls were initiated within the same microtask flush — sequential
    // awaits would interleave dead-letter or other side effects, but here
    // the only synchronous side effect is enqueue itself.
    const [order1, order2] = mockedEnqueue.mock.invocationCallOrder;
    // Strict adjacency: no other tracked mock invocation between them.
    expect(Math.abs(order2 - order1)).toBe(1);
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

  it("records every entry under SYSTEM_TENANT_ID when tenant resolution finds none", async () => {
    // Replaces "dead-letters every entry when tenant resolution fails": the
    // bulk path had the same enqueue-less return, once per entry.
    mockedFindUser.mockResolvedValue(null);
    await logAuditBulkAsync([
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: USER_A },
      { scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: USER_A },
    ]);
    expect(mockedEnqueueBulk).toHaveBeenCalledOnce();
    expect(mockedEnqueueBulk.mock.calls[0][0]).toBe(SYSTEM_TENANT_ID);
    expect(mockedEnqueueBulk.mock.calls[0][1]).toHaveLength(2);
    expect(deadLetterWarnSpy).not.toHaveBeenCalled();
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
