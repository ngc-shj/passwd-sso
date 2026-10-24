/**
 * Unit tests for AuditAnchorPublisher.
 *
 * Covers:
 *   - cadence math and the manifest key builder
 *   - runCadence(boundary): the attempt-count transaction (marker re-check,
 *     no-tenant skip, the persisted cap), the publish transaction (lock_held
 *     from a nested 55P03, the marker and its absent-marker derivation,
 *     every tenant published whatever its pause, upload / commit failures,
 *     the upload bound), and the cadence / healthy log lines
 *   - the publisher's own audit write: one outbox row per emit site, written
 *     after the publish transaction, never throwing
 *   - DeploymentIdMismatchError and createPublisher
 *
 * The database is a fake transaction client holding `system_settings` and the
 * anchors in memory; audit rows are asserted at its `auditOutbox.createMany`
 * boundary. anchor-manifest functions run for real (they use `node:crypto`;
 * mocking would silently disable signing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AuditAnchorPublisher,
  DeploymentIdMismatchError,
  PUBLISHER_AUDIT_DEAD_LETTER_REASON,
  buildManifestArtifactKey,
  createPublisher,
  currentCadenceBoundary,
  previousCadenceBoundary,
  type CadenceOutcome,
  type PublisherConfig,
} from "./audit-anchor-publisher";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockLoggerInfo, mockLoggerError, mockLoggerWarn, mockAuditInfo, mockDeadLetterWarn } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockAuditInfo: vi.fn(),
  mockDeadLetterWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: vi.fn(),
  }),
}));

vi.mock("@/lib/audit/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: mockAuditInfo },
    deadLetterLogger: { warn: mockDeadLetterWarn },
  };
});

// ─── Test fixtures ───────────────────────────────────────────────────────────

const TENANT_ID_1 = "11111111-1111-4111-8111-111111111111";
const TENANT_ID_2 = "22222222-2222-4222-8222-222222222222";

const SIGNING_KEY = randomBytes(32);
const TAG_SECRET = randomBytes(32);
const KID = "audit-anchor-0123456789abcdef";

const CADENCE_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = 5 * 60 * 1000;

const BOUNDARY = new Date("2026-01-15T00:05:00.000Z");
const WALL_CLOCK = new Date("2026-01-15T01:00:00.000Z");

const MARKER_KEY = "audit_anchor_last_published_boundary";
const ATTEMPTS_KEY = "audit_anchor_upload_attempts";
const POINTER_KEY = "audit_anchor_previous_manifest";

/** The shape the Prisma pg adapter gives a raw-query 55P03: nested under P2010. */
function lockTimeoutError(): Error {
  return Object.assign(new Error("Raw query failed."), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: "55P03", kind: "postgres" } } },
  });
}

function makeDestination(
  name: string,
  upload: AnchorDestination["upload"] = vi.fn().mockResolvedValue(undefined),
): AnchorDestination {
  return { name, upload };
}

function makeConfig(overrides: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    deploymentId: "deploy-x",
    signingKey: SIGNING_KEY,
    signingKeyKid: KID,
    tagSecret: TAG_SECRET,
    destinations: [makeDestination("filesystem")],
    cadenceMs: CADENCE_MS,
    publishOffsetMs: OFFSET_MS,
    ...overrides,
  };
}

interface FakeAnchor {
  tenantId: string;
  chainSeq: bigint;
  prevHash: Buffer;
  epoch: number | null;
  publishPausedUntil: Date | null;
  lastPublishedAt: Date | null;
  updatedAt: Date;
}

interface FakeDb {
  /** Advisory-lock attempts that raise 55P03, by call number (1-based). */
  lockTimeoutOnCall: Set<number>;
  lockCalls: number;
  tenants: Array<{ id: string; auditChainEnabled: boolean }>;
  anchors: FakeAnchor[];
  settings: Map<string, string>;
  storedDeploymentId: string | null;
  updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  outboxRows: Array<{ txIndex: number; tenantId: string; payload: Record<string, unknown> }>;
  outboxFailure: Error | null;
  /** Index of each $transaction call, in order. */
  txCount: number;
  publishTxIndex: number | null;
}

