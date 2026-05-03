/**
 * Unit tests for AuditAnchorPublisher.
 *
 * Covers:
 *   - currentCadenceBoundary / previousCadenceBoundary pure math
 *   - runCadence flow-control branches:
 *       * lock_held when advisory lock not acquired
 *       * skipped_no_tenants when no chain-enabled tenants
 *       * skipped_paused when all anchors are paused
 *       * published happy-path with destinations
 *       * failed when destination upload throws (with pause-persist tx)
 *   - DeploymentIdMismatchError thrown when stored deploymentId differs
 *   - createPublisher factory wires Prisma + Pool and exposes shutdown
 *
 * The destination interface is mocked per the plan allowlist
 * (`@/lib/audit/anchor-destinations/*` is allowed for this publisher).
 *
 * Real Prisma is replaced with a transaction-callback impl that exposes the
 * `tx` rows the publisher reads. anchor-manifest functions run for real
 * (they use `node:crypto`; mocking would silently disable signing).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AuditAnchorPublisher,
  DeploymentIdMismatchError,
  createPublisher,
  currentCadenceBoundary,
  previousCadenceBoundary,
  type PublisherConfig,
} from "./audit-anchor-publisher";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockLogAuditAsync, mockLoggerError, mockLoggerWarn } = vi.hoisted(() => ({
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: vi.fn(),
  }),
}));

// ─── Test fixtures ───────────────────────────────────────────────────────────

const TENANT_ID_1 = "11111111-1111-4111-8111-111111111111";
const TENANT_ID_2 = "22222222-2222-4222-8222-222222222222";

const SIGNING_KEY = randomBytes(32);
const TAG_SECRET = randomBytes(32);

const CADENCE_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = 5 * 60 * 1000;

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
    signingKeyKid: "audit-anchor-key-test12345",
    tagSecret: TAG_SECRET,
    destinations: [makeDestination("filesystem")],
    cadenceMs: CADENCE_MS,
    publishOffsetMs: OFFSET_MS,
    pauseCapFactor: 7,
    ...overrides,
  };
}

interface FakeAnchor {
  tenantId: string;
  chainSeq: bigint;
  prevHash: Buffer;
  epoch: number | null;
  publishPausedUntil: Date | null;
  updatedAt: Date;
}

interface FakeTxRows {
  /** lock acquired flag — controls the advisory lock query */
  lockAcquired: boolean;
  tenants: Array<{ id: string; auditChainEnabled: boolean }>;
  anchors: FakeAnchor[];
  previousManifestRow: { value: string } | null;
  /** stored deploymentId for ensureDeploymentIdMatch path */
  storedDeploymentId: string | null;
  /** captured updateMany calls so tests can assert pause-persist behavior */
  updateManyCalls: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>;
  upsertCalls: number;
}

function makeFakeTx(rows: FakeTxRows) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn(async (template: TemplateStringsArray) => {
      const sql = template.raw.join("$");
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: rows.lockAcquired }];
      }
      if (sql.includes("system_settings WHERE key")) {
        return rows.storedDeploymentId !== null
          ? [{ value: rows.storedDeploymentId }]
          : [];
      }
      if (sql.includes("MAX(last_published_at)")) {
        return [{ max_published: null }];
      }
      return [];
    }),
    tenant: {
      findMany: vi.fn(async () =>
        rows.tenants.filter((t) => t.auditChainEnabled),
      ),
    },
    auditChainAnchor: {
      findMany: vi.fn(async () => rows.anchors),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        rows.updateManyCalls.push(args);
        return { count: rows.anchors.length };
      }),
    },
    systemSetting: {
      findUnique: vi.fn(async () => rows.previousManifestRow),
      upsert: vi.fn(async () => {
        rows.upsertCalls++;
        return {};
      }),
    },
  };
}

function makeFakePrisma(rowsHolder: { rows: FakeTxRows }): PrismaClient {
  const fakePrisma: Pick<PrismaClient, "$transaction" | "$disconnect"> = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(makeFakeTx(rowsHolder.rows));
    }) as unknown as PrismaClient["$transaction"],
    $disconnect: vi.fn().mockResolvedValue(undefined) as unknown as PrismaClient["$disconnect"],
  };
  return fakePrisma as unknown as PrismaClient;
}

