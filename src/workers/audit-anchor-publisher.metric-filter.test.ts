/**
 * The publisher's log lines against the CloudWatch metric filters that count
 * them (infra/terraform/monitoring.tf). Lines come from the real publisher and
 * scheduler through the logger's real options, driven into each outcome over a
 * fake database and in-memory destinations holding real signed objects;
 * patterns are read from the Terraform configuration as it renders them. Each
 * filter must match the line its path really emits and
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
  AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP,
  AuditAnchorPublisher,
  PUBLISHER_AUDIT_DEAD_LETTER_REASON,
  SETTING_UPLOAD_ATTEMPTS,
  createPublisher,
  type PublisherConfig,
} from "./audit-anchor-publisher";
import { createAnchorScheduler } from "./audit-anchor-scheduler";
import { InMemoryDestination } from "@/lib/audit/anchor-destinations/in-memory-destination";
import { buildManifestArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { publicKeyForSigningKey } from "@/lib/audit/anchor-manifest";
import { AUDIT_ANCHOR_CADENCE_MS, AUDIT_ANCHOR_PUBLISH_OFFSET_MS } from "@/lib/constants/audit/audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import {
  archivePublicKey,
  kidOf,
  signedManifest,
  storeArtifact,
  storeManifest,
  trackDestination,
} from "@/__tests__/helpers/anchor-manifest-fixtures";

const BOUNDARY = new Date("2026-01-15T00:05:00.000Z");
const PREV_BOUNDARY = new Date(BOUNDARY.getTime() - AUDIT_ANCHOR_CADENCE_MS);
const NEXT_BOUNDARY = new Date(BOUNDARY.getTime() + AUDIT_ANCHOR_CADENCE_MS);
/** A wall clock an hour into `boundary`. */
const clockInto = (boundary: Date) => () => boundary.getTime() + MS_PER_HOUR;
const TENANT = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "11111111-2222-4333-8444-555555555555";
const SIGNING_KEY = randomBytes(32);
const TAG_SECRET = randomBytes(32);
const OTHER_KEY = randomBytes(32);

// ─── A fake database, just enough for each outcome ─────────────────────────

type Db = {
  enabled: string[];
  anchors: string[];
  /** MAX(last_published_at) over the anchor rows. */
  highWater: Date | null;
  settings: Map<string, string>;
  lockTimeoutOnCall?: number;
  failPauseWrite?: boolean;
  failOutbox?: boolean;
  lockCalls: number;
};

function makeDb(overrides: Partial<Db> = {}): Db {
  return { enabled: [TENANT], anchors: [TENANT], highWater: null, settings: new Map(), lockCalls: 0, ...overrides };
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
    $queryRaw: async () => [{ max_published: db.highWater }],
    tenant: { findMany: async () => db.enabled.map((id) => ({ id })) },
    auditChainAnchor: {
      findFirst: async () => (db.anchors[0] ? { tenantId: db.anchors[0] } : null),
      findMany: async (args: { where?: unknown }) =>
        db.anchors
          .filter((id) => args.where === undefined || db.enabled.includes(id))
          .map((tenantId) => ({ tenantId, chainSeq: 1n, prevHash: Buffer.alloc(32, 1), epoch: 1 })),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        if (args.data.publishPausedUntil instanceof Date) {
          if (db.failPauseWrite) throw new Error("pause write failed");
        } else if (args.data.lastPublishedAt instanceof Date) {
          db.highWater = args.data.lastPublishedAt;
        }
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

// ─── Destinations: the stateful in-memory one, holding real signed objects ──

const PRIMARY_NAME = "s3-object-lock";

/** A primary with the publisher's own public key archived. */
async function primary(): Promise<InMemoryDestination> {
  const dest = new InMemoryDestination(PRIMARY_NAME);
  await archivePublicKey(dest, publicKeyForSigningKey(SIGNING_KEY));
  return dest;
}

/** A manifest this publisher's identity would have published for `boundary`. */
function ours(boundary: Date) {
  return signedManifest({ signingKey: SIGNING_KEY, boundary, deploymentId: DEPLOYMENT_ID, tagSecret: TAG_SECRET });
}

async function primaryHolding(...planted: Array<ReturnType<typeof signedManifest>>): Promise<InMemoryDestination> {
  const dest = await primary();
  for (const manifest of planted) await storeManifest(dest, manifest);
  return dest;
}

const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "AccessDenied" }));

