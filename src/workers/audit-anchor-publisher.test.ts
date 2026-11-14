/**
 * Unit tests for AuditAnchorPublisher.
 *
 * Covers:
 *   - cadence math
 *   - runCadence(boundary): the decision table (rows a–j) read from what the
 *     primary destination holds, the zero-tenant path, the persisted attempt
 *     cap, publish / adopt / mirrors / mirror backfill, the clamp on
 *     `last_published_at`, the run's one bound on destination I/O, and the
 *     cadence / healthy log lines
 *   - the rows a published outcome emits, each with the case that does not
 *   - the publisher's own audit write: written after the publish transaction,
 *     never throwing
 *   - DeploymentIdMismatchError and createPublisher
 *
 * The destinations are the stateful in-memory one (it passes the destination
 * contract suite), so an object one run stores is what the next run reads.
 * The database is a fake transaction client holding `system_settings` and the
 * anchors in memory; audit rows are asserted at its `auditOutbox.createMany`
 * boundary. anchor-manifest functions run for real (they use `node:crypto`;
 * mocking would silently disable signing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3ServiceException } from "@aws-sdk/client-s3";
import {
  ADVISORY_LOCK_KEY,
  AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP,
  AuditAnchorPublisher,
  DeploymentIdMismatchError,
  PUBLISHER_AUDIT_DEAD_LETTER_REASON,
  SETTING_DEPLOYMENT_ID,
  SETTING_UPLOAD_ATTEMPTS,
  createPublisher,
  currentCadenceBoundary,
  previousCadenceBoundary,
  type CadenceOutcome,
  type PublisherConfig,
} from "./audit-anchor-publisher";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { InMemoryDestination } from "@/lib/audit/anchor-destinations/in-memory-destination";
import { buildManifestArtifactKey, publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import {
  computeTenantTag,
  publicKeyForSigningKey,
  verify,
  type AnchorRow,
} from "@/lib/audit/anchor-manifest";
import {
  AUDIT_ANCHOR_CADENCE_MS,
  AUDIT_ANCHOR_MIRROR_BACKFILL_MAX,
  AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
  AUDIT_ANCHOR_UNSETTLED_WALK_MAX,
} from "@/lib/constants/audit/audit";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";
import {
  archivePublicKey,
  createCalls,
  kidOf,
  signedManifest,
  storeArtifact,
  storeManifest,
  trackDestination,
  type SignedManifest,
} from "@/__tests__/helpers/anchor-manifest-fixtures";

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
const TENANT_ID_3 = "33333333-3333-4333-8333-333333333333";

const SIGNING_KEY = randomBytes(32);
const PUBLIC_KEY = publicKeyForSigningKey(SIGNING_KEY);
const TAG_SECRET = randomBytes(32);
const KID = kidOf(SIGNING_KEY);
const DEPLOYMENT_ID = "deploy-x";

const OTHER_KEY = randomBytes(32);
const OTHER_PUBLIC_KEY = publicKeyForSigningKey(OTHER_KEY);
const OTHER_KID = kidOf(OTHER_KEY);


const BOUNDARY = new Date("2026-01-15T00:05:00.000Z");
const PREV_BOUNDARY = new Date(BOUNDARY.getTime() - AUDIT_ANCHOR_CADENCE_MS);
const NEXT_BOUNDARY = new Date(BOUNDARY.getTime() + AUDIT_ANCHOR_CADENCE_MS);
const WALL_CLOCK = new Date("2026-01-15T01:00:00.000Z");
const OWN_KEY_AT_BOUNDARY = buildManifestArtifactKey(BOUNDARY, KID);

const ATTEMPTS_KEY = SETTING_UPLOAD_ATTEMPTS;
const CAP = AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP;

/** The shape the Prisma pg adapter gives a raw-query 55P03: nested under P2010. */
function lockTimeoutError(): Error {
  return Object.assign(new Error("Raw query failed."), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: "55P03", kind: "postgres" } } },
  });
}

function denied(): Error {
  return Object.assign(new Error("denied"), { code: "AccessDenied" });
}

const tracked = trackDestination;
const creates = createCalls;

function makeConfig(overrides: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    deploymentId: DEPLOYMENT_ID,
    signingKey: SIGNING_KEY,
    tagSecret: TAG_SECRET,
    destinations: [new InMemoryDestination("filesystem")],
    cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
    publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
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
  /** Runs before the chain-enabled tenants are read; `call` is 1-based within the fake's life. */
  beforeTenantRead: (call: number) => void | Promise<void>;
  tenantReads: number;
  /** Runs before an anchor-row read; `where` is undefined for the read of every row. */
  beforeAnchorRead: (where: unknown) => void;
  /** Thrown by the publish transaction's anchor-row write. */
  publishWriteFailure: Error | null;
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
    beforeTenantRead: () => undefined,
    tenantReads: 0,
    beforeAnchorRead: () => undefined,
    publishWriteFailure: null,
    ...overrides,
  };
}

type UpdateManyArgs = {
  where: { tenantId: { in: string[] }; OR?: Array<{ lastPublishedAt: null | { lt: Date } }> };
  data: Partial<FakeAnchor>;
};

function makeFakeTx(db: FakeDb, txIndex: number) {
  return {
    $executeRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
      const sql = template.raw.join("$");
      if (sql.includes("pg_advisory_xact_lock")) {
        if (values[0] !== ADVISORY_LOCK_KEY) throw new Error(`fake: lock taken on ${String(values[0])}`);
        db.lockCalls++;
        if (db.lockTimeoutOnCall.has(db.lockCalls)) throw lockTimeoutError();
        // The second lock of a run is the publish transaction's.
        if (db.lockCalls % 2 === 0) db.publishTxIndex = txIndex;
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
      const sql = template.raw.join("$");
      if (sql.includes("SELECT value FROM system_settings WHERE key =") && values[0] === SETTING_DEPLOYMENT_ID) {
        return db.storedDeploymentId !== null ? [{ value: db.storedDeploymentId }] : [];
      }
      if (sql.includes("MAX(last_published_at)")) {
        // The high-water query takes every row; the missing-prior one, the given tenants'.
        const ids = Array.isArray(values[0]) ? (values[0] as string[]) : null;
        const times = db.anchors
          .filter((a) => (ids === null || ids.includes(a.tenantId)) && a.lastPublishedAt)
          .map((a) => (a.lastPublishedAt as Date).getTime());
        return [{ max_published: times.length > 0 ? new Date(Math.max(...times)) : null }];
      }
      return [];
    }),
    tenant: {
      findMany: vi.fn(async () => {
        await db.beforeTenantRead(++db.tenantReads);
        return db.tenants.filter((t) => t.auditChainEnabled).map((t) => ({ id: t.id }));
      }),
    },
    auditChainAnchor: {
      findMany: vi.fn(async (args: { where?: { tenantId: { in: string[] } }; orderBy?: unknown }) => {
        // The run's tenant-set read selects ids only; the hook is for the two reads after it.
        if (args.where === undefined || args.orderBy !== undefined) db.beforeAnchorRead(args.where);
        const ids = args.where?.tenantId.in;
        return db.anchors
          .filter((a) => ids === undefined || ids.includes(a.tenantId))
          .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      }),
      findFirst: vi.fn(async () => (db.anchors[0] ? { tenantId: db.anchors[0].tenantId } : null)),
      updateMany: vi.fn(async (args: UpdateManyArgs) => {
        db.updateManyCalls.push(args);
        if (db.publishWriteFailure && args.data.lastPublishedAt instanceof Date) throw db.publishWriteFailure;
        const before = args.where.OR?.find((c) => c.lastPublishedAt !== null)?.lastPublishedAt as
          | { lt: Date }
          | undefined;
        let count = 0;
        for (const row of db.anchors) {
          if (!args.where.tenantId.in.includes(row.tenantId)) continue;
          if (before && row.lastPublishedAt !== null && row.lastPublishedAt >= before.lt) continue;
          Object.assign(row, args.data);
          count++;
        }
        return { count };
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

function metadataOf(db: FakeDb, action: string): Array<Record<string, unknown>> {
  return db.outboxRows
    .filter((r) => r.payload.action === action)
    .map((r) => r.payload.metadata as Record<string, unknown>);
}

function failureReasons(db: FakeDb): unknown[] {
  return metadataOf(db, "AUDIT_ANCHOR_PUBLISH_FAILED").map((m) => m.failureReason);
}

function failureRows(db: FakeDb, reason: string): Array<Record<string, unknown>> {
  return metadataOf(db, "AUDIT_ANCHOR_PUBLISH_FAILED").filter((m) => m.failureReason === reason);
}

function logTypes(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(([fields]) => (fields as { _logType?: unknown })._logType);
}

function logLines(mock: ReturnType<typeof vi.fn>, logType: string): Array<Record<string, unknown>> {
  return mock.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((f) => f._logType === `audit-anchor-publisher.${logType}`);
}

function pauseWrites(db: FakeDb) {
  return db.updateManyCalls.filter((c) => c.data.publishPausedUntil instanceof Date);
}

function publishWrites(db: FakeDb) {
  return db.updateManyCalls.filter((c) => c.data.lastPublishedAt instanceof Date);
}

function rowOf(tenantId: string, overrides: Partial<AnchorRow> = {}): AnchorRow {
  return { tenantId, chainSeq: 1n, prevHash: Buffer.alloc(32, 0xa1), epoch: 1, ...overrides };
}

/** A manifest this publisher's identity would have published for `boundary`. */
function ours(boundary: Date, overrides: Partial<Parameters<typeof signedManifest>[0]> = {}): SignedManifest {
  return signedManifest({
    signingKey: SIGNING_KEY,
    boundary,
    deploymentId: DEPLOYMENT_ID,
    tagSecret: TAG_SECRET,
    tenants: [rowOf(TENANT_ID_1), rowOf(TENANT_ID_2)],
    ...overrides,
  });
}

/** A primary with the own public key archived, so only a case that asks sees OWN_PUBLIC_KEY_NOT_ARCHIVED. */
async function archivedPrimary(name = "filesystem"): Promise<InMemoryDestination> {
  const dest = new InMemoryDestination(name);
  await archivePublicKey(dest, PUBLIC_KEY);
  return dest;
}

/** What a denied run must leave: nothing stored beyond `before`, no anchor write, no mirror create. */
async function expectNothingWritten(
  db: FakeDb,
  primary: InMemoryDestination,
  before: string[],
  mirrorCalls: string[] = [],
): Promise<void> {
  expect([...(await primary.list())].sort()).toEqual([...before].sort());
  expect(publishWrites(db)).toEqual([]);
  expect(creates(mirrorCalls)).toEqual([]);
}

function setClock(instant: Date): void {
  vi.setSystemTime(instant);
}

/** The wall clock 55 minutes into `boundary`, as on a scheduled run. */
function clockInto(boundary: Date): void {
  setClock(new Date(boundary.getTime() + 55 * MS_PER_MINUTE));
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
    const boundary = currentCadenceBoundary(now, AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS);
    expect(boundary.toISOString()).toBe("2026-01-15T00:05:00.000Z");
  });

  it("previousCadenceBoundary returns one cadence prior to current", () => {
    const now = new Date("2026-01-15T12:34:56Z");
    const prev = previousCadenceBoundary(now, AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS);
    expect(prev.toISOString()).toBe("2026-01-14T00:05:00.000Z");
  });

  it("currentCadenceBoundary is idempotent on a boundary moment", () => {
    const onBoundary = new Date("2026-01-15T00:05:00Z");
    const result = currentCadenceBoundary(onBoundary, AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS);
    expect(result.getTime()).toBe(onBoundary.getTime());
  });

  it("currentCadenceBoundary handles zero offset", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const boundary = currentCadenceBoundary(now, AUDIT_ANCHOR_CADENCE_MS, 0);
    expect(boundary.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

// ─── runCadence: lock and zero-tenant path ──────────────────────────────────

describe("AuditAnchorPublisher.runCadence — lock and no tenants", () => {
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

  it("with no tenant, an empty primary and no anchor row: the healthy skip, uncounted, nothing read", async () => {
    const db = makeDb({ tenants: [], anchors: [] });
    const { dest, calls } = tracked(new InMemoryDestination("filesystem"));
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: false,
      chainEnabledTenantCount: 0,
    });
    expect(calls).toEqual(["list"]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toHaveLength(1);
  });

  it("reports everChainEnabled true when an anchor row exists but no tenant is chain-enabled", async () => {
    const db = makeDb({ tenants: [{ id: TENANT_ID_1, auditChainEnabled: false }] });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "skipped_no_tenants", everChainEnabled: true });
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);
  });

  it("reports everChainEnabled true when the anchor rows are gone but the primary holds a manifest key, without reading it", async () => {
    const db = makeDb({ tenants: [], anchors: [] });
    const primary = new InMemoryDestination("filesystem");
    // Not a manifest at all: the listing decides, the object is not read.
    await storeArtifact(primary, OWN_KEY_AT_BOUNDARY, Buffer.from("garbage"));
    const { dest, calls } = tracked(primary);
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "skipped_no_tenants", everChainEnabled: true });
    expect(calls).toEqual(["list"]);
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);
  });

  it("does not count a non-manifest key at the primary as ever chain-enabled", async () => {
    const db = makeDb({ tenants: [], anchors: [] });
    const primary = await archivedPrimary();
    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "skipped_no_tenants", everChainEnabled: false });
  });

  it("with a chain-enabled tenant that has no anchor row yet and no other: the no-tenant skip, nothing stored, nothing counted", async () => {
    const db = makeDb({ tenants: [{ id: TENANT_ID_1, auditChainEnabled: true }], anchors: [] });
    const { dest, calls } = tracked(new InMemoryDestination("filesystem"));
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    // The count stays the chain-enabled tenants, not the tenants published.
    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: false,
      chainEnabledTenantCount: 1,
    });
    expect(calls).toEqual(["list"]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
  });

  it("with an enabled tenant, no anchor row and a manifest key at the primary: the no-tenant skip at the listing, the key not read", async () => {
    const db = makeDb({ tenants: [{ id: TENANT_ID_1, auditChainEnabled: true }], anchors: [] });
    const primary = new InMemoryDestination("filesystem");
    // Not a manifest at all: a run that went on to decide would read it and fail.
    await storeArtifact(primary, OWN_KEY_AT_BOUNDARY, Buffer.from("garbage"));
    const { dest, calls } = tracked(primary);
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: true,
      chainEnabledTenantCount: 1,
    });
    expect(calls).toEqual(["list"]);
  });

  it("a chain-enabled tenant without an anchor row beside one that has a row: published, covering the one with a row", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1)] });
    const primary = await archivedPrimary();
    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 1, chainEnabledTenantCount: 2 });
    const manifest = verify((await primary.read(OWN_KEY_AT_BOUNDARY))!.toString("utf-8"), PUBLIC_KEY);
    expect(manifest.tenants.map((t) => t.tenantTag)).toEqual([computeTenantTag(TENANT_ID_1, TAG_SECRET)]);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
  });

  it.each([
    ["before the attempt is counted", 2, false],
    ["inside the publish transaction", 3, true],
  ])("anchor rows that vanish %s end as the no-tenant skip with the enabled count", async (_label, emptiesOnRead, counted) => {
    const db = makeDb();
    db.beforeTenantRead = (call) => {
      if (call === emptiesOnRead) db.anchors = [];
    };
    const { dest, calls } = tracked(new InMemoryDestination("filesystem"));
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: true,
      chainEnabledTenantCount: 2,
    });
    expect(creates(calls)).toEqual([]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(counted);
  });

  it("names an S3 service refusal by the SDK exception's name, which carries no code", async () => {
    const db = makeDb();
    const refusal = new S3ServiceException({
      name: "AccessDenied",
      $fault: "client",
      $metadata: { httpStatusCode: 403 },
    });
    const { dest } = tracked(new InMemoryDestination("s3-object-lock"), {
      list: async () => {
        throw refusal;
      },
    });
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "s3-object-lock_READ_FAILED:AccessDenied" });
  });

  it("keeps unknown for a destination error that names no fault", async () => {
    const db = makeDb();
    const { dest } = tracked(new InMemoryDestination("filesystem"), {
      list: async () => {
        throw new Error("no code, no metadata");
      },
    });
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "filesystem_READ_FAILED:unknown" });
  });

  it("with no tenant, a listing that fails is a read failure (row a), not a skip", async () => {
    const db = makeDb({ tenants: [], anchors: [] });
    const { dest } = tracked(new InMemoryDestination("filesystem"), {
      list: async () => {
        throw denied();
      },
    });
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "filesystem_READ_FAILED:AccessDenied",
      stage: "before_upload",
      chainEnabledTenantCount: 0,
    });
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);
  });

  it.each([
    ["before the attempt is counted", 2],
    ["inside the publish transaction", 3],
  ])("a tenant set that empties %s still reports the step-2 everChainEnabled", async (_label, emptiesOnRead) => {
    // Step 2 saw an anchor row; by the later read the tenants AND the rows are
    // gone and the primary holds nothing, so a value recomputed there is false.
    const db = makeDb();
    db.beforeTenantRead = (call) => {
      if (call === emptiesOnRead) {
        db.tenants = [];
        db.anchors = [];
      }
    };
    const { dest, calls } = tracked(new InMemoryDestination("filesystem"));
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: true,
      chainEnabledTenantCount: 0,
    });
    expect(creates(calls)).toEqual([]);
  });

  it("fails with a token when no destination is configured", async () => {
    const db = makeDb();
    const outcome = await publisherFor(db, { destinations: [] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:NO_DESTINATION", stage: "before_upload" });
  });
});