function defaultRows(overrides: Partial<FakeTxRows> = {}): FakeTxRows {
  return {
    lockAcquired: true,
    tenants: [
      { id: TENANT_ID_1, auditChainEnabled: true },
      { id: TENANT_ID_2, auditChainEnabled: true },
    ],
    anchors: [
      {
        tenantId: TENANT_ID_1,
        chainSeq: 1n,
        prevHash: Buffer.alloc(32, 0xa1),
        epoch: 1,
        publishPausedUntil: null,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        tenantId: TENANT_ID_2,
        chainSeq: 2n,
        prevHash: Buffer.alloc(32, 0xb2),
        epoch: 1,
        publishPausedUntil: null,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    previousManifestRow: null,
    storedDeploymentId: null,
    updateManyCalls: [],
    upsertCalls: 0,
    ...overrides,
  };
}

// ─── currentCadenceBoundary / previousCadenceBoundary ───────────────────────

describe("cadence math", () => {
  it("currentCadenceBoundary aligns to floor((now - offset) / cadence) * cadence + offset", () => {
    // 2026-01-15T12:34:56Z with cadence=24h offset=5min should snap to
    // 2026-01-15T00:05:00Z
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

// ─── runCadence ──────────────────────────────────────────────────────────────

describe("AuditAnchorPublisher.runCadence", () => {
  beforeEach(() => {
    mockLogAuditAsync.mockClear();
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
  });

  it("returns lock_held when advisory lock is not acquired", async () => {
    const holder = { rows: defaultRows({ lockAcquired: false }) };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({ prisma, config: makeConfig() });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome).toEqual({
      kind: "lock_held",
      reason: "LOCK_HELD_BY_OTHER_INSTANCE",
    });
  });

  it("returns skipped_no_tenants when no chain-enabled tenants exist", async () => {
    const holder = { rows: defaultRows({ tenants: [], anchors: [] }) };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({ prisma, config: makeConfig() });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
    });
  });

  it("returns skipped_paused when every anchor is paused beyond `now`", async () => {
    const futureDate = new Date("2026-12-31T00:00:00Z");
    const holder = {
      rows: defaultRows({
        anchors: [
          {
            tenantId: TENANT_ID_1,
            chainSeq: 1n,
            prevHash: Buffer.alloc(32, 0xa1),
            epoch: 1,
            publishPausedUntil: futureDate,
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
        tenants: [{ id: TENANT_ID_1, auditChainEnabled: true }],
      }),
    };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({ prisma, config: makeConfig() });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome).toEqual({
      kind: "skipped_paused",
      reason: "PUBLISH_PAUSED_ACTIVE",
    });
  });

  it("publishes successfully and uploads to all destinations", async () => {
    const holder = { rows: defaultRows() };
    const prisma = makeFakePrisma(holder);
    const upload1 = vi.fn().mockResolvedValue(undefined);
    const upload2 = vi.fn().mockResolvedValue(undefined);
    const dest1 = makeDestination("filesystem", upload1);
    const dest2 = makeDestination("s3", upload2);

    const publisher = new AuditAnchorPublisher({
      prisma,
      config: makeConfig({ destinations: [dest1, dest2] }),
    });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome.kind).toBe("published");
    if (outcome.kind === "published") {
      expect(outcome.destinations).toEqual(["filesystem", "s3"]);
      expect(outcome.tenantsCount).toBe(2);
      expect(outcome.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(upload1).toHaveBeenCalledTimes(1);
    expect(upload2).toHaveBeenCalledTimes(1);
    // last_published_at update fired
    expect(holder.rows.updateManyCalls.length).toBeGreaterThanOrEqual(1);
    // previous-manifest pointer upserted
    expect(holder.rows.upsertCalls).toBe(1);
    // success audit emitted post-commit
    const publishedEvent = mockLogAuditAsync.mock.calls.find(
      ([args]) => args.action === "AUDIT_ANCHOR_PUBLISHED",
    );
    expect(publishedEvent).toBeDefined();
  });

  it("returns failed and persists pause when destination upload throws", async () => {
    const holder = { rows: defaultRows() };
    const prisma = makeFakePrisma(holder);
    const failingDest = makeDestination(
      "s3",
      vi.fn().mockRejectedValue(new Error("S3 unavailable")),
    );

    const publisher = new AuditAnchorPublisher({
      prisma,
      config: makeConfig({ destinations: [failingDest] }),
    });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      // Reason format: `${dest.name}_UPLOAD_FAILED: ${errMsg}` (dest.name = "s3")
      expect(outcome.reason).toContain("s3_UPLOAD_FAILED");
      expect(outcome.reason).toContain("S3 unavailable");
    }
    // The pause-persist tx must run AFTER rollback. Look for an updateMany
    // whose data carries `publishPausedUntil` (the dedicated pause UPDATE).
    const pauseCall = holder.rows.updateManyCalls.find(
      (c) => "publishPausedUntil" in c.data && c.data.publishPausedUntil instanceof Date,
    );
    expect(pauseCall).toBeDefined();
    // Failure audit emitted
    const failureEvent = mockLogAuditAsync.mock.calls.find(
      ([args]) => args.action === "AUDIT_ANCHOR_PUBLISH_FAILED",
    );
    expect(failureEvent).toBeDefined();
  });

  it("emits informational pause audit for paused anchors and continues with non-paused", async () => {
    const futureDate = new Date("2026-12-31T00:00:00Z");
    const holder = {
      rows: defaultRows({
        anchors: [
          {
            tenantId: TENANT_ID_1,
            chainSeq: 1n,
            prevHash: Buffer.alloc(32, 0xa1),
            epoch: 1,
            publishPausedUntil: futureDate,
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            tenantId: TENANT_ID_2,
            chainSeq: 2n,
            prevHash: Buffer.alloc(32, 0xb2),
            epoch: 1,
            publishPausedUntil: null,
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      }),
    };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({ prisma, config: makeConfig() });

    const outcome = await publisher.runCadence(new Date("2026-01-15T01:00:00Z"));

    expect(outcome.kind).toBe("published");
    if (outcome.kind === "published") {
      expect(outcome.tenantsCount).toBe(1);
    }
    // Yield to the microtask queue so the void logAuditAsync settles.
    await Promise.resolve();
    const pauseAuditEvent = mockLogAuditAsync.mock.calls.find(
      ([args]) => args.action === "AUDIT_ANCHOR_PUBLISH_PAUSED",
    );
    expect(pauseAuditEvent).toBeDefined();
  });
});

// ─── ensureDeploymentIdMatch ────────────────────────────────────────────────

describe("AuditAnchorPublisher.ensureDeploymentIdMatch", () => {
  beforeEach(() => {
    mockLogAuditAsync.mockClear();
  });

  it("throws DeploymentIdMismatchError when the stored ID belongs to another instance", async () => {
    const holder = {
      rows: defaultRows({ storedDeploymentId: "other-deploy" }),
    };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({
      prisma,
      config: makeConfig({ deploymentId: "deploy-x" }),
    });

    await expect(publisher.ensureDeploymentIdMatch()).rejects.toBeInstanceOf(
      DeploymentIdMismatchError,
    );
    // Mismatch must be audited
    const event = mockLogAuditAsync.mock.calls.find(
      ([args]) =>
        args.action === "AUDIT_ANCHOR_PUBLISH_FAILED" &&
        args.metadata?.failureReason === "DEPLOYMENT_ID_MISMATCH",
    );
    expect(event).toBeDefined();
  });

  it("succeeds when the stored deploymentId matches", async () => {
    const holder = { rows: defaultRows({ storedDeploymentId: "deploy-x" }) };
    const prisma = makeFakePrisma(holder);
    const publisher = new AuditAnchorPublisher({
      prisma,
      config: makeConfig({ deploymentId: "deploy-x" }),
    });

    await expect(publisher.ensureDeploymentIdMatch()).resolves.toBeUndefined();
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