function config(overrides: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    deploymentId: DEPLOYMENT_ID,
    signingKey: SIGNING_KEY,
    tagSecret: TAG_SECRET,
    destinations: [new InMemoryDestination(PRIMARY_NAME)],
    cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
    publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
    now: clockInto(BOUNDARY),
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

/** Scenario name → the lines it logged. Filled once, before the cases. */
const lines: Record<string, Record<string, unknown>[]> = {};

/** The fail-closed rows of the decision table, and the diverged mirror: all on the cadence_failed alarm path. */
const FAIL_CLOSED_SCENARIOS = [
  "row_a_read_failed",
  "row_b_unverifiable",
  "row_c_object_ahead",
  "row_d1_last_published_ahead",
  "row_d2_destination_behind",
  "row_e_retired_key",
  "mirror_diverged",
];

beforeAll(async () => {
  const failingUpload = { destinations: [trackDestination(await primary(), { create: denied }).dest] };

  lines.published = await cadence(makeDb(), { destinations: [await primary()] });
  // The boundary's own object is stored and the database never recorded it.
  lines.adopted = await cadence(makeDb(), { destinations: [await primaryHolding(ours(BOUNDARY))] });
  lines.never_enabled = await cadence(makeDb({ enabled: [], anchors: [] }));
  lines.disabled_after_enabled = await cadence(makeDb({ enabled: [], anchors: [TENANT] }));
  lines.already_published = await cadence(makeDb({ highWater: new Date(clockInto(BOUNDARY)()) }), {
    destinations: [await primaryHolding(ours(BOUNDARY))],
  });
  // Stale and ahead come from what the destination holds: the same object,
  // read by a clock that has reached its date and by one that has not.
  lines.stale_object = await cadence(makeDb({ highWater: new Date(clockInto(NEXT_BOUNDARY)()) }), {
    destinations: [await primaryHolding(ours(NEXT_BOUNDARY))],
    now: clockInto(NEXT_BOUNDARY),
  });
  lines.row_c_object_ahead = await cadence(makeDb(), { destinations: [await primaryHolding(ours(NEXT_BOUNDARY))] });
  lines.other_identity = await cadence(makeDb(), {
    destinations: [
      await primaryHolding(
        signedManifest({ signingKey: SIGNING_KEY, boundary: BOUNDARY, deploymentId: "another-deployment" }),
      ),
    ],
  });
  lines.row_a_read_failed = await cadence(makeDb(), { destinations: [trackDestination(await primary(), { list: denied }).dest] });
  const garbage = await primary();
  await storeArtifact(garbage, buildManifestArtifactKey(PREV_BOUNDARY, kidOf(SIGNING_KEY)), Buffer.from("garbage"));
  lines.row_b_unverifiable = await cadence(makeDb(), { destinations: [garbage] });
  lines.row_d1_last_published_ahead = await cadence(makeDb({ highWater: NEXT_BOUNDARY }), {
    destinations: [await primaryHolding(ours(BOUNDARY))],
  });
  lines.row_d2_destination_behind = await cadence(makeDb({ highWater: BOUNDARY }), { destinations: [await primary()] });
  const retired = await primaryHolding(
    ours(new Date(PREV_BOUNDARY.getTime() - AUDIT_ANCHOR_CADENCE_MS)),
    signedManifest({ signingKey: OTHER_KEY, boundary: PREV_BOUNDARY }),
  );
  await archivePublicKey(retired, publicKeyForSigningKey(OTHER_KEY));
  lines.row_e_retired_key = await cadence(makeDb(), { destinations: [retired] });
  const divergedMirror = new InMemoryDestination("filesystem");
  await storeArtifact(divergedMirror, buildManifestArtifactKey(BOUNDARY, kidOf(SIGNING_KEY)), Buffer.from("other bytes"));
  lines.mirror_diverged = await cadence(makeDb(), { destinations: [await primary(), divergedMirror] });
  lines.upload_failed = await cadence(makeDb(), failingUpload);
  lines.cap_reached = await cadence(makeDb({ settings: new Map([[ATTEMPTS, JSON.stringify({ boundary: BOUNDARY.toISOString(), count: AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP })]]) }));
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
      cadenceMs: AUDIT_ANCHOR_CADENCE_MS,
      publishOffsetMs: AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
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
    const cadenceLine = (name: string) => lines[name].filter((l) => l._logType === "audit-anchor-publisher.cadence");
    const kinds = (name: string) => cadenceLine(name).map((l) => l.kind);
    expect(cadenceLine("published")).toEqual([expect.objectContaining({ kind: "published", adopted: false })]);
    expect(cadenceLine("adopted")).toEqual([expect.objectContaining({ kind: "published", adopted: true })]);
    expect(kinds("never_enabled")).toEqual(["skipped_no_tenants"]);
    expect(kinds("disabled_after_enabled")).toEqual(["skipped_no_tenants"]);
    expect(kinds("already_published")).toEqual(["skipped_already_published"]);
    expect(kinds("stale_object")).toEqual(["skipped_already_published"]);
    expect(lines.stale_object.map((l) => l._logType)).toContain("audit-anchor-publisher.stale_boundary");
    expect(kinds("other_identity")).toEqual(["skipped_already_published"]);
    expect(lines.other_identity.map((l) => l._logType)).toContain("audit-anchor-publisher.published_by_other_identity");
    expect(Object.fromEntries(FAIL_CLOSED_SCENARIOS.map((name) => [name, cadenceLine(name).map((l) => [l.kind, l.reason])]))).toEqual({
      row_a_read_failed: [["failed", "s3-object-lock_READ_FAILED:AccessDenied"]],
      row_b_unverifiable: [["failed", "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE"]],
      row_c_object_ahead: [["failed", "CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD"]],
      row_d1_last_published_ahead: [["failed", "CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK"]],
      row_d2_destination_behind: [["failed", "CADENCE_FAILED:DESTINATION_BEHIND_DATABASE"]],
      row_e_retired_key: [["failed", "CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY"]],
      mirror_diverged: [["failed", "filesystem_MIRROR_DIVERGED"]],
    });
    expect(kinds("upload_failed")).toEqual(["failed"]);
    expect(kinds("cap_reached")).toEqual(["upload_cap_reached"]);
    expect(kinds("lock_held")).toEqual(["lock_held"]);
    expect(kinds("commit_failed")).toEqual(["failed"]);
  });

  it("counts a healthy boundary only for published, adopted and never-enabled skipped_no_tenants", () => {
    expect(matchingScenarios(pattern("audit_anchor_cadence_healthy"))).toEqual(["adopted", "never_enabled", "published"]);
  });

  it("counts exactly one healthy line per healthy boundary", () => {
    const p = pattern("audit_anchor_cadence_healthy");
    expect(lines.published.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
    expect(lines.adopted.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
    expect(lines.never_enabled.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
  });

  it.each(FAIL_CLOSED_SCENARIOS)("puts %s on the cadence_failed alarm path and on no other failure filter", (name) => {
    const matching = Object.entries(FAILURE_LOG_TYPES)
      .filter(([key, value]) => {
        const p = pattern("audit_anchor_publisher_failure", { key, value });
        return lines[name].some((l) => matchesFilterPattern(p, l));
      })
      .map(([key]) => key);
    expect(matching).toEqual(["cadence_failed"]);
    expect(lines[name].some((l) => matchesFilterPattern(pattern("audit_anchor_cadence_healthy"), l))).toBe(false);
  });

  it("raises the falls-to-zero filter only for skipped_no_tenants with everChainEnabled true", () => {
    expect(matchingScenarios(pattern("audit_anchor_chain_enabled_fell_to_zero"))).toEqual(["disabled_after_enabled"]);
  });

  it("raises the falls-to-zero filter when the count goes from 1 to 0", async () => {
    const p = pattern("audit_anchor_chain_enabled_fell_to_zero");
    const db = makeDb();
    const dest = new InMemoryDestination(PRIMARY_NAME);
    const before = await linesOf(() =>
      new AuditAnchorPublisher({ prisma: fakePrisma(db), config: config({ destinations: [dest] }) }).runCadence(BOUNDARY),
    );
    expect(before.find((l) => l._logType === "audit-anchor-publisher.cadence")?.chainEnabledTenantCount).toBe(1);
    expect(before.some((l) => matchesFilterPattern(p, l))).toBe(false);
    db.enabled = [];
    const after = await linesOf(() =>
      new AuditAnchorPublisher({
        prisma: fakePrisma(db),
        config: config({ destinations: [dest], now: clockInto(NEXT_BOUNDARY) }),
      }).runCadence(NEXT_BOUNDARY),
    );
    expect(after.filter((l) => matchesFilterPattern(p, l))).toHaveLength(1);
  });

  const expectedScenarios: Record<string, string[]> = {
    cadence_failed: [...FAIL_CLOSED_SCENARIOS, "commit_failed", "pause_persist_failed", "upload_failed"].sort(),
    lock_held: ["lock_held"],
    stale_boundary: ["stale_object"],
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