// ─── runCadence: the decision table ─────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — decision table", () => {
  it("row a: a listing error fails before the upload, uncounted, with the destination's read token", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    const mirror = tracked(new InMemoryDestination("s3"));
    let failing = true;
    const { dest } = tracked(primary, {
      list: async (signal) => {
        if (failing) throw denied();
        return primary.list(signal);
      },
    });
    const publisher = publisherFor(db, { destinations: [dest, mirror.dest] });

    const outcome = await publisher.runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "filesystem_READ_FAILED:AccessDenied",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    expect(failureReasons(db)).toEqual(["filesystem_READ_FAILED:AccessDenied"]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    expect(pauseWrites(db)).toEqual([]);
    await expectNothingWritten(db, primary, [], mirror.calls);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.cadence_failed");

    // Allow: the same publisher, once the listing answers.
    failing = false;
    expect(await publisher.runCadence(BOUNDARY)).toMatchObject({ kind: "published" });
  });

  it("row a: a read error on the latest manifest is the same failure", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    await storeManifest(primary, ours(PREV_BOUNDARY));
    const { dest } = tracked(primary, {
      read: async () => {
        throw denied();
      },
    });

    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "filesystem_READ_FAILED:AccessDenied", stage: "before_upload" });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, await primary.list());
  });

  it("row a inside the publish transaction is counted", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    let lists = 0;
    const { dest } = tracked(primary, {
      list: async (signal) => {
        if (++lists === 2) throw denied();
        return primary.list(signal);
      },
    });

    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "filesystem_READ_FAILED:AccessDenied", stage: "before_upload" });
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
    expect(pauseWrites(db)).toEqual([]);
    await expectNothingWritten(db, primary, []);
  });

  it("row b: a latest object that is not a manifest fails closed, uncounted", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    const garbageKey = buildManifestArtifactKey(PREV_BOUNDARY, KID);
    await storeArtifact(primary, garbageKey, Buffer.from("garbage"));
    const mirror = tracked(new InMemoryDestination("s3"));

    const outcome = await publisherFor(db, { destinations: [primary, mirror.dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    expect(failureReasons(db)).toEqual(["CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE"]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, [garbageKey], mirror.calls);
    expect(logLines(mockLoggerError, "published_object_unverifiable")).toEqual([
      expect.objectContaining({ artifactKey: garbageKey, detail: "SIGNATURE_INVALID" }),
    ]);
  });

  it("row b: a latest manifest under a kid whose public key is not archived fails; archived, the same publisher chains to it", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const previous = signedManifest({ signingKey: OTHER_KEY, boundary: PREV_BOUNDARY, deploymentId: DEPLOYMENT_ID });
    await storeManifest(primary, previous);
    const before = await primary.list();
    const publisher = publisherFor(db, { destinations: [primary] });

    const refused = await publisher.runCadence(BOUNDARY);
    expect(refused).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE" });
    await expectNothingWritten(db, primary, before);

    // The miss is not cached: archiving the key is seen without a new instance.
    await archivePublicKey(primary, OTHER_PUBLIC_KEY);
    const published = await publisher.runCadence(BOUNDARY);
    expect(published).toMatchObject({ kind: "published", adopted: false });
    const stored = verify((await primary.read(OWN_KEY_AT_BOUNDARY))!.toString("utf-8"), PUBLIC_KEY);
    expect(stored.previousManifest).toEqual({ uri: `filesystem://${previous.artifactKey}`, sha256: previous.sha256 });
    expect(metadataOf(db, "AUDIT_ANCHOR_KEY_ROTATED")).toEqual([
      { oldKid: OTHER_KID, newKid: KID, anchoredAt: BOUNDARY.toISOString(), artifactKey: OWN_KEY_AT_BOUNDARY },
    ]);
  });

  it("row c: a latest manifest dated past the wall clock's boundary fails; once the clock reaches its date the run for an earlier boundary skips as stale", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const ahead = ours(NEXT_BOUNDARY);
    await storeManifest(primary, ahead);
    const before = await primary.list();

    const refused = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);
    expect(refused).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD",
      stage: "before_upload",
    });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, before);

    clockInto(NEXT_BOUNDARY);
    const stale = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);
    expect(stale.kind).toBe("skipped_already_published");
  });

  it("row d1: a last_published_at past the wall clock's boundary fails, whatever the primary holds", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: NEXT_BOUNDARY }), anchor(TENANT_ID_2)] });
    const primary = new InMemoryDestination("filesystem");

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    // The primary is empty, so d2 would match too: d1 is first.
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK",
      stage: "before_upload",
    });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, []);
  });

  it("row d1 reads the high-water from every anchor row, a disabled tenant's included", async () => {
    const db = makeDb({
      tenants: [
        { id: TENANT_ID_1, auditChainEnabled: true },
        { id: TENANT_ID_3, auditChainEnabled: false },
      ],
      anchors: [anchor(TENANT_ID_1), anchor(TENANT_ID_3, { lastPublishedAt: NEXT_BOUNDARY })],
    });

    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK" });
  });

  it("a last_published_at that maps to the wall clock's own boundary is not d1", async () => {
    // The last instant of the boundary still maps to it.
    const lastInstant = new Date(NEXT_BOUNDARY.getTime() - 1);
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: lastInstant }), anchor(TENANT_ID_2)] });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY));

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("skipped_already_published");
    expect(failureReasons(db)).toEqual([]);
  });

  it.each([
    ["nothing", null],
    ["only an earlier date", PREV_BOUNDARY],
  ])("row d2: last_published_at at the boundary while the primary holds %s fails, and is not a skip", async (_label, held) => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: BOUNDARY }), anchor(TENANT_ID_2)] });
    const primary = await archivedPrimary();
    if (held) await storeManifest(primary, ours(held));
    const before = await primary.list();
    const mirror = tracked(new InMemoryDestination("s3"));

    const outcome = await publisherFor(db, { destinations: [primary, mirror.dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:DESTINATION_BEHIND_DATABASE",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, before, mirror.calls);
  });

  it("row d2: an empty new primary fails though a secondary holds the manifests", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: PREV_BOUNDARY }), anchor(TENANT_ID_2)] });
    const primary = new InMemoryDestination("s3");
    const populated = new InMemoryDestination("filesystem");
    await storeManifest(populated, ours(PREV_BOUNDARY));

    const outcome = await publisherFor(db, { destinations: [primary, populated] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:DESTINATION_BEHIND_DATABASE" });
    expect(await primary.list()).toEqual([]);
  });

  it("a last_published_at on the latest manifest's date is neither d1 nor d2: the boundary publishes", async () => {
    const db = makeDb({
      anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
    });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(PREV_BOUNDARY));

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
  });

  it("no last_published_at and an empty primary is genesis: published with previousManifest null", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
    expect(verify((await primary.read(OWN_KEY_AT_BOUNDARY))!.toString("utf-8"), PUBLIC_KEY).previousManifest).toBeNull();
    expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([expect.objectContaining({ genesis: true, adopted: false })]);
  });

  it("row e: a latest manifest under another kid while the own kid has published before fails; without that earlier key the publisher chains to it", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    await archivePublicKey(primary, OTHER_PUBLIC_KEY);
    await storeManifest(
      primary,
      signedManifest({ signingKey: OTHER_KEY, boundary: PREV_BOUNDARY, deploymentId: DEPLOYMENT_ID }),
    );

    // Allow: the own kid has never published — a rotation onto this key.
    const rotatedOnto = new InMemoryDestination("filesystem");
    for (const key of await primary.list()) await storeArtifact(rotatedOnto, key, (await primary.read(key))!);
    expect(await publisherFor(makeDb(), { destinations: [rotatedOnto] }).runCadence(BOUNDARY)).toMatchObject({
      kind: "published",
    });

    // Deny: an older key NAME carries the own kid — this key was rotated away from.
    await storeArtifact(primary, buildManifestArtifactKey(new Date(PREV_BOUNDARY.getTime() - AUDIT_ANCHOR_CADENCE_MS), KID), Buffer.from("x"));
    const before = await primary.list();
    const mirror = tracked(new InMemoryDestination("s3"));
    const outcome = await publisherFor(db, { destinations: [primary, mirror.dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, before, mirror.calls);
  });

  it("row f: a latest manifest past the boundary skips, uncounted, logging stale_boundary", async () => {
    // The wall clock is at D+1, the run for D (a late retry).
    clockInto(NEXT_BOUNDARY);
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: NEXT_BOUNDARY }), anchor(TENANT_ID_2)] });
    const primary = await archivedPrimary();
    const later = ours(NEXT_BOUNDARY);
    await storeManifest(primary, later);
    const { dest, calls } = tracked(primary);

    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_already_published",
      reason: "BOUNDARY_ALREADY_PUBLISHED",
      chainEnabledTenantCount: 2,
    });
    expect(creates(calls)).toEqual([]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    expect(logLines(mockLoggerWarn, "stale_boundary")).toEqual([
      {
        boundary: BOUNDARY.toISOString(),
        latestArtifactKey: later.artifactKey,
        _logType: "audit-anchor-publisher.stale_boundary",
      },
    ]);
  });

  it.each([
    ["the own kid but another deployment id", SIGNING_KEY, "another-deployment", { kidMatches: true, deploymentMatches: false }],
    ["another kid and the own deployment id", OTHER_KEY, DEPLOYMENT_ID, { kidMatches: false, deploymentMatches: true }],
  ])("row g: the boundary's manifest under %s skips, with one audit row for the boundary", async (_label, signingKey, deploymentId, matches) => {
    const db = makeDb();
    const primary = await archivedPrimary();
    await archivePublicKey(primary, OTHER_PUBLIC_KEY);
    const theirs = signedManifest({ signingKey, boundary: BOUNDARY, deploymentId });
    await storeManifest(primary, theirs);
    const before = await primary.list();
    const mirror = tracked(new InMemoryDestination("s3"));
    const publisher = publisherFor(db, { destinations: [primary, mirror.dest] });

    const first = await publisher.runCadence(BOUNDARY);
    const second = await publisher.runCadence(BOUNDARY);

    expect([first, second]).toEqual([
      { kind: "skipped_already_published", reason: "BOUNDARY_ALREADY_PUBLISHED", chainEnabledTenantCount: 2 },
      { kind: "skipped_already_published", reason: "BOUNDARY_ALREADY_PUBLISHED", chainEnabledTenantCount: 2 },
    ]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    await expectNothingWritten(db, primary, before, mirror.calls);
    expect(logLines(mockLoggerWarn, "published_by_other_identity")).toEqual([
      expect.objectContaining({ boundary: BOUNDARY.toISOString(), artifactKey: theirs.artifactKey, ...matches }),
      expect.objectContaining(matches),
    ]);
    // Once per boundary per instance, however often the run repeats.
    expect(failureRows(db, "PUBLISHED_BY_OTHER_IDENTITY")).toEqual([
      { failureReason: "PUBLISHED_BY_OTHER_IDENTITY", artifactKey: theirs.artifactKey, anchoredAt: BOUNDARY.toISOString() },
    ]);
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);
  });

  it("row g's row is deduplicated per publisher instance and per boundary, not per process", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY, { deploymentId: "another-deployment" }));
    const config = { destinations: [primary] };

    // A second instance reports for itself; the first is not silenced by it.
    const one = publisherFor(db, config);
    const two = publisherFor(db, config);
    await one.runCadence(BOUNDARY);
    await two.runCadence(BOUNDARY);
    await one.runCadence(BOUNDARY);
    expect(failureRows(db, "PUBLISHED_BY_OTHER_IDENTITY")).toHaveLength(2);

    // The next boundary is reported again by the instance that reported this one.
    clockInto(NEXT_BOUNDARY);
    await storeManifest(primary, ours(NEXT_BOUNDARY, { deploymentId: "another-deployment" }));
    await one.runCadence(NEXT_BOUNDARY);
    expect(failureRows(db, "PUBLISHED_BY_OTHER_IDENTITY").map((m) => m.anchoredAt)).toEqual([
      BOUNDARY.toISOString(),
      BOUNDARY.toISOString(),
      NEXT_BOUNDARY.toISOString(),
    ]);
  });

  it("row h: the boundary's own manifest, settled, skips with no row and nothing counted", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: WALL_CLOCK }), anchor(TENANT_ID_2)] });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY));
    const { dest, calls } = tracked(primary);

    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "skipped_already_published",
      reason: "BOUNDARY_ALREADY_PUBLISHED",
      chainEnabledTenantCount: 2,
    });
    expect(creates(calls)).toEqual([]);
    expect(db.outboxRows).toEqual([]);
    expect(db.settings.has(ATTEMPTS_KEY)).toBe(false);
    expect(publishWrites(db)).toEqual([]);
  });

  it.each([
    ["no last_published_at", null],
    ["a last_published_at before the boundary", new Date(BOUNDARY.getTime() - 1)],
  ])("row i: the boundary's own manifest with %s is adopted — no create, the database settled, adopted: true", async (_label, lastPublishedAt) => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt }), anchor(TENANT_ID_2)] });
    const primary = await archivedPrimary();
    // The previous date's manifest is there whenever the database says it was published.
    if (lastPublishedAt) await storeManifest(primary, ours(PREV_BOUNDARY));
    const planted = ours(BOUNDARY);
    await storeManifest(primary, planted);
    const { dest, calls } = tracked(primary);

    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "published",
      manifestSha256: planted.sha256,
      destinations: ["filesystem"],
      tenantsCount: 2,
      adopted: true,
      chainEnabledTenantCount: 2,
    });
    expect(creates(calls)).toEqual([]);
    expect(await primary.read(planted.artifactKey)).toEqual(planted.bytes);
    expect(db.anchors.map((a) => a.lastPublishedAt)).toEqual([WALL_CLOCK, WALL_CLOCK]);
    expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([
      expect.objectContaining({ adopted: true, manifestSha256: planted.sha256, artifactKey: planted.artifactKey }),
    ]);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
  });

  it("row j: a latest manifest before the boundary is chained to by uri and payload digest", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const previous = ours(PREV_BOUNDARY);
    await storeManifest(primary, previous);

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
    const stored = verify((await primary.read(OWN_KEY_AT_BOUNDARY))!.toString("utf-8"), PUBLIC_KEY);
    expect(stored.previousManifest).toEqual({ uri: `filesystem://${previous.artifactKey}`, sha256: previous.sha256 });
    expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([expect.objectContaining({ genesis: false })]);
    expect(metadataOf(db, "AUDIT_ANCHOR_KEY_ROTATED")).toEqual([]);
  });

  it("chains to a previous manifest from another deployment id, and says so", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const previous = ours(PREV_BOUNDARY, { deploymentId: "another-deployment" });
    await storeManifest(primary, previous);

    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("published");
    const stored = verify((await primary.read(OWN_KEY_AT_BOUNDARY))!.toString("utf-8"), PUBLIC_KEY);
    expect(stored.previousManifest?.sha256).toBe(previous.sha256);
    expect(logLines(mockLoggerWarn, "previous_manifest_deployment_changed")).toEqual([
      expect.objectContaining({ previousArtifactKey: previous.artifactKey }),
    ]);

    mockLoggerWarn.mockClear();
    clockInto(NEXT_BOUNDARY);
    await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);
    expect(logLines(mockLoggerWarn, "previous_manifest_deployment_changed")).toEqual([]);
  });

  it("decides again under the lock: an instance that waited behind a publish skips and creates nothing", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const { dest, calls } = tracked(primary);
    const outcome = await publisherFor(db, {
      destinations: [dest],
      hooks: {
        // What the other instance committed while this one waited for the lock.
        inTx: async () => {
          await storeManifest(primary, ours(BOUNDARY));
          for (const row of db.anchors) row.lastPublishedAt = WALL_CLOCK;
        },
      },
    }).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("skipped_already_published");
    expect(creates(calls)).toEqual([]);
    expect(db.outboxRows).toEqual([]);
  });

  it("decides again under the lock: a high-water planted ahead between the transactions fails, counted", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const before = await primary.list();
    const outcome = await publisherFor(db, {
      destinations: [primary],
      hooks: {
        inTx: async () => {
          db.anchors[0]!.lastPublishedAt = NEXT_BOUNDARY;
        },
      },
    }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK",
      stage: "before_upload",
    });
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
    expect(pauseWrites(db)).toEqual([]);
    await expectNothingWritten(db, primary, before);
  });

  it("reads the wall clock from config.now when one is given", async () => {
    // The default clock (faked to WALL_CLOCK) calls this object ahead; the
    // injected one is at D+1, where the run for D is a stale skip.
    const db = makeDb();
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(NEXT_BOUNDARY));

    expect(await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY)).toMatchObject({
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD",
    });
    const outcome = await publisherFor(db, {
      destinations: [primary],
      now: () => NEXT_BOUNDARY.getTime() + MS_PER_HOUR,
    }).runCadence(BOUNDARY);
    expect(outcome.kind).toBe("skipped_already_published");
  });
});