function anchor(tenantId: string, overrides: Partial<FakeAnchor> = {}): FakeAnchor {
  return {
    tenantId,
    chainSeq: 1n,
    prevHash: Buffer.alloc(32, 0xa1),
    epoch: 1,
    publishPausedUntil: null,
    lastPublishedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    lockTimeoutOnCall: new Set(),
    lockCalls: 0,
    tenants: [
      { id: TENANT_ID_1, auditChainEnabled: true },
      { id: TENANT_ID_2, auditChainEnabled: true },
    ],
    anchors: [anchor(TENANT_ID_1), anchor(TENANT_ID_2, { chainSeq: 2n, prevHash: Buffer.alloc(32, 0xb2) })],
    settings: new Map(),
    storedDeploymentId: null,
    updateManyCalls: [],
    outboxRows: [],
    outboxFailure: null,
    txCount: 0,
    publishTxIndex: null,
    ...overrides,
  };
}

function makeFakeTx(db: FakeDb, txIndex: number) {
  return {
    $executeRaw: vi.fn(async (template: TemplateStringsArray) => {
      const sql = template.raw.join("$");
      if (sql.includes("pg_advisory_xact_lock")) {
        db.lockCalls++;
        if (db.lockTimeoutOnCall.has(db.lockCalls)) throw lockTimeoutError();
        // The second lock of a run is the publish transaction's.
        if (db.lockCalls % 2 === 0) db.publishTxIndex = txIndex;
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
      const sql = template.raw.join("$");
      if (sql.includes("SELECT value FROM system_settings WHERE key =") && values[0] === "audit_anchor_deployment_id") {
        return db.storedDeploymentId !== null ? [{ value: db.storedDeploymentId }] : [];
      }
      if (sql.includes("MAX(last_published_at)")) {
        const ids = values[0] as string[];
        const times = db.anchors
          .filter((a) => ids.includes(a.tenantId) && a.lastPublishedAt)
          .map((a) => (a.lastPublishedAt as Date).getTime());
        return [{ max_published: times.length > 0 ? new Date(Math.max(...times)) : null }];
      }
      return [];
    }),
    tenant: {
      findMany: vi.fn(async () => db.tenants.filter((t) => t.auditChainEnabled).map((t) => ({ id: t.id }))),
    },
    auditChainAnchor: {
      findMany: vi.fn(async () => db.anchors),
      findFirst: vi.fn(async () => (db.anchors[0] ? { tenantId: db.anchors[0].tenantId } : null)),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.updateManyCalls.push(args);
        return { count: db.anchors.length };
      }),
    },
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const value = db.settings.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      }),
      upsert: vi.fn(async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        db.settings.set(where.key, update.value);
        return {};
      }),
    },
    auditOutbox: {
      createMany: vi.fn(async ({ data }: { data: Array<{ tenantId: string; payload: Record<string, unknown> }> }) => {
        if (db.outboxFailure) throw db.outboxFailure;
        for (const row of data) db.outboxRows.push({ txIndex, ...row });
        return { count: data.length };
      }),
    },
  };
}

function makeFakePrisma(db: FakeDb): PrismaClient {
  const fakePrisma: Pick<PrismaClient, "$transaction" | "$disconnect"> = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      db.txCount++;
      return fn(makeFakeTx(db, db.txCount));
    }) as unknown as PrismaClient["$transaction"],
    $disconnect: vi.fn().mockResolvedValue(undefined) as unknown as PrismaClient["$disconnect"],
  };
  return fakePrisma as unknown as PrismaClient;
}

function publisherFor(db: FakeDb, overrides: Partial<PublisherConfig> = {}): AuditAnchorPublisher {
  return new AuditAnchorPublisher({ prisma: makeFakePrisma(db), config: makeConfig(overrides) });
}

function outboxActions(db: FakeDb): unknown[] {
  return db.outboxRows.map((r) => r.payload.action);
}

