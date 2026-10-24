/**
 * The publisher's log lines against the CloudWatch metric filters that count
 * them (infra/terraform/monitoring.tf). Lines come from the real publisher and
 * scheduler through the logger's real options, driven over a fake database
 * into each outcome; patterns are read from the Terraform configuration as it
 * renders them. Each filter must match the line its path really emits and
 * none of the others — a skip that is not healthy counting as healthy is the
 * failure the absence alarm exists to rule out.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { matchesFilterPattern } from "@/__tests__/helpers/cloudwatch-filter-pattern";
import { TerraformConfig, TERRAFORM_DIR, plain } from "@/__tests__/helpers/hcl-subset";

const chunks: string[] = [];
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  const sink = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ ...actual.loggerOptions, level: "info" }, sink);
  return { ...actual, default: logger, getLogger: () => logger };
});

// The audit stream is not what these filters read; keep it off stdout. The
// dead-letter stream is (the publisher's dead-letter filter): its real options,
// into the same sink.
vi.mock("@/lib/audit/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit-logger")>();
  const sink = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { ...actual, auditLogger: { info: vi.fn() }, deadLetterLogger: pino(actual.deadLetterLoggerOptions, sink) };
});

// createPublisher's pool, so its error listener can be driven.
const pools = vi.hoisted(() => [] as EventEmitter[]);
vi.mock("@/lib/db/pool-factory", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    createPool: () => {
      const pool = Object.assign(new Emitter(), { end: async () => undefined });
      pools.push(pool);
      return pool;
    },
    createPrismaClient: () => ({ $disconnect: async () => undefined }),
  };
});

import {
  AuditAnchorPublisher,
  PUBLISHER_AUDIT_DEAD_LETTER_REASON,
  SETTING_LAST_PUBLISHED_BOUNDARY,
  SETTING_UPLOAD_ATTEMPTS,
  createPublisher,
  type PublisherConfig,
} from "./audit-anchor-publisher";
import { createAnchorScheduler } from "./audit-anchor-scheduler";

const BOUNDARY = new Date("2026-01-15T00:05:00.000Z");
const TENANT = "11111111-1111-4111-8111-111111111111";

// ─── A fake database, just enough for each outcome ─────────────────────────

type Db = {
  enabled: string[];
  anchors: string[];
  settings: Map<string, string>;
  lockTimeoutOnCall?: number;
  failPauseWrite?: boolean;
  failOutbox?: boolean;
  lockCalls: number;
};

function makeDb(overrides: Partial<Db> = {}): Db {
  return { enabled: [TENANT], anchors: [TENANT], settings: new Map(), lockCalls: 0, ...overrides };
}

function lockTimeoutError(): Error {
  return Object.assign(new Error("Raw query failed."), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: "55P03", kind: "postgres" } } },
  });
}

function fakePrisma(db: Db): PrismaClient {
  const tx = {
    $executeRaw: async (template: TemplateStringsArray) => {
      if (template.raw.join("$").includes("pg_advisory_xact_lock")) {
        db.lockCalls++;
        if (db.lockCalls === db.lockTimeoutOnCall) throw lockTimeoutError();
      }
      return 1;
    },
    $queryRaw: async () => [{ max_published: null }],
    tenant: { findMany: async () => db.enabled.map((id) => ({ id })) },
    auditChainAnchor: {
      findFirst: async () => (db.anchors[0] ? { tenantId: db.anchors[0] } : null),
      findMany: async () =>
        db.anchors.filter((id) => db.enabled.includes(id)).map((tenantId) => ({ tenantId, chainSeq: 1n, prevHash: Buffer.alloc(32, 1), epoch: 1 })),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        if (db.failPauseWrite && args.data.publishPausedUntil instanceof Date) throw new Error("pause write failed");
        return { count: 1 };
      },
    },
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = db.settings.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      },
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        db.settings.set(where.key, update.value);
        return {};
      },
    },
    auditOutbox: {
      createMany: async () => {
        if (db.failOutbox) throw Object.assign(new Error("permission denied for table audit_outbox"), { code: "42501" });
        return { count: 1 };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return prisma as unknown as PrismaClient;
}

function config(overrides: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    deploymentId: "11111111-2222-4333-8444-555555555555",
    signingKey: randomBytes(32),
    signingKeyKid: "audit-anchor-0123456789abcdef",
    tagSecret: randomBytes(32),
    destinations: [{ name: "s3-object-lock", upload: async () => undefined }],
    cadenceMs: 24 * 60 * 60 * 1000,
    publishOffsetMs: 5 * 60 * 1000,
    ...overrides,
  };
}

/** Every JSON line a block of work logged. */
async function linesOf(work: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  chunks.length = 0;
  await work();
  return chunks.map((c) => JSON.parse(c) as Record<string, unknown>);
}