// ─── runCadence: attempt cap ────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — persisted attempt cap", () => {
  function failingPrimary(): { dest: AnchorDestination; calls: string[] } {
    return tracked(new InMemoryDestination("s3"), {
      create: async () => {
        throw new Error("down");
      },
    });
  }

  it("counts each run against the boundary, resetting to 1 for a new boundary", async () => {
    const db = makeDb();
    const publisher = publisherFor(db, { destinations: [failingPrimary().dest] });

    await publisher.runCadence(BOUNDARY);
    await publisher.runCadence(BOUNDARY);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 2 });

    clockInto(NEXT_BOUNDARY);
    await publisher.runCadence(NEXT_BOUNDARY);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: NEXT_BOUNDARY.toISOString(), count: 1 });
  });

  it.each([
    ["is not JSON", "{not json"],
    ["does not match the schema", JSON.stringify({ boundary: BOUNDARY.toISOString(), count: 0 })],
  ])("treats the boundary as past the cap when the stored count %s, overwriting it", async (_label, stored) => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, stored);
    const { dest, calls } = tracked(new InMemoryDestination("s3"));
    const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "upload_cap_reached",
      reason: "UPLOAD_ATTEMPT_CAP_REACHED",
      attempts: CAP + 1,
      chainEnabledTenantCount: 2,
    });
    expect(creates(calls)).toEqual([]);
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: CAP + 1 });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_COUNT_UNREADABLE"]);
    expect(logLines(mockLoggerError, "upload_cap_reached")).toEqual([
      expect.objectContaining({ countUnreadable: true, attempts: CAP + 1 }),
    ]);
  });

  it("after an unreadable count, writes no second row for the boundary and counts the next boundary from 1", async () => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, "{not json");
    const { dest, calls } = tracked(await archivedPrimary("s3"));
    const publisher = publisherFor(db, { destinations: [dest] });

    await publisher.runCadence(BOUNDARY);
    const again = await publisher.runCadence(BOUNDARY);
    expect(again).toMatchObject({ kind: "upload_cap_reached", attempts: CAP + 2 });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_COUNT_UNREADABLE"]);
    expect(creates(calls)).toEqual([]);

    clockInto(NEXT_BOUNDARY);
    const recovered = await publisher.runCadence(NEXT_BOUNDARY);
    expect(recovered.kind).toBe("published");
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: NEXT_BOUNDARY.toISOString(), count: 1 });
    expect(creates(calls)).toHaveLength(1);
  });

  it("past the cap creates nothing, logs upload_cap_reached, and writes one failure row per boundary", async () => {
    const db = makeDb();
    db.settings.set(ATTEMPTS_KEY, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: CAP }));
    const { dest, calls } = tracked(new InMemoryDestination("s3"));
    const publisher = publisherFor(db, { destinations: [dest] });

    const pastCap = await publisher.runCadence(BOUNDARY);
    expect(pastCap).toEqual({
      kind: "upload_cap_reached",
      reason: "UPLOAD_ATTEMPT_CAP_REACHED",
      attempts: CAP + 1,
      chainEnabledTenantCount: 2,
    });
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_CAP_REACHED"]);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.upload_cap_reached");

    mockLoggerError.mockClear();
    const again = await publisher.runCadence(BOUNDARY);
    expect(again.kind).toBe("upload_cap_reached");
    expect(failureReasons(db)).toEqual(["UPLOAD_ATTEMPT_CAP_REACHED"]);
    expect(logTypes(mockLoggerError)).toContain("audit-anchor-publisher.upload_cap_reached");
    expect(creates(calls)).toEqual([]);
  });

  it("a restart over a settled boundary never counts, so a boot past the cap does not report it", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    expect((await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY)).kind).toBe("published");

    for (let boot = 0; boot < CAP + 1; boot++) {
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);
      expect(outcome.kind).toBe("skipped_already_published");
    }
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
  });
});