function failureReasons(db: FakeDb): unknown[] {
  return db.outboxRows
    .filter((r) => r.payload.action === "AUDIT_ANCHOR_PUBLISH_FAILED")
    .map((r) => (r.payload.metadata as Record<string, unknown>).failureReason);
}

function logTypes(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(([fields]) => (fields as { _logType?: unknown })._logType);
}

function pauseWrites(db: FakeDb) {
  return db.updateManyCalls.filter((c) => c.data.publishPausedUntil instanceof Date);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(WALL_CLOCK);
  mockLoggerInfo.mockClear();
  mockLoggerError.mockClear();
  mockLoggerWarn.mockClear();
  mockAuditInfo.mockClear();
  mockDeadLetterWarn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── cadence math ───────────────────────────────────────────────────────────

describe("cadence math", () => {
  it("currentCadenceBoundary aligns to floor((now - offset) / cadence) * cadence + offset", () => {
    const now = new Date("2026-01-15T12:34:56Z");
    const boundary = currentCadenceBoundary(now, CADENCE_MS, OFFSET_MS);
    expect(boundary.toISOString()).toBe("2026-01-15T00:05:00.000Z");
  });

  it("previousCadenceBoundary returns one cadence prior to current", () => {
    const now = new Date("2026-01-15T12:34:56Z");
    const prev = previousCadenceBoundary(now, CADENCE_MS, OFFSET_MS);
    expect(prev.toISOString()).toBe("2026-01-14T00:05:00.000Z");
  });

  it("currentCadenceBoundary is idempotent on a boundary moment", () => {
    const onBoundary = new Date("2026-01-15T00:05:00Z");
    const result = currentCadenceBoundary(onBoundary, CADENCE_MS, OFFSET_MS);
    expect(result.getTime()).toBe(onBoundary.getTime());
  });

  it("currentCadenceBoundary handles zero offset", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const boundary = currentCadenceBoundary(now, CADENCE_MS, 0);
    expect(boundary.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("buildManifestArtifactKey", () => {
  it("builds YYYY-MM-DD.kid-<kid>.jws from the boundary's UTC date", () => {
    expect(buildManifestArtifactKey(new Date("2026-01-15T00:05:00Z"), KID)).toBe(
      `2026-01-15.kid-${KID}.jws`,
    );
  });
});

// ─── runCadence: gates ──────────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — gates", () => {
  it("returns lock_held when the attempt transaction's lock wait raises 55P03 nested under P2010", async () => {
    const db = makeDb({ lockTimeoutOnCall: new Set([1]) });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toEqual({ kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE", chainEnabledTenantCount: 2 });
    expect(db.outboxRows).toEqual([]);
    expect(pauseWrites(db)).toEqual([]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
  });

  it("returns lock_held, not failed, when the publish transaction's lock wait times out", async () => {
    const db = makeDb({ lockTimeoutOnCall: new Set([2]) });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("lock_held");
    expect(db.outboxRows).toEqual([]);
    expect(pauseWrites(db)).toEqual([]);
  });

  it("returns skipped_no_tenants without counting an attempt, everChainEnabled false when no anchor row exists", async () => {
    const db = makeDb({ tenants: [], anchors: [] });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: false,
      chainEnabledTenantCount: 0,
    });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
  });

  it("reports everChainEnabled true when an anchor row exists but no tenant is chain-enabled", async () => {
    const db = makeDb({ tenants: [{ id: TENANT_ID_1, auditChainEnabled: false }] });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "skipped_no_tenants", everChainEnabled: true });
  });

  it("returns skipped_already_published when the marker equals the boundary", async () => {
    const db = makeDb();
    db.settings.set(MARKER_KEY, BOUNDARY.toISOString());
    const upload = vi.fn().mockResolvedValue(undefined);
    const outcome = await publisherFor(db, { destinations: [makeDestination("s3", upload)] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_already_published",
      reason: "BOUNDARY_ALREADY_PUBLISHED",
      chainEnabledTenantCount: 2,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
  });

  it("publishes when the marker holds a different boundary", async () => {
    const db = makeDb();
    db.settings.set(MARKER_KEY, new Date(BOUNDARY.getTime() - CADENCE_MS).toISOString());
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("published");
    expect(db.settings.get(MARKER_KEY)).toBe(BOUNDARY.toISOString());
  });

  it("derives the absent marker from last_published_at at or after the boundary", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: BOUNDARY }), anchor(TENANT_ID_2)] });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("skipped_already_published");
  });

  it("publishes when the absent marker's last_published_at is below the boundary", async () => {
    const db = makeDb({
      anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(BOUNDARY.getTime() - 1) }), anchor(TENANT_ID_2)],
    });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("published");
  });
});