async function cadence(db: Db, overrides: Partial<PublisherConfig> = {}): Promise<Record<string, unknown>[]> {
  return linesOf(() => new AuditAnchorPublisher({ prisma: fakePrisma(db), config: config(overrides) }).runCadence(BOUNDARY));
}

const ATTEMPTS = SETTING_UPLOAD_ATTEMPTS;
const MARKER = SETTING_LAST_PUBLISHED_BOUNDARY;
const CADENCE = 24 * 60 * 60 * 1000;

const failingUpload = { destinations: [{ name: "s3-object-lock", upload: async () => Promise.reject(Object.assign(new Error("denied"), { code: "AccessDenied" })) }] };

/** Scenario name → the lines it logged. Filled once, before the cases. */
const lines: Record<string, Record<string, unknown>[]> = {};

beforeAll(async () => {
  lines.published = await cadence(makeDb());
  lines.never_enabled = await cadence(makeDb({ enabled: [], anchors: [] }));
  lines.disabled_after_enabled = await cadence(makeDb({ enabled: [], anchors: [TENANT] }));
  lines.already_published = await cadence(makeDb({ settings: new Map([[MARKER, BOUNDARY.toISOString()]]) }));
  lines.stale_marker = await cadence(makeDb({ settings: new Map([[MARKER, new Date(BOUNDARY.getTime() + CADENCE).toISOString()]]) }));
  // Past the wall clock's current boundary (the real clock here): fails closed.
  lines.marker_ahead = await cadence(makeDb({ settings: new Map([[MARKER, new Date(Date.now() + 2 * CADENCE).toISOString()]]) }));
  lines.upload_failed = await cadence(makeDb(), failingUpload);
  lines.cap_reached = await cadence(makeDb({ settings: new Map([[ATTEMPTS, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: 3 })]]) }));
  lines.lock_held = await cadence(makeDb({ lockTimeoutOnCall: 1 }));
  lines.commit_failed = await cadence(makeDb(), {
    hooks: {
      afterUpload: async () => {
        throw Object.assign(new Error("commit lost"), { code: "P1017" });
      },
    },
  });
  lines.pause_persist_failed = await cadence(makeDb({ failPauseWrite: true }), failingUpload);
  // The publisher's own audit write refused: a deployment-id mismatch's row,
  // which is the only line that path logs.
  lines.dead_letter = await linesOf(async () => {
    const publisher = new AuditAnchorPublisher({ prisma: fakePrisma(makeDb({ failOutbox: true })), config: config() });
    await publisher.ensureDeploymentIdMatch().catch(() => undefined);
  });
  lines.pool_error = await linesOf(async () => {
    createPublisher(config());
    pools[pools.length - 1].emit("error", Object.assign(new Error("terminated"), { code: "57P01" }));
  });
  lines.scheduler_error = await linesOf(async () => {
    const scheduler = createAnchorScheduler({
      runCadence: async () => {
        throw new Error("unexpected");
      },
      cadenceMs: 24 * 60 * 60 * 1000,
      publishOffsetMs: 5 * 60 * 1000,
      now: () => BOUNDARY.getTime() + 1000,
      setTimer: () => null,
      clearTimer: () => undefined,
    });
    await scheduler.start();
    await scheduler.stop();
  });
});

// ─── The filters, as Terraform renders them ─────────────────────────────────

const tf = new TerraformConfig(TERRAFORM_DIR);

function pattern(name: string, each?: { key: string; value: string }): string {
  return String(tf.attr(tf.resource("aws_cloudwatch_log_metric_filter", name), "pattern", each ? { each } : {}));
}