// ─── runCadence: publish and adopt ──────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — publish", () => {
  it("publishes the given boundary: key and anchoredAt from it, lastPublishedAt from the wall clock, every destination the same bytes", async () => {
    const db = makeDb();
    const primary = tracked(await archivedPrimary());
    const mirrorStore = new InMemoryDestination("s3");
    const mirror = tracked(mirrorStore);
    const outcome = await publisherFor(db, { destinations: [primary.dest, mirror.dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({
      kind: "published",
      destinations: ["filesystem", "s3"],
      tenantsCount: 2,
      adopted: false,
      chainEnabledTenantCount: 2,
    });
    expect(creates(primary.calls)).toEqual([`create:${OWN_KEY_AT_BOUNDARY}`]);
    expect(creates(mirror.calls)).toEqual([`create:${OWN_KEY_AT_BOUNDARY}`]);
    const stored = await primary.dest.read(OWN_KEY_AT_BOUNDARY);
    expect(await mirrorStore.read(OWN_KEY_AT_BOUNDARY)).toEqual(stored);

    const manifest = verify(stored!.toString("utf-8"), PUBLIC_KEY);
    expect(manifest.anchoredAt).toBe(BOUNDARY.toISOString());
    expect(manifest.tenants.map((t) => t.tenantTag)).toEqual([
      computeTenantTag(TENANT_ID_1, TAG_SECRET),
      computeTenantTag(TENANT_ID_2, TAG_SECRET),
    ]);
    expect(db.updateManyCalls).toContainEqual({
      where: { tenantId: { in: [TENANT_ID_1, TENANT_ID_2] } },
      data: { lastPublishedAt: WALL_CLOCK, publishPausedUntil: null },
    });

    expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([
      {
        manifestSha256: outcome.kind === "published" ? outcome.manifestSha256 : "",
        destinations: ["filesystem", "s3"],
        tenantsCount: 2,
        artifactKey: OWN_KEY_AT_BOUNDARY,
        anchoredAt: BOUNDARY.toISOString(),
        adopted: false,
        genesis: true,
      },
    ]);
  });

  it("two runs for one boundary publish once; the second skips and the object is the first run's", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const publisher = publisherFor(db, { destinations: [primary] });

    const first = await publisher.runCadence(BOUNDARY);
    const bytes = await primary.read(OWN_KEY_AT_BOUNDARY);
    db.anchors[0]!.chainSeq = 9n;
    const second = await publisher.runCadence(BOUNDARY);

    expect([first.kind, second.kind]).toEqual(["published", "skipped_already_published"]);
    expect(await primary.read(OWN_KEY_AT_BOUNDARY)).toEqual(bytes);
    expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toHaveLength(1);
  });

  it("passes the run's abort signal to every destination call", async () => {
    const db = makeDb();
    const primary = tracked(new InMemoryDestination("filesystem"));
    const mirror = tracked(new InMemoryDestination("s3"));
    await publisherFor(db, { destinations: [primary.dest, mirror.dest] }).runCadence(BOUNDARY);

    const signals = [...primary.signals, ...mirror.signals];
    expect(signals.length).toBeGreaterThan(3);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
  });

  it.each([
    ["inside the boundary", WALL_CLOCK.getTime(), WALL_CLOCK],
    ["past the next boundary", NEXT_BOUNDARY.getTime() + MS_PER_HOUR, new Date(NEXT_BOUNDARY.getTime() - 1)],
    ["before the boundary", BOUNDARY.getTime() - MS_PER_HOUR, BOUNDARY],
  ])("writes last_published_at from config.now clamped into the boundary: a clock %s", async (_label, clockMs, expected) => {
    const db = makeDb();
    // The decision reads a clock inside the boundary; the write, the one under test.
    let now = WALL_CLOCK.getTime();
    const outcome = await publisherFor(db, {
      now: () => now,
      hooks: {
        afterUpload: async () => {
          now = clockMs;
        },
      },
    }).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("published");
    expect(publishWrites(db).map((c) => c.data.lastPublishedAt)).toEqual([expected]);
  });

  it("a publish whose clock crosses the next boundary before the database write leaves the next boundary publishable", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    let now = WALL_CLOCK.getTime();
    const crossing = await publisherFor(db, {
      destinations: [primary],
      now: () => now,
      hooks: {
        afterUpload: async () => {
          now = NEXT_BOUNDARY.getTime() + 60_000;
        },
      },
    }).runCadence(BOUNDARY);
    expect(crossing.kind).toBe("published");

    // Unclamped, the value maps to the next boundary, which the primary does
    // not hold: DESTINATION_BEHIND_DATABASE.
    const next = await publisherFor(db, { destinations: [primary], now: () => now }).runCadence(NEXT_BOUNDARY);
    expect(next).toMatchObject({ kind: "published", adopted: false });
  });

  it("publishes every tenant when one is paused, clearing the pause, with no AUDIT_ANCHOR_PUBLISH_PAUSED emit", async () => {
    const db = makeDb({
      anchors: [
        anchor(TENANT_ID_1, { publishPausedUntil: new Date("2026-12-31T00:00:00Z") }),
        anchor(TENANT_ID_2),
      ],
    });
    const outcome = await publisherFor(db).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2 });
    expect(db.anchors.map((a) => a.publishPausedUntil)).toEqual([null, null]);
    expect(db.outboxRows.map((r) => r.payload.action)).not.toContain("AUDIT_ANCHOR_PUBLISH_PAUSED");
  });

  it("writes the missing-prior row after the publish transaction, on its own transaction, carrying anchoredAt", async () => {
    const db = makeDb();
    await publisherFor(db).runCadence(BOUNDARY);

    const missing = db.outboxRows.find(
      (r) => (r.payload.metadata as Record<string, unknown>).failureReason === "MISSING_PRIOR_CADENCE_PUBLICATION",
    );
    expect(missing?.payload.metadata).toEqual({
      failureReason: "MISSING_PRIOR_CADENCE_PUBLICATION",
      prevCadenceBoundary: PREV_BOUNDARY.toISOString(),
      maxPublishedAt: null,
      anchoredAt: BOUNDARY.toISOString(),
    });
    expect(db.publishTxIndex).not.toBeNull();
    expect(missing?.txIndex).toBeGreaterThan(db.publishTxIndex ?? Infinity);
  });

  it("writes no missing-prior row when the previous boundary was published", async () => {
    const db = makeDb({
      anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
    });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(PREV_BOUNDARY));

    expect((await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY)).kind).toBe("published");
    expect(failureReasons(db)).toEqual([]);
  });

  it.each<[string, () => Partial<PublisherConfig>]>([
    [
      "an upload failure",
      () => ({
        destinations: [
          tracked(new InMemoryDestination("s3"), {
            create: async () => {
              throw new Error("down");
            },
          }).dest,
        ],
      }),
    ],
    ["a commit lost after the upload", () => ({ hooks: { afterUpload: async () => { throw new Error("connection lost"); } } })],
  ])("writes no publish row on %s, only the failure row", async (_label, overrides) => {
    // The run that publishes reports the missed boundary once; a failed run
    // would write it again on every retry.
    const db = makeDb();
    const outcome = await publisherFor(db, overrides()).runCadence(BOUNDARY);

    expect(outcome.kind).toBe("failed");
    expect(logTypes(mockLoggerWarn)).toContain("audit-anchor-publisher.missing_prior_cadence");
    expect(db.outboxRows.map((r) => (r.payload.metadata as Record<string, unknown>).failureReason)).toEqual([
      outcome.kind === "failed" ? outcome.reason : "",
    ]);
  });

  it("a lost commit is adopted by the retry: one object, the first run's bytes though the chain advanced, and the next boundary chains to it", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const { dest, calls } = tracked(primary);

    const lost = await publisherFor(db, {
      destinations: [dest],
      hooks: { afterUpload: async () => { throw new Error("commit lost"); } },
    }).runCadence(BOUNDARY);
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    const bytes = await primary.read(OWN_KEY_AT_BOUNDARY);
    expect(db.anchors.map((a) => a.lastPublishedAt)).toEqual([null, null]);

    db.anchors[0]!.chainSeq = 7n;
    const retry = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
    expect(creates(calls)).toEqual([`create:${OWN_KEY_AT_BOUNDARY}`]);
    expect(await primary.read(OWN_KEY_AT_BOUNDARY)).toEqual(bytes);

    clockInto(NEXT_BOUNDARY);
    const next = await publisherFor(db, { destinations: [dest] }).runCadence(NEXT_BOUNDARY);
    expect(next).toMatchObject({ kind: "published", adopted: false });
    const nextManifest = verify(
      (await primary.read(buildManifestArtifactKey(NEXT_BOUNDARY, KID)))!.toString("utf-8"),
      PUBLIC_KEY,
    );
    expect(nextManifest.previousManifest?.sha256).toBe(retry.kind === "published" ? retry.manifestSha256 : "");
    expect(nextManifest.tenants[0]?.chainSeq).toBe("7");
  });

  describe("create conflict: the key is taken between the decision and the create", () => {
    /** A primary whose create first lets a competing writer store `competing` at the same key. */
    function contended(primary: InMemoryDestination, competing: () => Buffer) {
      return tracked(primary, {
        create: async (args) => {
          await storeArtifact(primary, args.artifactKey, competing());
          return primary.create(args);
        },
      });
    }

    it("an object this identity signed is adopted: the stored bytes are kept and reported", async () => {
      const db = makeDb();
      const primary = await archivedPrimary();
      // Not the bytes this run signs: another chain position.
      const competing = ours(BOUNDARY, { tenants: [rowOf(TENANT_ID_1, { chainSeq: 40n }), rowOf(TENANT_ID_2)] });
      const { dest } = contended(primary, () => competing.bytes);

      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: true, manifestSha256: competing.sha256 });
      expect(await primary.read(OWN_KEY_AT_BOUNDARY)).toEqual(competing.bytes);
      expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([
        expect.objectContaining({ adopted: true, manifestSha256: competing.sha256 }),
      ]);
      expect(db.anchors.map((a) => a.lastPublishedAt)).toEqual([WALL_CLOCK, WALL_CLOCK]);
    });

    it.each<[string, () => Buffer]>([
      ["garbage", () => Buffer.from("garbage")],
      [
        "a manifest another archived key signed, stored under the own kid's name",
        () => signedManifest({ signingKey: OTHER_KEY, boundary: BOUNDARY, deploymentId: DEPLOYMENT_ID }).bytes,
      ],
    ])("%s is not adopted: the run fails closed and settles nothing", async (_label, competing) => {
      const db = makeDb();
      const primary = await archivedPrimary();
      await archivePublicKey(primary, OTHER_PUBLIC_KEY);
      const mirror = tracked(new InMemoryDestination("s3"));
      const { dest } = contended(primary, competing);

      const outcome = await publisherFor(db, { destinations: [dest, mirror.dest] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({
        kind: "failed",
        reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE",
        stage: "before_upload",
      });
      expect(await primary.read(OWN_KEY_AT_BOUNDARY)).toEqual(competing());
      expect(publishWrites(db)).toEqual([]);
      expect(pauseWrites(db)).toEqual([]);
      expect(creates(mirror.calls)).toEqual([]);
    });

    it("an object the own key signed for another deployment id ends as row g", async () => {
      const db = makeDb();
      const primary = await archivedPrimary();
      const competing = ours(BOUNDARY, { deploymentId: "another-deployment" });
      const mirror = tracked(new InMemoryDestination("s3"));
      const { dest } = contended(primary, () => competing.bytes);

      const outcome = await publisherFor(db, { destinations: [dest, mirror.dest] }).runCadence(BOUNDARY);

      expect(outcome.kind).toBe("skipped_already_published");
      expect(failureRows(db, "PUBLISHED_BY_OTHER_IDENTITY")).toHaveLength(1);
      expect(logLines(mockLoggerWarn, "published_by_other_identity")).toEqual([
        expect.objectContaining({ kidMatches: true, deploymentMatches: false }),
      ]);
      expect(publishWrites(db)).toEqual([]);
      expect(creates(mirror.calls)).toEqual([]);
    });
  });

  it("settles the anchor rows the adopted manifest covers, whatever their tenant's flag is now", async () => {
    // Published for tenants 1 and 2; since then 2 was disabled and 3 enabled.
    const db = makeDb({
      tenants: [
        { id: TENANT_ID_1, auditChainEnabled: true },
        { id: TENANT_ID_2, auditChainEnabled: false },
        { id: TENANT_ID_3, auditChainEnabled: true },
      ],
      anchors: [
        anchor(TENANT_ID_1),
        anchor(TENANT_ID_2, { publishPausedUntil: new Date("2026-12-31T00:00:00Z") }),
        anchor(TENANT_ID_3),
      ],
    });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY));
    const publisher = publisherFor(db, { destinations: [primary] });

    const outcome = await publisher.runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "published", adopted: true, tenantsCount: 2, chainEnabledTenantCount: 2 });
    expect(db.anchors.map((a) => [a.tenantId, a.lastPublishedAt, a.publishPausedUntil])).toEqual([
      [TENANT_ID_1, WALL_CLOCK, null],
      [TENANT_ID_2, WALL_CLOCK, null],
      [TENANT_ID_3, null, null],
    ]);

    // Settled: restarts skip and never count toward the cap.
    for (let boot = 0; boot < CAP + 1; boot++) {
      expect((await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY)).kind).toBe(
        "skipped_already_published",
      );
    }
    expect(JSON.parse(db.settings.get(ATTEMPTS_KEY) ?? "null")).toEqual({ boundary: BOUNDARY.toISOString(), count: 1 });
  });

  it("when no row the adopted manifest covers exists any more, nothing settles and restarts adopt up to the cap", async () => {
    const db = makeDb({
      tenants: [{ id: TENANT_ID_3, auditChainEnabled: true }],
      anchors: [anchor(TENANT_ID_3)],
    });
    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY));

    const kinds: string[] = [];
    for (let boot = 0; boot < CAP + 1; boot++) {
      kinds.push((await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY)).kind);
    }
    expect(kinds).toEqual([...Array<string>(CAP).fill("published"), "upload_cap_reached"]);
    expect(db.anchors[0]?.lastPublishedAt).toBeNull();
  });
});