// ─── runCadence: attempt cap ────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — persisted attempt cap", () => {
  it("counts each run against the boundary, resetting to 1 for a new boundary", async () => {
    const db = makeDb();
    const failing = makeDestination("s3", vi.fn().mockRejectedValue(new Error("down")));
    const publisher = publisherFor(db, { destinations: [failing] });

    await publisher.runCadence(BOUNDARY);
    await publisher.runCadence(BOUNDARY);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 2 });

    const next = new Date(BOUNDARY.getTime() + CADENCE_MS);
    await publisher.runCadence(next);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: next.toISOString(), count: 1 });
  });

  it.each([
    ["is not JSON", "{not json"],
    ["does not match the schema", JSON.stringify({ boundary: BOUNDARY.toISOString(), count: 0 })],
  ])("treats the boundary as past the cap when the stored count %s, overwriting it", async (_label, stored) => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, stored);
    const upload = vi.fn().mockResolvedValue(undefined);
    const outcome = await publisherFor(db, { destinations: [makeDestination("s3", upload)] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "upload_cap_reached",
      reason: "UPLOAD_ATTEMPT_CAP_REACHED",
      attempts: 4,
      chainEnabledTenantCount: 2,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 4 });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_COUNT_UNREADABLE"]);
    const capLines = mockLoggerError.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((f) => f._logType === "audit-anchor-publisher.upload_cap_reached");
    expect(capLines).toEqual([expect.objectContaining({ countUnreadable: true, attempts: 4 })]);
  });

  it("after an unreadable count, writes no second row for the boundary and counts the next boundary from 1", async () => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, "{not json");
    const upload = vi.fn().mockResolvedValue(undefined);
    const publisher = publisherFor(db, { destinations: [makeDestination("s3", upload)] });

    await publisher.runCadence(BOUNDARY);
    const again = await publisher.runCadence(BOUNDARY);
    expect(again).toMatchObject({ kind: "upload_cap_reached", attempts: 5 });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_COUNT_UNREADABLE"]);
    expect(upload).not.toHaveBeenCalled();

    const next = new Date(BOUNDARY.getTime() + CADENCE_MS);
    const recovered = await publisher.runCadence(next);
    expect(recovered.kind).toBe("published");
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: next.toISOString(), count: 1 });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("past the cap uploads nothing, logs upload_cap_reached, and writes one failure row per boundary", async () => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: 3 }));
    const upload = vi.fn().mockResolvedValue(undefined);
    const publisher = publisherFor(db, { destinations: [makeDestination("s3", upload)] });

    const fourth = await publisher.runCadence(BOUNDARY);
    expect(fourth).toEqual({
      kind: "upload_cap_reached",
      reason: "UPLOAD_ATTEMPT_CAP_REACHED",
      attempts: 4,
      chainEnabledTenantCount: 2,
    });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_CAP_REACHED"]);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.upload_cap_reached");

    mockLoggerError.mockClear();
    const fifth = await publisher.runCadence(BOUNDARY);
    expect(fifth.kind).toBe("upload_cap_reached");
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_CAP_REACHED"]);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.upload_cap_reached");
    expect(upload).not.toHaveBeenCalled();
  });
});