function metricOf(name: string, each?: { key: string; value: string }): { name: unknown; namespace: unknown } {
  const filter = tf.resource("aws_cloudwatch_log_metric_filter", name);
  const t = filter.body.blocks.find((b) => b.type === "metric_transformation");
  if (!t) throw new Error(`${name}: no metric_transformation`);
  const opts = each ? { each } : {};
  return { name: tf.attr(t, "name", opts), namespace: tf.attr(t, "namespace", opts) };
}

function alarmMetric(name: string, each?: { key: string; value: string }): { name: unknown; namespace: unknown } {
  const alarm = tf.resource("aws_cloudwatch_metric_alarm", name);
  const opts = each ? { each } : {};
  return { name: tf.attr(alarm, "metric_name", opts), namespace: tf.attr(alarm, "namespace", opts) };
}

const FAILURE_LOG_TYPES = plain(tf.local("audit_anchor_publisher_failure_log_types")) as Record<string, string>;

/** Scenario names whose lines a pattern matches. */
function matchingScenarios(p: string): string[] {
  return Object.entries(lines)
    .filter(([, ls]) => ls.some((l) => matchesFilterPattern(p, l)))
    .map(([name]) => name)
    .sort();
}

describe("publisher log lines vs their metric filters", () => {
  it("logs the outcome each scenario is named for", () => {
    const kinds = (name: string) => lines[name].filter((l) => l._logType === "audit-anchor-publisher.cadence").map((l) => l.kind);
    expect(kinds("published")).toEqual(["published"]);
    expect(kinds("never_enabled")).toEqual(["skipped_no_tenants"]);
    expect(kinds("disabled_after_enabled")).toEqual(["skipped_no_tenants"]);
    expect(kinds("already_published")).toEqual(["skipped_already_published"]);
    expect(kinds("stale_marker")).toEqual(["skipped_already_published"]);
    expect(lines.stale_marker.map((l) => l._logType)).toContain("audit-anchor-publisher.stale_boundary");
    expect(kinds("marker_ahead")).toEqual(["failed"]);
    expect(lines.marker_ahead.find((l) => l._logType === "audit-anchor-publisher.cadence")?.reason).toBe("CADENCE_FAILED:BOUNDARY_MARKER_AHEAD");
    expect(kinds("upload_failed")).toEqual(["failed"]);
    expect(kinds("cap_reached")).toEqual(["upload_cap_reached"]);
    expect(kinds("lock_held")).toEqual(["lock_held"]);
    expect(kinds("commit_failed")).toEqual(["failed"]);
  });

  it("counts a healthy boundary only for published and never-enabled skipped_no_tenants", () => {
    expect(matchingScenarios(pattern("audit_anchor_cadence_healthy"))).toEqual(["never_enabled", "published"]);
  });

  it("counts exactly one healthy line per healthy boundary", () => {
    const p = pattern("audit_anchor_cadence_healthy");
    expect(lines.published.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
    expect(lines.never_enabled.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
  });

  it("raises the falls-to-zero filter only for skipped_no_tenants with everChainEnabled true", () => {
    expect(matchingScenarios(pattern("audit_anchor_chain_enabled_fell_to_zero"))).toEqual(["disabled_after_enabled"]);
  });

  it("raises the falls-to-zero filter when the count goes from 1 to 0", async () => {
    const p = pattern("audit_anchor_chain_enabled_fell_to_zero");
    const db = makeDb();
    const publisher = new AuditAnchorPublisher({ prisma: fakePrisma(db), config: config() });
    const before = await linesOf(() => publisher.runCadence(BOUNDARY));
    expect(before.find((l) => l._logType === "audit-anchor-publisher.cadence")?.chainEnabledTenantCount).toBe(1);
    expect(before.some((l) => matchesFilterPattern(p, l))).toBe(false);
    db.enabled = [];
    const after = await linesOf(() => publisher.runCadence(new Date(BOUNDARY.getTime() + 24 * 60 * 60 * 1000)));
    expect(after.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
  });

  const expectedScenarios: Record<string, string[]> = {
    cadence_failed: ["commit_failed", "marker_ahead", "pause_persist_failed", "upload_failed"],
    lock_held: ["lock_held"],
    stale_boundary: ["stale_marker"],
    upload_failed: ["pause_persist_failed", "upload_failed"],
    upload_cap_reached: ["cap_reached"],
    commit_failed_after_upload: ["commit_failed"],
    pause_persist_failed: ["pause_persist_failed"],
    pool_error: ["pool_error"],
    cadence_error: ["scheduler_error"],
  };

  it("has a failure filter for every failure line and nothing else", () => {
    expect(Object.keys(FAILURE_LOG_TYPES).sort()).toEqual(Object.keys(expectedScenarios).sort());
  });

  it.each(Object.keys(expectedScenarios))("matches the %s filter to the line its path emits, and no other", (key) => {
    const p = pattern("audit_anchor_publisher_failure", { key, value: FAILURE_LOG_TYPES[key] });
    expect(matchingScenarios(p)).toEqual(expectedScenarios[key]);
  });

  it("matches the publisher's dead-letter filter to its real dead-letter line, and no other", () => {
    const p = pattern("audit_anchor_publisher_dead_letter");
    expect(matchingScenarios(p)).toEqual(["dead_letter"]);
    expect(lines.dead_letter.filter((l) => matchesFilterPattern(p, l))).toEqual([
      expect.objectContaining({
        _logType: "audit-dead-letter",
        reason: PUBLISHER_AUDIT_DEAD_LETTER_REASON,
        action: "AUDIT_ANCHOR_PUBLISH_FAILED",
        error: { name: "Error", code: "42501" },
      }),
    ]);
    expect(metricOf("audit_anchor_publisher_dead_letter")).toEqual(alarmMetric("audit_anchor_publisher_dead_letter"));
  });

  it("publishes each failure filter to the metric its alarm watches", () => {
    for (const [key, value] of Object.entries(FAILURE_LOG_TYPES)) {
      expect(metricOf("audit_anchor_publisher_failure", { key, value })).toEqual(alarmMetric("audit_anchor_publisher_failure", { key, value }));
    }
    expect(metricOf("audit_anchor_cadence_healthy")).toEqual(alarmMetric("audit_anchor_cadence_absent"));
    expect(metricOf("audit_anchor_chain_enabled_fell_to_zero")).toEqual(alarmMetric("audit_anchor_chain_enabled_fell_to_zero"));
  });

  it("treats a silent day as breaching on the healthy-cadence alarm, over ~25 h", () => {
    const alarm = tf.resource("aws_cloudwatch_metric_alarm", "audit_anchor_cadence_absent");
    expect(tf.attr(alarm, "treat_missing_data")).toBe("breaching");
    expect(Number(tf.attr(alarm, "period")) * Number(tf.attr(alarm, "evaluation_periods"))).toBe(25 * 3600);
    expect(tf.attr(alarm, "datapoints_to_alarm")).toBe(tf.attr(alarm, "evaluation_periods"));
    // No default_value: a silent hour must be missing data, not a zero.
    const t = tf.resource("aws_cloudwatch_log_metric_filter", "audit_anchor_cadence_healthy").body.blocks.find((b) => b.type === "metric_transformation");
    expect(t && "default_value" in t.body.attrs).toBe(false);
  });

  it("sizes the publisher down alarm past a deploy's zero-task gap", () => {
    const alarm = tf.resource("aws_cloudwatch_metric_alarm", "audit_anchor_publisher_down");
    const window = Number(tf.attr(alarm, "period")) * Number(tf.attr(alarm, "datapoints_to_alarm"));
    const stopTimeout = (plain(tf.attr(tf.resource("aws_ecs_task_definition", "audit_anchor_publisher"), "container_definitions")) as Array<{ stopTimeout: number }>)[0].stopTimeout;
    // The old task's drain plus placing and pulling the new one.
    expect(window).toBeGreaterThanOrEqual(stopTimeout + 5 * 60);
    expect(String((tf.attr(alarm, "dimensions") as Record<string, unknown>).ServiceName)).toBe("<ref:aws_ecs_service.audit_anchor_publisher.name>");
  });

  it("binds every publisher filter to the publisher's log group", () => {
    for (const name of [
      "audit_anchor_cadence_healthy",
      "audit_anchor_chain_enabled_fell_to_zero",
      "audit_anchor_publisher_failure",
      "audit_anchor_publisher_dead_letter",
    ]) {
      const filter = tf.resource("aws_cloudwatch_log_metric_filter", name);
      expect(String(tf.attr(filter, "log_group_name", { each: { key: "x", value: "y" } }))).toBe("<ref:aws_cloudwatch_log_group.audit_anchor_publisher.name>");
    }
  });
});