// ─── runCadence: mirrors ────────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — mirrors", () => {
  it("a secondary that is down fails the run at stage upload with the primary holding one object; the retry adopts and mirrors", async () => {
    const db = makeDb();
    const primary = tracked(await archivedPrimary());
    const mirrorStore = new InMemoryDestination("s3");
    let down = true;
    const mirror = tracked(mirrorStore, {
      create: async (args) => {
        if (down) throw Object.assign(new Error("S3 unavailable"), { code: "ServiceUnavailable" });
        return mirrorStore.create(args);
      },
    });
    const publisher = publisherFor(db, { destinations: [primary.dest, mirror.dest] });

    const failed = await publisher.runCadence(BOUNDARY);

    expect(failed).toEqual({
      kind: "failed",
      // Token, not the message: it is persisted where the tenant reads it.
      reason: "s3_UPLOAD_FAILED:ServiceUnavailable",
      stage: "upload",
      chainEnabledTenantCount: 2,
    });
    const pauses = pauseWrites(db);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.where.tenantId).toEqual({ in: [TENANT_ID_1, TENANT_ID_2] });
    expect(pauses[0]?.data.publishPausedUntil).toEqual(new Date("2026-01-16T00:05:00.000Z"));
    expect(publishWrites(db)).toEqual([]);
    expect(failureReasons(db)).toEqual(["s3_UPLOAD_FAILED:ServiceUnavailable"]);
    expect(logLines(mockLoggerError, "upload_failed")).toEqual([
      {
        destination: "s3",
        error: { name: "Error", code: "ServiceUnavailable" },
        _logType: "audit-anchor-publisher.upload_failed",
      },
    ]);
    const bytes = await primary.dest.read(OWN_KEY_AT_BOUNDARY);
    expect(bytes).not.toBeNull();

    down = false;
    const retry = await publisher.runCadence(BOUNDARY);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
    expect(creates(primary.calls)).toEqual([`create:${OWN_KEY_AT_BOUNDARY}`]);
    expect(await mirrorStore.read(OWN_KEY_AT_BOUNDARY)).toEqual(bytes);
    expect(db.anchors.map((a) => a.publishPausedUntil)).toEqual([null, null]);
  });

  it.each([
    ["at the failure's clock", 0],
    ["after the failure's clock", 1],
  ])("a mirror failure does not pause a row another instance published %s; the other row is paused", async (_label, aheadMs) => {
    // `lastPublishedAt < now` is what admits the pause, so equality is on the unpaused side.
    const db = makeDb();
    const publishedByOther = new Date(WALL_CLOCK.getTime() + aheadMs);
    const { dest } = tracked(new InMemoryDestination("s3"), {
      create: async () => {
        // Between this run's rollback and its pause write.
        Object.assign(db.anchors[0]!, { lastPublishedAt: publishedByOther, publishPausedUntil: null });
        throw new Error("S3 unavailable");
      },
    });

    const outcome = await publisherFor(db, { destinations: [await archivedPrimary(), dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "s3_UPLOAD_FAILED:unknown" });
    expect(db.anchors.map((a) => [a.tenantId, a.publishPausedUntil])).toEqual([
      [TENANT_ID_1, null],
      [TENANT_ID_2, new Date("2026-01-16T00:05:00.000Z")],
    ]);
  });

  it("a primary create failure fails at stage upload and pauses until the boundary after config.now's", async () => {
    const configNow = WALL_CLOCK.getTime() + 2 * AUDIT_ANCHOR_CADENCE_MS;
    const db = makeDb();
    const { dest } = tracked(new InMemoryDestination("s3"), {
      create: async () => {
        throw new Error("S3 unavailable");
      },
    });
    // The decision's clock is inside the boundary; the failure's, two days on.
    let now = WALL_CLOCK.getTime();
    const outcome = await publisherFor(db, {
      destinations: [dest],
      now: () => now,
      hooks: {
        inTx: async () => {
          now = configNow;
        },
      },
    }).runCadence(new Date(BOUNDARY.getTime() + 2 * AUDIT_ANCHOR_CADENCE_MS));

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "s3_UPLOAD_FAILED:unknown" });
    const pauses = pauseWrites(db);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.data.publishPausedUntil).toEqual(new Date("2026-01-18T00:05:00.000Z"));
  });

  it("a secondary holding other bytes for the key fails as diverged; holding the same bytes, the run publishes", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const diverged = new InMemoryDestination("s3");
    await storeManifest(diverged, ours(BOUNDARY, { tenants: [rowOf(TENANT_ID_1, { chainSeq: 99n })] }));

    const outcome = await publisherFor(db, { destinations: [primary, diverged] }).runCadence(BOUNDARY);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "s3_MIRROR_DIVERGED",
      stage: "upload",
      chainEnabledTenantCount: 2,
    });
    expect(pauseWrites(db)).toHaveLength(1);
    expect(publishWrites(db)).toEqual([]);
    expect(logLines(mockLoggerError, "upload_failed")).toEqual([]);

    // Allow: a secondary that already holds the primary's bytes.
    const same = new InMemoryDestination("s3");
    await storeArtifact(same, OWN_KEY_AT_BOUNDARY, (await primary.read(OWN_KEY_AT_BOUNDARY))!);
    const retry = await publisherFor(db, { destinations: [primary, same] }).runCadence(BOUNDARY);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
  });

  it("a secondary that cannot be read back for the compare fails with its read token", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    const store = new InMemoryDestination("s3");
    await storeManifest(store, ours(BOUNDARY));
    const { dest } = tracked(store, {
      read: async () => {
        throw denied();
      },
    });

    const outcome = await publisherFor(db, { destinations: [primary, dest] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", reason: "s3_READ_FAILED:AccessDenied", stage: "upload" });
    expect(publishWrites(db)).toEqual([]);
  });

  describe("backfill", () => {
    const GAP = AUDIT_ANCHOR_MIRROR_BACKFILL_MAX + 1;

    /** A primary holding `GAP` earlier manifests the mirror never received. */
    async function primaryWithGap(): Promise<{ primary: InMemoryDestination; gapKeys: string[] }> {
      const primary = await archivedPrimary();
      const gapKeys: string[] = [];
      for (let daysBack = GAP; daysBack >= 1; daysBack--) {
        const planted = ours(new Date(BOUNDARY.getTime() - daysBack * AUDIT_ANCHOR_CADENCE_MS));
        await storeManifest(primary, planted);
        gapKeys.push(planted.artifactKey);
      }
      return { primary, gapKeys };
    }

    it("copies the newest missing manifest keys first, at most the bound per run, and the rest on the next", async () => {
      const { primary, gapKeys } = await primaryWithGap();
      const db = makeDb({
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
      });
      const mirror = new InMemoryDestination("s3");
      const publisher = publisherFor(db, { destinations: [primary, mirror] });

      expect((await publisher.runCadence(BOUNDARY)).kind).toBe("published");
      // The boundary's own object, and the seven newest of the eight missing: only the oldest is left.
      expect([...(await mirror.list())].sort()).toEqual([...gapKeys.slice(1), OWN_KEY_AT_BOUNDARY].sort());
      for (const key of gapKeys.slice(1)) expect(await mirror.read(key)).toEqual(await primary.read(key));

      clockInto(NEXT_BOUNDARY);
      expect((await publisher.runCadence(NEXT_BOUNDARY)).kind).toBe("published");
      expect([...(await mirror.list())].sort()).toEqual(
        [...gapKeys, OWN_KEY_AT_BOUNDARY, buildManifestArtifactKey(NEXT_BOUNDARY, KID)].sort(),
      );
      expect(logTypes(mockLoggerWarn)).not.toContain("audit-anchor-publisher.mirror_backfill_failed");
    });

    it("copies manifest keys only: the primary's archived public key is not mirrored", async () => {
      const { primary } = await primaryWithGap();
      const db = makeDb({
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
      });
      const mirror = new InMemoryDestination("s3");

      await publisherFor(db, { destinations: [primary, mirror] }).runCadence(BOUNDARY);

      expect(await mirror.list()).not.toContain(publicKeyArtifactKey(KID));
    });

    it("a secondary that throws during the backfill does not change the outcome; the next run completes it", async () => {
      const { primary, gapKeys } = await primaryWithGap();
      const db = makeDb({
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
      });
      const store = new InMemoryDestination("s3");
      let failBackfill = true;
      const { dest } = tracked(store, {
        create: async (args) => {
          if (failBackfill && args.artifactKey !== OWN_KEY_AT_BOUNDARY) throw denied();
          return store.create(args);
        },
      });
      const publisher = publisherFor(db, { destinations: [primary, dest] });

      const outcome = await publisher.runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(await store.list()).toEqual([OWN_KEY_AT_BOUNDARY]);
      expect(logLines(mockLoggerWarn, "mirror_backfill_failed")).toEqual([
        {
          destination: "s3",
          error: { name: "Error", code: "AccessDenied" },
          _logType: "audit-anchor-publisher.mirror_backfill_failed",
        },
      ]);
      expect(logLines(mockLoggerInfo, "cadence_healthy")).toHaveLength(1);
      expect(failureReasons(db)).toEqual([]);

      failBackfill = false;
      clockInto(NEXT_BOUNDARY);
      expect((await publisher.runCadence(NEXT_BOUNDARY)).kind).toBe("published");
      expect((await store.list()).filter((key) => gapKeys.includes(key))).toHaveLength(AUDIT_ANCHOR_MIRROR_BACKFILL_MAX);
    });

    it("a backfill create that finds other bytes at the key is logged and overwrites nothing", async () => {
      const primary = await archivedPrimary();
      const earlier = ours(PREV_BOUNDARY);
      await storeManifest(primary, earlier);
      const db = makeDb({
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
      });
      const store = new InMemoryDestination("s3");
      await storeArtifact(store, earlier.artifactKey, Buffer.from("other bytes"));
      // The listing misses the key the store holds, as a listing racing a writer would.
      const { dest } = tracked(store, {
        list: async (signal) => (await store.list(signal)).filter((key) => key !== earlier.artifactKey),
      });

      const outcome = await publisherFor(db, { destinations: [primary, dest] }).runCadence(BOUNDARY);

      expect(outcome.kind).toBe("published");
      expect(await store.read(earlier.artifactKey)).toEqual(Buffer.from("other bytes"));
      expect(logLines(mockLoggerWarn, "mirror_backfill_failed")).toEqual([
        expect.objectContaining({ destination: "s3", error: { name: "TokenError", code: "MIRROR_DIVERGED" } }),
      ]);
    });
  });
});

// ─── runCadence: the rows a publish emits ───────────────────────────────────