// ─── runCadence: publish ────────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — publish", () => {
  it("publishes the given boundary: key, marker and anchoredAt from it, lastPublishedAt from the wall clock", async () => {
    const db = makeDb();
    const upload1 = vi.fn().mockResolvedValue(undefined);
    const upload2 = vi.fn().mockResolvedValue(undefined);
    const outcome = await publisherFor(db, {
      destinations: [makeDestination("filesystem", upload1), makeDestination("s3", upload2)],
    }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({
      kind: "published",
      destinations: ["filesystem", "s3"],
      tenantsCount: 2,
      chainEnabledTenantCount: 2,
    });
    const expectedKey = buildManifestArtifactKey(BOUNDARY, KID);
    expect(upload1.mock.calls[0]?.[0]).toMatchObject({ artifactKey: expectedKey, contentType: "application/jose" });
    expect(upload2).toHaveBeenCalledTimes(1);
    expect(db.settings.get(MARKER_KEY)).toBe(BOUNDARY.toISOString());
    expect(JSON.parse(db.settings.get(POINTER_KEY) ?? "null")).toEqual({
      uri: `filesystem://${expectedKey}`,
      sha256: outcome.kind === "published" ? outcome.manifestSha256 : "",
    });
    expect(db.updateManyCalls).toContainEqual({
      where: { tenantId: { in: [TENANT_ID_1, TENANT_ID_2] } },
      data: { lastPublishedAt: WALL_CLOCK, publishPausedUntil: null },
    });

    const published = db.outboxRows.find((r) => r.payload.action === "AUDIT_ANCHOR_PUBLISHED");
    expect(published?.payload.metadata).toMatchObject({ artifactKey: expectedKey, anchoredAt: BOUNDARY.toISOString() });
  });

  it("passes an abort signal to every destination", async () => {
    const db = makeDb();
    const upload = vi.fn().mockResolvedValue(undefined);
    await publisherFor(db, { destinations: [makeDestination("s3", upload)] }).runCadence(BOUNDARY);

    expect(upload.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("publishes every tenant when one is paused, with no AUDIT_ANCHOR_PUBLISH_PAUSED emit", async () => {
    const db = makeDb({
      anchors: [
        anchor(TENANT_ID_1, { publishPausedUntil: new Date("2026-12-31T00:00:00Z") }),
        anchor(TENANT_ID_2),
      ],
    });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2 });
    expect(outboxActions(db)).not.toContain("AUDIT_ANCHOR_PUBLISH_PAUSED");
  });

  it("publishes when every tenant is paused", async () => {
    const pausedUntil = new Date("2026-12-31T00:00:00Z");
    const db = makeDb({
      anchors: [anchor(TENANT_ID_1, { publishPausedUntil: pausedUntil }), anchor(TENANT_ID_2, { publishPausedUntil: pausedUntil })],
    });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2 });
  });

  it("writes the missing-prior row after the publish transaction, on its own transaction", async () => {
    const db = makeDb();
    await publisherFor(db).runCadence(BOUNDARY);

    const missing = db.outboxRows.find(
      (r) => (r.payload.metadata as Record<string, unknown>).failureReason === "MISSING_PRIOR_CADENCE_PUBLICATION",
    );
    expect(missing).toBeDefined();
    expect(db.publishTxIndex).not.toBeNull();
    expect(missing?.txIndex).toBeGreaterThan(db.publishTxIndex ?? Infinity);
  });
});