describe("AuditAnchorPublisher.runCadence — rows emitted with a publish", () => {
  /** Publish PREV_BOUNDARY and BOUNDARY on one primary, changing the database in between. */
  async function twoPublishes(
    db: FakeDb,
    between: (primary: InMemoryDestination) => void | Promise<void>,
    primary?: InMemoryDestination,
  ): Promise<{ outcomes: CadenceOutcome[]; primary: InMemoryDestination }> {
    const dest = primary ?? (await archivedPrimary());
    clockInto(PREV_BOUNDARY);
    const first = await publisherFor(db, { destinations: [dest] }).runCadence(PREV_BOUNDARY);
    db.outboxRows.length = 0;
    await between(dest);
    clockInto(BOUNDARY);
    const second = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);
    return { outcomes: [first, second], primary: dest };
  }

  it("an unchanged tenant set and an advancing chain emit the publish row alone", async () => {
    const db = makeDb();
    const { outcomes } = await twoPublishes(db, () => {
      db.anchors[0]!.chainSeq = 5n;
    });

    expect(outcomes.map((o) => o.kind)).toEqual(["published", "published"]);
    expect(db.outboxRows.map((r) => r.payload.action)).toEqual(["AUDIT_ANCHOR_PUBLISHED"]);
  });

  it("a tenant disabled between two publishes emits one TENANT_DROPPED_FROM_MANIFEST row", async () => {
    const db = makeDb();
    await twoPublishes(db, () => {
      db.tenants[1]!.auditChainEnabled = false;
    });

    expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([
      {
        failureReason: "TENANT_DROPPED_FROM_MANIFEST",
        artifactKey: OWN_KEY_AT_BOUNDARY,
        anchoredAt: BOUNDARY.toISOString(),
        comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
        count: 1,
      },
    ]);
    expect(failureReasons(db)).toEqual(["TENANT_DROPPED_FROM_MANIFEST"]);
  });

  it("a chain_seq below the previous manifest's in the same epoch emits one CHAIN_SEQ_REGRESSION row", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { chainSeq: 10n }), anchor(TENANT_ID_2, { chainSeq: 10n })] });
    await twoPublishes(db, () => {
      db.anchors[0]!.chainSeq = 9n;
      db.anchors[1]!.chainSeq = 3n;
    });

    expect(failureRows(db, "CHAIN_SEQ_REGRESSION")).toEqual([
      {
        failureReason: "CHAIN_SEQ_REGRESSION",
        artifactKey: OWN_KEY_AT_BOUNDARY,
        anchoredAt: BOUNDARY.toISOString(),
        comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
        count: 2,
      },
    ]);
  });

  it("an equal chain_seq in the same epoch emits no row", async () => {
    const db = makeDb({ anchors: [anchor(TENANT_ID_1, { chainSeq: 10n }), anchor(TENANT_ID_2, { chainSeq: 10n })] });
    await twoPublishes(db, () => {
      db.anchors[1]!.chainSeq = 11n;
    });

    expect(failureReasons(db)).toEqual([]);
  });

  it.each([
    ["a higher epoch", 2, { epoch: 3, chainSeq: 0n }],
    ["a lower epoch", 2, { epoch: 1, chainSeq: 99n }],
  ])("a tenant in %s than in the previous manifest emits one EPOCH_CHANGED row and no regression row", async (_label, before, after) => {
    const db = makeDb({
      anchors: [anchor(TENANT_ID_1, { chainSeq: 10n, epoch: before }), anchor(TENANT_ID_2, { chainSeq: 10n, epoch: before })],
    });
    await twoPublishes(db, () => {
      Object.assign(db.anchors[0]!, after);
    });

    expect(db.outboxRows.map((r) => r.payload.metadata)).toEqual([
      {
        failureReason: "EPOCH_CHANGED",
        artifactKey: OWN_KEY_AT_BOUNDARY,
        anchoredAt: BOUNDARY.toISOString(),
        comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
        count: 1,
      },
      expect.objectContaining({ manifestSha256: expect.any(String) }),
    ]);
  });

  describe("on an adopted publish", () => {
    const PREV_KEY = buildManifestArtifactKey(PREV_BOUNDARY, KID);
    const lostCommit = { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } };
    const tenAndTen = () => [anchor(TENANT_ID_1, { chainSeq: 10n }), anchor(TENANT_ID_2, { chainSeq: 10n })];

    /**
     * PREV_BOUNDARY published, `change` applied to the database, then a run
     * for BOUNDARY whose commit is lost after the create and the retry that
     * adopts what it stored. Returns the retry's outcome; the outbox holds
     * the retry's rows alone.
     */
    async function adoptedAfter(db: FakeDb, change: () => void): Promise<{ outcome: CadenceOutcome; calls: string[] }> {
      const { dest, calls } = tracked(await archivedPrimary());
      clockInto(PREV_BOUNDARY);
      await publisherFor(db, { destinations: [dest] }).runCadence(PREV_BOUNDARY);
      change();
      clockInto(BOUNDARY);
      const lost = await publisherFor(db, { destinations: [dest], ...lostCommit }).runCadence(BOUNDARY);
      expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
      db.outboxRows.length = 0;
      calls.length = 0;
      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);
      expect(outcome).toMatchObject({ kind: "published", adopted: true });
      return { outcome, calls };
    }

    it.each<[string, (db: FakeDb) => void, string, number]>([
      ["a tenant disabled before the lost commit", (db) => { db.tenants[1]!.auditChainEnabled = false; }, "TENANT_DROPPED_FROM_MANIFEST", 1],
      ["chain_seqs lowered before the lost commit", (db) => { db.anchors[0]!.chainSeq = 9n; db.anchors[1]!.chainSeq = 3n; }, "CHAIN_SEQ_REGRESSION", 2],
      ["an epoch changed before the lost commit", (db) => { db.anchors[0]!.epoch = 2; }, "EPOCH_CHANGED", 1],
    ])("%s: the adopt emits the one row a fresh publish would, and writes nothing to the destination", async (_label, change, reason, count) => {
      const db = makeDb({ anchors: tenAndTen() });
      const { calls } = await adoptedAfter(db, () => change(db));

      expect(failureReasons(db)).toEqual([reason]);
      expect(failureRows(db, reason)).toEqual([
        {
          failureReason: reason,
          artifactKey: OWN_KEY_AT_BOUNDARY,
          anchoredAt: BOUNDARY.toISOString(),
          comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
          count,
        },
      ]);
      expect(creates(calls)).toEqual([]);
      // Read back for the comparison, after the publish transaction's own reads.
      expect(calls.at(-1)).toBe(`read:${PREV_KEY}`);
    });

    it("an adopt over an unchanged tenant set and an advancing chain emits the publish row alone", async () => {
      const db = makeDb({ anchors: tenAndTen() });
      await adoptedAfter(db, () => {
        db.anchors[0]!.chainSeq = 12n;
      });

      expect(db.outboxRows.map((r) => r.payload.action)).toEqual(["AUDIT_ANCHOR_PUBLISHED"]);
    });

    it("a genesis adopt compares against nothing and emits the publish row alone", async () => {
      const db = makeDb();
      const { dest, calls } = tracked(await archivedPrimary());
      await publisherFor(db, { destinations: [dest], ...lostCommit }).runCadence(BOUNDARY);
      db.outboxRows.length = 0;
      calls.length = 0;

      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: true });
      expect(metadataOf(db, "AUDIT_ANCHOR_PUBLISHED")).toEqual([expect.objectContaining({ adopted: true, genesis: true })]);
      // No earlier boundary was published; that row is not about the comparison.
      expect(failureReasons(db)).toEqual(["MISSING_PRIOR_CADENCE_PUBLICATION"]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([]);
      expect(creates(calls)).toEqual([]);
    });

    /** A database that recorded the PREV_BOUNDARY publish, as the run that stored `original` left it. */
    const dbAfterPrevious = () => {
      const at = new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR);
      return makeDb({ anchors: [anchor(TENANT_ID_1, { lastPublishedAt: at }), anchor(TENANT_ID_2, { lastPublishedAt: at })] });
    };
    // What a lost-commit run stored for BOUNDARY: tenant 2 gone, chained to `original`.
    const original = () => ours(PREV_BOUNDARY);
    const adoptable = () =>
      ours(BOUNDARY, {
        tenants: [rowOf(TENANT_ID_1)],
        previousManifest: { uri: `filesystem://${PREV_KEY}`, sha256: original().sha256 },
      });

    it.each<[string, (primary: InMemoryDestination) => Promise<AnchorDestination>, string]>([
      [
        "holds other verified bytes, so its hash differs",
        async (primary) => {
          await storeManifest(primary, ours(PREV_BOUNDARY, { tenants: [rowOf(TENANT_ID_1, { chainSeq: 5n })] }));
          return primary;
        },
        "HASH_MISMATCH",
      ],
      ["is missing", async (primary) => primary, "OBJECT_MISSING"],
      [
        "does not verify",
        async (primary) => {
          await storeArtifact(primary, PREV_KEY, Buffer.from("garbage"));
          return primary;
        },
        "SIGNATURE_INVALID",
      ],
      [
        "cannot be read",
        async (primary) => {
          await storeManifest(primary, original());
          return tracked(primary, {
            read: async (key, signal) => {
              if (key === PREV_KEY) throw denied();
              return primary.read(key, signal);
            },
          }).dest;
        },
        "AccessDenied",
      ],
    ])("a previous manifest that %s is reported once and the adopt stands", async (_label, plant, detail) => {
      const db = dbAfterPrevious();
      const primary = await archivedPrimary();
      await storeManifest(primary, adoptable());
      const dest = await plant(primary);

      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: true });
      expect(failureReasons(db)).toEqual(["PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON"]);
      expect(failureRows(db, "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON")).toEqual([
        {
          failureReason: "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON",
          artifactKey: OWN_KEY_AT_BOUNDARY,
          anchoredAt: BOUNDARY.toISOString(),
          comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
        },
      ]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([
        { artifactKey: OWN_KEY_AT_BOUNDARY, detail, _logType: "audit-anchor-publisher.previous_manifest_unavailable" },
      ]);
      // Settled all the same: the row the adopted manifest covers.
      expect(db.anchors[0]?.lastPublishedAt).toEqual(WALL_CLOCK);
    });

    it("the same adopted manifest over the previous manifest it names is compared, not reported unavailable", async () => {
      const db = dbAfterPrevious();
      const primary = await archivedPrimary();
      await storeManifest(primary, original());
      await storeManifest(primary, adoptable());

      await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

      expect(failureReasons(db)).toEqual(["TENANT_DROPPED_FROM_MANIFEST"]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([]);
    });

    it("an object found at the key by the create is compared against the previous manifest it names, not the one this run chained to", async () => {
      const db = dbAfterPrevious();
      const primary = await archivedPrimary();
      await storeManifest(primary, original());
      const { dest } = tracked(primary, {
        create: async (args) => {
          await storeArtifact(primary, args.artifactKey, adoptable().bytes);
          return primary.create(args);
        },
      });

      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: true });
      expect(failureReasons(db)).toEqual(["TENANT_DROPPED_FROM_MANIFEST"]);
    });
  });

  describe("a stored manifest no publish settled", () => {
    const PREV_KEY = buildManifestArtifactKey(PREV_BOUNDARY, KID);
    const NEXT_KEY = buildManifestArtifactKey(NEXT_BOUNDARY, KID);
    const AFTER_NEXT_BOUNDARY = new Date(NEXT_BOUNDARY.getTime() + AUDIT_ANCHOR_CADENCE_MS);
    const lostCommit = { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } };

    /** A run for `boundary` that stores its manifest and loses the commit: nothing settles, no row is compared. */
    async function storedUnsettled(db: FakeDb, dest: AnchorDestination, boundary: Date): Promise<void> {
      clockInto(boundary);
      const lost = await publisherFor(db, { destinations: [dest], ...lostCommit }).runCadence(boundary);
      expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    }

    /** PREV_BOUNDARY published with both tenants, then tenant 2 disabled. */
    async function publishedThenDisabled(db: FakeDb): Promise<InMemoryDestination> {
      const primary = await archivedPrimary();
      clockInto(PREV_BOUNDARY);
      expect((await publisherFor(db, { destinations: [primary] }).runCadence(PREV_BOUNDARY)).kind).toBe("published");
      db.tenants[1]!.auditChainEnabled = false;
      return primary;
    }

    const dropAbout = (comparedArtifactKey: string, artifactKey: string, boundary: Date) => ({
      failureReason: "TENANT_DROPPED_FROM_MANIFEST",
      artifactKey,
      anchoredAt: boundary.toISOString(),
      comparedArtifactKey,
      count: 1,
    });

    it("a drop stored by a boundary whose every commit failed is reported once, by the next boundary's publish, after its commit", async () => {
      const db = makeDb();
      const primary = await publishedThenDisabled(db);
      await storedUnsettled(db, primary, BOUNDARY);
      db.outboxRows.length = 0;

      clockInto(NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      // The new manifest and the one it chains to both lack the tenant: only
      // the unsettled one, against its own predecessor, shows the drop.
      expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([dropAbout(OWN_KEY_AT_BOUNDARY, NEXT_KEY, NEXT_BOUNDARY)]);
      expect(failureReasons(db)).toEqual(["MISSING_PRIOR_CADENCE_PUBLICATION", "TENANT_DROPPED_FROM_MANIFEST"]);
      expect(db.outboxRows.every((r) => r.txIndex > (db.publishTxIndex ?? Infinity))).toBe(true);

      db.outboxRows.length = 0;
      clockInto(AFTER_NEXT_BOUNDARY);
      expect((await publisherFor(db, { destinations: [primary] }).runCadence(AFTER_NEXT_BOUNDARY)).kind).toBe("published");
      expect(failureReasons(db)).toEqual([]);
    });

    it("a chained-to manifest dated on the high-water's date is settled: its drop, reported by its own publish, is not reported again", async () => {
      const db = makeDb();
      const { primary } = await twoPublishes(db, () => {
        db.tenants[1]!.auditChainEnabled = false;
      });
      expect(failureReasons(db)).toEqual(["TENANT_DROPPED_FROM_MANIFEST"]);
      db.outboxRows.length = 0;
      const { dest, calls } = tracked(primary);

      clockInto(NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(failureReasons(db)).toEqual([]);
      expect(calls).not.toContain(`read:${PREV_KEY}`);
    });

    it("an adopt whose manifest chains to an unsettled one reports that one's drop too", async () => {
      const db = makeDb();
      const primary = await publishedThenDisabled(db);
      await storedUnsettled(db, primary, BOUNDARY);
      await storedUnsettled(db, primary, NEXT_BOUNDARY);
      db.outboxRows.length = 0;

      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: true });
      expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([dropAbout(OWN_KEY_AT_BOUNDARY, NEXT_KEY, NEXT_BOUNDARY)]);
    });

    it("every unsettled manifest back to the high-water is compared, not the chained-to one alone", async () => {
      const db = makeDb();
      const primary = await publishedThenDisabled(db);
      await storedUnsettled(db, primary, BOUNDARY);
      await storedUnsettled(db, primary, NEXT_BOUNDARY);
      db.outboxRows.length = 0;

      clockInto(AFTER_NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(AFTER_NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([
        dropAbout(OWN_KEY_AT_BOUNDARY, buildManifestArtifactKey(AFTER_NEXT_BOUNDARY, KID), AFTER_NEXT_BOUNDARY),
      ]);
    });

    // What the primary holds after PREV_BOUNDARY published and a lost-commit
    // run stored BOUNDARY without tenant 2.
    const settled = () => ours(PREV_BOUNDARY);
    const unsettled = () =>
      ours(BOUNDARY, {
        tenants: [rowOf(TENANT_ID_1)],
        previousManifest: { uri: `filesystem://${PREV_KEY}`, sha256: settled().sha256 },
      });
    const anchorsPublishedAt = (at: Date | null) =>
      makeDb({
        tenants: [{ id: TENANT_ID_1, auditChainEnabled: true }],
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: at }), anchor(TENANT_ID_2, { lastPublishedAt: at })],
      });

    it("with no high-water at all, the chained-to manifest is unsettled and compared", async () => {
      const db = anchorsPublishedAt(null);
      const primary = await archivedPrimary();
      await storeManifest(primary, settled());
      await storeManifest(primary, unsettled());

      clockInto(NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([dropAbout(OWN_KEY_AT_BOUNDARY, NEXT_KEY, NEXT_BOUNDARY)]);
    });

    describe("over more unsettled manifests than one run compares", () => {
      /**
       * A primary holding, before NEXT_BOUNDARY, one manifest with both tenants
       * and `unsettledCount` later ones without tenant 2, each chained to the
       * one before. Oldest first.
       */
      async function chainOf(unsettledCount: number): Promise<{ primary: InMemoryDestination; chain: SignedManifest[] }> {
        const primary = await archivedPrimary();
        const chain: SignedManifest[] = [];
        for (let daysBack = unsettledCount + 1; daysBack >= 1; daysBack--) {
          const before = chain.at(-1);
          const planted = ours(
            new Date(NEXT_BOUNDARY.getTime() - daysBack * AUDIT_ANCHOR_CADENCE_MS),
            before
              ? {
                  tenants: [rowOf(TENANT_ID_1)],
                  previousManifest: { uri: `filesystem://${before.artifactKey}`, sha256: before.sha256 },
                }
              : {},
          );
          await storeManifest(primary, planted);
          chain.push(planted);
        }
        return { primary, chain };
      }

      const settledAt = (manifest: SignedManifest) =>
        anchorsPublishedAt(new Date(new Date(manifest.manifest.anchoredAt).getTime() + MS_PER_HOUR));

      const truncatedAfter = (comparedArtifactKey: string) => ({
        failureReason: "UNSETTLED_WALK_TRUNCATED",
        artifactKey: NEXT_KEY,
        anchoredAt: NEXT_BOUNDARY.toISOString(),
        comparedArtifactKey,
        count: AUDIT_ANCHOR_UNSETTLED_WALK_MAX,
      });

      it("as many as the cap are all compared, back to the settled one, and no truncation is reported", async () => {
        const { primary, chain } = await chainOf(AUDIT_ANCHOR_UNSETTLED_WALK_MAX);
        const db = settledAt(chain[0]!);

        clockInto(NEXT_BOUNDARY);
        const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

        expect(outcome).toMatchObject({ kind: "published", adopted: false });
        // The drop sits at the far end of the walk: the oldest unsettled manifest against the settled one.
        expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([
          dropAbout(chain[1]!.artifactKey, NEXT_KEY, NEXT_BOUNDARY),
        ]);
        expect(failureRows(db, "UNSETTLED_WALK_TRUNCATED")).toEqual([]);
      });

      it("one more than the cap stops at the cap: one row with the count and the last manifest compared, and no read past it", async () => {
        const { primary, chain } = await chainOf(AUDIT_ANCHOR_UNSETTLED_WALK_MAX + 1);
        const db = settledAt(chain[0]!);
        const { dest, calls } = tracked(primary);

        clockInto(NEXT_BOUNDARY);
        const outcome = await publisherFor(db, { destinations: [dest] }).runCadence(NEXT_BOUNDARY);

        expect(outcome).toMatchObject({ kind: "published", adopted: false });
        expect(failureRows(db, "UNSETTLED_WALK_TRUNCATED")).toEqual([truncatedAfter(chain[2]!.artifactKey)]);
        // The oldest unsettled manifest holds the drop and is the one not compared.
        expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([]);
        // One predecessor read per comparison; the newest is read by the decision, not the walk.
        const predecessorReads = chain.slice(0, -1).map((m) => `read:${m.artifactKey}`);
        expect(calls.filter((call) => predecessorReads.includes(call))).toEqual(predecessorReads.slice(1).reverse());
      });

      it("with no high-water the whole chain is unsettled, and the walk still stops at the cap", async () => {
        const { primary, chain } = await chainOf(AUDIT_ANCHOR_UNSETTLED_WALK_MAX + 1);
        const db = anchorsPublishedAt(null);

        clockInto(NEXT_BOUNDARY);
        const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

        expect(outcome).toMatchObject({ kind: "published", adopted: false });
        expect(failureRows(db, "UNSETTLED_WALK_TRUNCATED")).toEqual([truncatedAfter(chain[2]!.artifactKey)]);
        expect(failureRows(db, "TENANT_DROPPED_FROM_MANIFEST")).toEqual([]);
      });

      it("a secondary missing an older manifest is backfilled in the run of a capped walk, before the walk's reads", async () => {
        const { primary, chain } = await chainOf(AUDIT_ANCHOR_UNSETTLED_WALK_MAX + 1);
        const db = settledAt(chain[0]!);
        const older = chain[0]!;
        const mirror = new InMemoryDestination("s3");
        for (const held of chain.slice(1)) await storeManifest(mirror, held);
        // The walk alone reads the oldest unsettled manifest, as the last predecessor it compares against.
        let backfilledBeforeWalkEnded: boolean | null = null;
        const { dest } = tracked(primary, {
          read: async (key, signal) => {
            if (key === chain[1]!.artifactKey) backfilledBeforeWalkEnded = (await mirror.list()).includes(older.artifactKey);
            return primary.read(key, signal);
          },
        });

        clockInto(NEXT_BOUNDARY);
        const outcome = await publisherFor(db, { destinations: [dest, mirror] }).runCadence(NEXT_BOUNDARY);

        expect(outcome).toMatchObject({ kind: "published", adopted: false });
        expect(failureRows(db, "UNSETTLED_WALK_TRUNCATED")).toEqual([truncatedAfter(chain[2]!.artifactKey)]);
        expect(await mirror.read(older.artifactKey)).toEqual(older.bytes);
        expect(backfilledBeforeWalkEnded).toBe(true);
      });
    });

    it("an unsettled chained-to genesis manifest has no predecessor: no row and nothing reported unavailable", async () => {
      const db = anchorsPublishedAt(null);
      const primary = await archivedPrimary();
      await storeManifest(primary, ours(BOUNDARY, { tenants: [rowOf(TENANT_ID_1)] }));

      clockInto(NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(failureReasons(db)).toEqual(["MISSING_PRIOR_CADENCE_PUBLICATION"]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([]);
    });

    it("an unsettled manifest whose own predecessor is missing is reported unavailable, naming it, and the publish stands", async () => {
      const db = anchorsPublishedAt(new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR));
      const primary = await archivedPrimary();
      await storeManifest(primary, unsettled());

      clockInto(NEXT_BOUNDARY);
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY);

      expect(outcome).toMatchObject({ kind: "published", adopted: false });
      expect(failureRows(db, "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON")).toEqual([
        {
          failureReason: "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON",
          artifactKey: NEXT_KEY,
          anchoredAt: NEXT_BOUNDARY.toISOString(),
          comparedArtifactKey: OWN_KEY_AT_BOUNDARY,
        },
      ]);
      expect(failureReasons(db)).toEqual(["MISSING_PRIOR_CADENCE_PUBLICATION", "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON"]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([
        { artifactKey: OWN_KEY_AT_BOUNDARY, detail: "OBJECT_MISSING", _logType: "audit-anchor-publisher.previous_manifest_unavailable" },
      ]);
    });

    it("a read-back that outlasts the run's bound is reported unavailable with the bound's code, and the publish stands", async () => {
      vi.useFakeTimers();
      const at = new Date(NEXT_BOUNDARY.getTime() + 55 * MS_PER_MINUTE);
      vi.setSystemTime(at);
      const boundMs = 400;
      const db = anchorsPublishedAt(new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR));
      const primary = await archivedPrimary();
      await storeManifest(primary, settled());
      await storeManifest(primary, unsettled());
      const { dest } = tracked(primary, {
        read: (key, signal) => (key === PREV_KEY ? new Promise<never>(() => {}) : primary.read(key, signal)),
      });

      const run = publisherFor(db, { destinations: [dest], uploadTimeoutMs: boundMs, now: () => at.getTime() }).runCadence(
        NEXT_BOUNDARY,
      );
      await vi.advanceTimersByTimeAsync(2 * boundMs);

      expect((await run).kind).toBe("published");
      expect(failureRows(db, "PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON")).toEqual([
        expect.objectContaining({ artifactKey: NEXT_KEY, comparedArtifactKey: OWN_KEY_AT_BOUNDARY }),
      ]);
      expect(logLines(mockLoggerWarn, "previous_manifest_unavailable")).toEqual([
        expect.objectContaining({ artifactKey: OWN_KEY_AT_BOUNDARY, detail: "UPLOAD_TIMEOUT" }),
      ]);
    });
  });

  it("two manifest keys on the chained-to date emit one MULTIPLE_MANIFESTS_FOR_DATE row; one key emits none", async () => {
    const db = makeDb();
    await twoPublishes(db, async (primary) => {
      await archivePublicKey(primary, OTHER_PUBLIC_KEY);
      await storeManifest(primary, signedManifest({ signingKey: OTHER_KEY, boundary: PREV_BOUNDARY }));
    });

    expect(failureRows(db, "MULTIPLE_MANIFESTS_FOR_DATE")).toEqual([
      {
        failureReason: "MULTIPLE_MANIFESTS_FOR_DATE",
        artifactKey: OWN_KEY_AT_BOUNDARY,
        anchoredAt: BOUNDARY.toISOString(),
        date: "2026-01-14",
        count: 2,
      },
    ]);
  });

  it("emits OWN_PUBLIC_KEY_NOT_ARCHIVED with every publish until the own key is archived", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    await twoPublishes(db, () => undefined, primary);
    expect(failureRows(db, "OWN_PUBLIC_KEY_NOT_ARCHIVED")).toEqual([
      { failureReason: "OWN_PUBLIC_KEY_NOT_ARCHIVED", artifactKey: OWN_KEY_AT_BOUNDARY, anchoredAt: BOUNDARY.toISOString() },
    ]);

    db.outboxRows.length = 0;
    await archivePublicKey(primary, PUBLIC_KEY);
    clockInto(NEXT_BOUNDARY);
    expect((await publisherFor(db, { destinations: [primary] }).runCadence(NEXT_BOUNDARY)).kind).toBe("published");
    expect(failureReasons(db)).toEqual([]);
  });

  it("counts an archived file holding another key's content as not archived", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    await storeArtifact(primary, publicKeyArtifactKey(KID), Buffer.from(`${OTHER_PUBLIC_KEY.toString("hex")}\n`));

    await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(failureRows(db, "OWN_PUBLIC_KEY_NOT_ARCHIVED")).toHaveLength(1);
  });
});

// ─── runCadence: failures and the bound ─────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — failures", () => {
  it("a commit lost after the upload fails at stage after_upload, writes no pause, and logs commit_failed_after_upload", async () => {
    const db = makeDb();
    const { dest, calls } = tracked(new InMemoryDestination("s3"));
    const outcome = await publisherFor(db, {
      destinations: [dest],
      hooks: { afterUpload: async () => { throw new Error("connection lost"); } },
    }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "after_upload", reason: "COMMIT_FAILED_AFTER_UPLOAD:unknown" });
    expect(creates(calls)).toHaveLength(1);
    expect(pauseWrites(db)).toEqual([]);
    expect(logLines(mockLoggerError, "commit_failed_after_upload")).toEqual([
      expect.objectContaining({ artifactKey: OWN_KEY_AT_BOUNDARY }),
    ]);
    expect(failureRows(db, "COMMIT_FAILED_AFTER_UPLOAD:unknown")).toEqual([
      expect.objectContaining({ artifactKey: OWN_KEY_AT_BOUNDARY, anchoredAt: BOUNDARY.toISOString() }),
    ]);
  });

  it("a lock timeout raised by the anchor-row write, after the object is stored, is a lost commit and not lock_held", async () => {
    const db = makeDb({ publishWriteFailure: lockTimeoutError() });
    const primary = new InMemoryDestination("s3");
    const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "after_upload", reason: "COMMIT_FAILED_AFTER_UPLOAD:55P03" });
    expect(await primary.list()).toEqual([OWN_KEY_AT_BOUNDARY]);
    expect(logLines(mockLoggerInfo, "lock_held")).toEqual([]);
  });

  describe("an error that is not a run failure, by where the primary stands", () => {
    const readFailsAt = (db: FakeDb, coveredRows: boolean) => {
      db.beforeAnchorRead = (where) => {
        if ((where === undefined) === coveredRows) throw new Error("connection lost");
      };
    };

    it.each<[string, (primary: InMemoryDestination) => Promise<AnchorDestination>]>([
      ["this run created the object", async (primary) => primary],
      [
        "the create found this identity's object at the key",
        async (primary) =>
          tracked(primary, {
            create: async (args) => {
              await storeArtifact(primary, args.artifactKey, ours(BOUNDARY).bytes);
              return primary.create(args);
            },
          }).dest,
      ],
      [
        "an earlier run's object is being adopted",
        async (primary) => {
          await storeManifest(primary, ours(BOUNDARY));
          return primary;
        },
      ],
    ])("once %s, it fails at stage upload", async (_label, arrange) => {
      const db = makeDb();
      readFailsAt(db, true);
      const primary = new InMemoryDestination("filesystem");
      const outcome = await publisherFor(db, { destinations: [await arrange(primary)] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:unknown", stage: "upload" });
      expect(await primary.list()).toEqual([OWN_KEY_AT_BOUNDARY]);
      expect(pauseWrites(db)).toEqual([]);
    });

    it("before the create, it fails at stage before_upload and nothing is stored", async () => {
      const db = makeDb();
      readFailsAt(db, false);
      const primary = new InMemoryDestination("filesystem");
      const outcome = await publisherFor(db, { destinations: [primary] }).runCadence(BOUNDARY);

      expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:unknown", stage: "before_upload" });
      expect(await primary.list()).toEqual([]);
    });
  });

  it("afterUpload runs once the primary and every mirror hold the object, before the database write", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    const mirror = new InMemoryDestination("s3");
    const seen: unknown[] = [];
    await publisherFor(db, {
      destinations: [primary, mirror],
      hooks: {
        afterUpload: async () => {
          seen.push(await primary.list(), await mirror.list(), publishWrites(db).length);
        },
      },
    }).runCadence(BOUNDARY);

    expect(seen).toEqual([[OWN_KEY_AT_BOUNDARY], [OWN_KEY_AT_BOUNDARY], 0]);
    expect(publishWrites(db)).toHaveLength(1);
  });

  it("a signing key that is not a key fails before the upload with a token reason", async () => {
    const db = makeDb();
    const primary = new InMemoryDestination("filesystem");
    const outcome = await publisherFor(db, { destinations: [primary], signingKey: Buffer.from([1]) }).runCadence(BOUNDARY);

    expect(outcome).toMatchObject({ kind: "failed", stage: "before_upload" });
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/^CADENCE_FAILED:[A-Za-z0-9_.-]+$/);
    expect(pauseWrites(db)).toEqual([]);
    expect(await primary.list()).toEqual([]);
  });

  describe("the run's one bound on destination I/O", () => {
    const hang = () => new Promise<never>(() => {});

    it.each<[string, Partial<Pick<AnchorDestination, "create" | "read" | "list">>, string, string]>([
      ["list", { list: hang }, "filesystem_READ_FAILED:UPLOAD_TIMEOUT", "before_upload"],
      ["read", { read: hang }, "filesystem_READ_FAILED:UPLOAD_TIMEOUT", "before_upload"],
      ["create", { create: hang }, "filesystem_UPLOAD_FAILED:UPLOAD_TIMEOUT", "upload"],
    ])("fails a primary whose %s never settles, under the token of the operation it interrupted", async (_op, overrides, reason, stage) => {
      vi.useRealTimers();
      const db = makeDb();
      const primary = new InMemoryDestination("filesystem");
      await storeManifest(primary, ours(new Date("2020-01-01T00:05:00.000Z")));
      const { dest, signals } = tracked(primary, overrides);

      const outcome = await publisherFor(db, { destinations: [dest], uploadTimeoutMs: 20 }).runCadence(
        currentCadenceBoundary(new Date(), AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS),
      );

      expect(outcome).toMatchObject({ kind: "failed", stage, reason });
      expect(signals.at(-1)?.aborted).toBe(true);
    });

    // The bound is armed before the first create starts, so at exactly the
    // bound (0.5 + 0.5) its timer was queued first and fires first: a create
    // that would finish at the same instant fails.
    it.each([
      ["each 0.6 of the bound fails the upload", 0.6, "failed"],
      ["each 0.5 of the bound, finishing at the bound itself, fails the upload", 0.5, "failed"],
      ["each 0.3 of the bound publishes", 0.3, "published"],
    ])("bounds the creates on every destination as a whole: two destinations %s", async (_label, fraction, kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(WALL_CLOCK);
      const boundMs = 400;
      const slow = (name: string) => {
        const store = new InMemoryDestination(name);
        return tracked(store, {
          create: (args) =>
            new Promise((resolve) => setTimeout(() => resolve(store.create({ ...args, signal: undefined })), boundMs * fraction)),
        }).dest;
      };
      const db = makeDb();
      const run = publisherFor(db, {
        destinations: [slow("filesystem"), slow("s3")],
        uploadTimeoutMs: boundMs,
        now: () => WALL_CLOCK.getTime(),
      }).runCadence(BOUNDARY);
      await vi.advanceTimersByTimeAsync(2 * boundMs);
      const outcome = await run;

      expect(outcome.kind).toBe(kind);
      if (outcome.kind === "failed") {
        expect(outcome).toMatchObject({ stage: "upload", reason: "s3_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
      }
    });

    it.each([
      ["a listing of 0.6 and a create of 0.6 of the bound fail, each within it", 0.6, "failed"],
      ["a listing of 0.3 and a create of 0.3 publish", 0.3, "published"],
    ])("is one deadline for the listing and the create: %s", async (_label, fraction, kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(WALL_CLOCK);
      const boundMs = 400;
      const delay = () => new Promise<void>((resolve) => setTimeout(resolve, boundMs * fraction));
      const store = new InMemoryDestination("filesystem");
      let lists = 0;
      const { dest } = tracked(store, {
        // Only the first listing is slow: the deadline it arms is still the
        // one running when the create starts.
        list: async () => {
          if (++lists === 1) await delay();
          return store.list();
        },
        create: async (args) => {
          await delay();
          return store.create({ ...args, signal: undefined });
        },
      });
      const db = makeDb();
      const run = publisherFor(db, {
        destinations: [dest],
        uploadTimeoutMs: boundMs,
        now: () => WALL_CLOCK.getTime(),
      }).runCadence(BOUNDARY);
      await vi.advanceTimersByTimeAsync(3 * boundMs);
      const outcome = await run;

      expect(outcome.kind).toBe(kind);
      if (outcome.kind === "failed") {
        expect(outcome).toMatchObject({ stage: "upload", reason: "filesystem_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
      }
    });

    it("is armed at the run's first destination call, not at the run's start", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(WALL_CLOCK);
      const boundMs = 400;
      const db = makeDb();
      // The first database read alone outlasts the bound.
      db.beforeTenantRead = (call) =>
        call === 1 ? new Promise<void>((resolve) => setTimeout(resolve, 2 * boundMs)) : undefined;
      const run = publisherFor(db, { uploadTimeoutMs: boundMs, now: () => WALL_CLOCK.getTime() }).runCadence(BOUNDARY);
      await vi.advanceTimersByTimeAsync(3 * boundMs);

      expect((await run).kind).toBe("published");
    });

    it("covers the mirror backfill: a backfill that outlasts the bound is logged and the publish stands", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(WALL_CLOCK);
      const boundMs = 400;
      const primary = await archivedPrimary();
      await storeManifest(primary, ours(PREV_BOUNDARY));
      const db = makeDb({
        anchors: [anchor(TENANT_ID_1, { lastPublishedAt: new Date(PREV_BOUNDARY.getTime() + MS_PER_HOUR) }), anchor(TENANT_ID_2)],
      });
      const store = new InMemoryDestination("s3");
      const { dest } = tracked(store, {
        create: (args) => (args.artifactKey === OWN_KEY_AT_BOUNDARY ? store.create(args) : new Promise<never>(() => {})),
      });
      const run = publisherFor(db, {
        destinations: [primary, dest],
        uploadTimeoutMs: boundMs,
        now: () => WALL_CLOCK.getTime(),
      }).runCadence(BOUNDARY);
      await vi.advanceTimersByTimeAsync(2 * boundMs);

      expect((await run).kind).toBe("published");
      expect(logLines(mockLoggerWarn, "mirror_backfill_failed")).toEqual([
        expect.objectContaining({ error: { name: "UploadTimeoutError", code: "UPLOAD_TIMEOUT" } }),
      ]);
    });
  });
});