// ─── runCadence: failures ───────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — failures", () => {
  it("an upload failure fails at stage upload and pauses until the next boundary by the wall clock", async () => {
    const db = makeDb();
    const failing = makeDestination("s3", vi.fn().mockRejectedValue(new Error("S3 unavailable")));
    const outcome = await publisherFor(db, { destinations: [failing] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      // Token, not the message: it is persisted where the tenant reads it.
      reason: "s3_UPLOAD_FAILED:unknown",
      stage: "upload",
      chainEnabledTenantCount: 2,
    });
    const pauses = pauseWrites(db);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.data.publishPausedUntil).toEqual(new Date("2026-01-16T00:05:00.000Z"));
    expect(failureReasons(db)).toContain("s3_UPLOAD_FAILED:unknown");
    expect(db.settings.has(MARKER_KEY)).toBe(false);

    const uploadLog = mockLoggerError.mock.calls.find(
      ([, message]) => message === "audit-anchor-publisher.upload_failed",
    );
    expect(uploadLog?.[0]).toEqual({
      destination: "s3",
      error: { name: "Error", code: "unknown" },
      _logType: "audit-anchor-publisher.upload_failed",
    });
  });

  it("a commit lost after the upload fails at stage after_upload, writes no pause, and logs commit_failed_after_upload", async () => {
    const db = makeDb();
    const upload = vi.fn().mockResolvedValue(undefined);
    const outcome = await publisherFor(db, {
      destinations: [makeDestination("s3", upload)],
      hooks: { afterUpload: async () => { throw new Error("connection lost"); } },
    }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "after_upload", reason: "COMMIT_FAILED_AFTER_UPLOAD:unknown" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(pauseWrites(db)).toEqual([]);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.commit_failed_after_upload");
    expect(failureReasons(db)).toContain("COMMIT_FAILED_AFTER_UPLOAD:unknown");
  });

  it("the upload bound fails a destination that never settles", async () => {
    vi.useRealTimers();
    const db = makeDb();
    let signal: AbortSignal | undefined;
    const hanging = makeDestination("s3", vi.fn((args: { signal?: AbortSignal }) => {
      signal = args.signal;
      return new Promise<void>(() => {});
    }));
    const outcome = await publisherFor(db, { destinations: [hanging], uploadTimeoutMs: 20 }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "s3_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });

  it("a failure before the upload is stage before_upload with a token reason", async () => {
    const db = makeDb();
    db.settings.set(POINTER_KEY, "{not json");
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "before_upload" });
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/^CADENCE_FAILED:[A-Za-z0-9_.-]+$/);
    expect(pauseWrites(db)).toEqual([]);
  });
});

// ─── runCadence: log lines ──────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — cadence lines", () => {
  async function runWith(db: FakeDb, overrides: Partial<PublisherConfig> = {}): Promise<CadenceOutcome> {
    mockLoggerInfo.mockClear();
    return publisherFor(db, overrides).runCadence(BOUNDARY);
  }

  function cadenceLines(): Array<Record<string, unknown>> {
    return mockLoggerInfo.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((f) => f._logType === "audit-anchor-publisher.cadence");
  }

  function healthyLines(): Array<Record<string, unknown>> {
    return mockLoggerInfo.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((f) => f._logType === "audit-anchor-publisher.cadence_healthy");
  }

  it("every outcome logs one cadence line carrying the chain-enabled tenant count", async () => {
    await runWith(makeDb());
    expect(cadenceLines()).toEqual([
      expect.objectContaining({ kind: "published", chainEnabledTenantCount: 2, boundary: BOUNDARY.toISOString() }),
    ]);

    const db = makeDb();
    db.settings.set(MARKER_KEY, BOUNDARY.toISOString());
    await runWith(db);
    expect(cadenceLines()).toEqual([
      expect.objectContaining({ kind: "skipped_already_published", chainEnabledTenantCount: 2 }),
    ]);
  });

  it("emits the healthy line for published", async () => {
    await runWith(makeDb());
    expect(healthyLines()).toEqual([expect.objectContaining({ outcome: "published", chainEnabledTenantCount: 2 })]);
  });

  it("emits the healthy line for skipped_no_tenants only when no tenant was ever chain-enabled", async () => {
    await runWith(makeDb({ tenants: [], anchors: [] }));
    expect(healthyLines()).toEqual([expect.objectContaining({ outcome: "skipped_no_tenants" })]);

    await runWith(makeDb({ tenants: [] }));
    expect(healthyLines()).toEqual([]);
  });

  it("emits no healthy line for already-published, failed, cap-reached or lock_held runs", async () => {
    const already = makeDb();
    already.settings.set(MARKER_KEY, BOUNDARY.toISOString());
    await runWith(already);
    expect(healthyLines()).toEqual([]);

    await runWith(makeDb(), { destinations: [makeDestination("s3", vi.fn().mockRejectedValue(new Error("x")))] });
    expect(healthyLines()).toEqual([]);

    const capped = makeDb();
    capped.settings.set(ATTEMPTS_KEY, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: 3 }));
    await runWith(capped);
    expect(healthyLines()).toEqual([]);

    await runWith(makeDb({ lockTimeoutOnCall: new Set([1]) }));
    expect(healthyLines()).toEqual([]);
  });
});

// ─── the publisher's audit write ────────────────────────────────────────────

describe("AuditAnchorPublisher — audit write", () => {
  it("writes the row under SYSTEM_TENANT_ID as a SYSTEM actor and emits the structured line first", async () => {
    const db = makeDb();
    await publisherFor(db).runCadence(BOUNDARY);

    const published = db.outboxRows.find((r) => r.payload.action === "AUDIT_ANCHOR_PUBLISHED");
    expect(published).toMatchObject({
      tenantId: "00000000-0000-4000-8000-000000000002",
      payload: { scope: "TENANT", actorType: "SYSTEM", userId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(mockAuditInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.objectContaining({ action: "AUDIT_ANCHOR_PUBLISHED" }) }),
      "audit.AUDIT_ANCHOR_PUBLISHED",
    );
  });

  it("never throws: a failed outbox write goes to the dead-letter stream and the outcome stands", async () => {
    const db = makeDb({ outboxFailure: new Error("outbox down") });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("published");
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUDIT_ANCHOR_PUBLISHED",
        reason: PUBLISHER_AUDIT_DEAD_LETTER_REASON,
        error: { name: "Error", code: "unknown" },
      }),
      "audit.dead_letter",
    );
  });
});

// ─── ensureDeploymentIdMatch ────────────────────────────────────────────────

describe("AuditAnchorPublisher.ensureDeploymentIdMatch", () => {
  it("throws DeploymentIdMismatchError and writes the mismatch row after its transaction", async () => {
    const db = makeDb({ storedDeploymentId: "other-deploy" });
    const publisher = publisherFor(db, { deploymentId: "deploy-x" });

    await expect(publisher.ensureDeploymentIdMatch()).rejects.toBeInstanceOf(DeploymentIdMismatchError);
    expect(failureReasons(db)).toEqual(["DEPLOYMENT_ID_MISMATCH"]);
    // tx 1 reads the stored id; the row is written by tx 2.
    expect(db.outboxRows[0]?.txIndex).toBe(2);
  });

  it("succeeds when the stored deploymentId matches", async () => {
    const db = makeDb({ storedDeploymentId: "deploy-x" });
    await expect(publisherFor(db, { deploymentId: "deploy-x" }).ensureDeploymentIdMatch()).resolves.toBeUndefined();
    expect(db.outboxRows).toEqual([]);
  });
});

// ─── DeploymentIdMismatchError ──────────────────────────────────────────────

describe("DeploymentIdMismatchError", () => {
  it("carries expected/found in the message and identifies its name", () => {
    const err = new DeploymentIdMismatchError("expected-id", "found-id");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DeploymentIdMismatchError");
    expect(err.message).toContain("expected-id");
    expect(err.message).toContain("found-id");
  });
});

// ─── createPublisher factory ────────────────────────────────────────────────

describe("createPublisher", () => {
  it("returns the publisher / prisma / shutdown triple wired against the supplied config", async () => {
    const factory = createPublisher(makeConfig());

    expect(factory.publisher).toBeInstanceOf(AuditAnchorPublisher);
    expect(factory.prisma).toBeDefined();
    expect(typeof factory.shutdown).toBe("function");

    // Replace shutdown internals so the test does not block on real pool/DB
    // teardown — but verify the returned function is invocable.
    const fakePrismaDisconnect = vi.fn().mockResolvedValue(undefined);
    (factory.prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect = fakePrismaDisconnect;

    await expect(factory.shutdown()).resolves.toBeUndefined();
    expect(fakePrismaDisconnect).toHaveBeenCalledTimes(1);
  });
});