// ─── runCadence: log lines ──────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence — cadence lines", () => {
  async function runWith(db: FakeDb, overrides: Partial<PublisherConfig> = {}): Promise<CadenceOutcome> {
    mockLoggerInfo.mockClear();
    return publisherFor(db, overrides).runCadence(BOUNDARY);
  }

  it("every outcome logs one cadence line carrying the chain-enabled tenant count", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    await runWith(db, { destinations: [primary] });
    expect(logLines(mockLoggerInfo, "cadence")).toEqual([
      expect.objectContaining({ kind: "published", adopted: false, chainEnabledTenantCount: 2, boundary: BOUNDARY.toISOString() }),
    ]);

    await runWith(db, { destinations: [primary] });
    expect(logLines(mockLoggerInfo, "cadence")).toEqual([
      expect.objectContaining({ kind: "skipped_already_published", chainEnabledTenantCount: 2 }),
    ]);
  });

  it("emits exactly one healthy line for a published run, adopted or not", async () => {
    await runWith(makeDb());
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([
      expect.objectContaining({ outcome: "published", chainEnabledTenantCount: 2 }),
    ]);

    const primary = await archivedPrimary();
    await storeManifest(primary, ours(BOUNDARY));
    const adopted = await runWith(makeDb(), { destinations: [primary] });
    expect(adopted).toMatchObject({ kind: "published", adopted: true });
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toHaveLength(1);
  });

  it("emits no healthy line for already-published, failed, cap-reached or lock_held runs", async () => {
    const db = makeDb();
    const primary = await archivedPrimary();
    await runWith(db, { destinations: [primary] });
    await runWith(db, { destinations: [primary] });
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);

    const failing = tracked(new InMemoryDestination("s3"), {
      create: async () => {
        throw new Error("x");
      },
    });
    await runWith(makeDb(), { destinations: [failing.dest] });
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);

    const capped = makeDb();
    capped.settings.set(ATTEMPTS_KEY, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: CAP }));
    await runWith(capped);
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);

    await runWith(makeDb({ lockTimeoutOnCall: new Set([1]) }));
    expect(logLines(mockLoggerInfo, "cadence_healthy")).toEqual([]);
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
    const outcome = await publisherFor(db, { destinations: [await archivedPrimary()] }).runCadence(BOUNDARY);

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
