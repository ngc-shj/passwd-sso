/**
 * The production report line against the CloudWatch metric filter that counts
 * it (E5). Both sides are read from the real sources — the logger's options and
 * `infra/terraform/monitoring.tf` — so a renamed `_logType`, a base field that
 * duplicates the key, or a filter dropped from a log group fails here rather
 * than as a metric that silently stays at 0.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import logger from "@/lib/logger";

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
  return { ...actual, default: logger, getLogger: () => actual.requestContext.getStore() ?? logger };
});

import { matchesFilterPattern } from "@/__tests__/helpers/cloudwatch-filter-pattern";
import { TerraformConfig, TERRAFORM_DIR, nested, plain } from "@/__tests__/helpers/hcl-subset";
import {
  handleServerError,
  handleServerNotice,
  registerBypassNoticeSink,
  resetBypassNoticeRateLimit,
  stderrBypassNoticeSink,
} from "@/lib/db/pool-factory";

const TF = readFileSync(resolve(__dirname, "../../../infra/terraform/monitoring.tf"), "utf8");

/** A metric filter resource block, by resource name. */
function filterBlock(name = "rls_bypass_not_granted"): string {
  const start = TF.indexOf(`resource "aws_cloudwatch_log_metric_filter" "${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = TF.indexOf("\n}\n", start);
  return TF.slice(start, end);
}

/** The metric_transformation's name and namespace in a block. */
function metricOf(block: string): { name?: string; namespace?: string } {
  // Up to the block's own closing brace: values like "${local.name_prefix}/App"
  // contain braces of their own.
  const t = /metric_transformation \{\n([\s\S]*?)\n {2}\}/.exec(block)?.[1] ?? "";
  return {
    name: /\bname\s*=\s*"([^"]+)"/.exec(t)?.[1],
    namespace: /\bnamespace\s*=\s*"([^"]+)"/.exec(t)?.[1],
  };
}

/** The alarm block on the report metric. */
function alarmBlock(): string {
  const start = TF.indexOf('resource "aws_cloudwatch_metric_alarm" "rls_bypass_not_granted"');
  expect(start).toBeGreaterThanOrEqual(0);
  return TF.slice(start, TF.indexOf("\n}\n", start));
}

describe("rls.bypass_not_granted line vs its metric filter", () => {
  let line: string;

  beforeAll(() => {
    registerBypassNoticeSink(null);
    resetBypassNoticeRateLimit();
    handleServerNotice({
      code: "01000",
      message: "rls_bypass_not_granted table=sessions purpose=auth_flow",
      where: "PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE",
    });
    expect(chunks).toHaveLength(1);
    line = chunks[0];
  });

  it("carries _logType exactly once on the raw line", () => {
    expect(line.match(/"_logType"/g)).toHaveLength(1);
  });

  it("matches the filter pattern in monitoring.tf", () => {
    const pattern = /pattern\s*=\s*"\{ \$\.(\w+) = \\"([^"\\]+)\\" \}"/.exec(filterBlock());
    expect(pattern).not.toBeNull();
    const [, key, value] = pattern as RegExpExecArray;
    expect(JSON.parse(line)[key]).toBe(value);
  });

  it("does not stamp the report with the request context the notice arrives in", async () => {
    // A pooled socket's notice runs in the context of the request that opened
    // the connection, not the one whose statement was reported.
    const { requestContext, default: base } = await import("@/lib/logger");
    chunks.length = 0;
    resetBypassNoticeRateLimit();
    requestContext.run(base.child({ requestId: "earlier-request" }), () =>
      handleServerNotice({
        code: "01000",
        message: "rls_bypass_not_granted table=users purpose=auth_flow",
        where: "PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE",
      }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain("earlier-request");
    // The unparsed path logs through the same base logger.
    requestContext.run(base.child({ requestId: "earlier-request" }), () =>
      handleServerNotice({
        code: "01000",
        message: "rls_bypass_not_granted tbl=users",
        where: "PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE",
      }),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain("rls.bypass_notice_unparsed");
    expect(chunks[1]).not.toContain("earlier-request");
  });

  it("counts an unparsed report on the same metric, so a format drift is not read as zero", () => {
    chunks.length = 0;
    resetBypassNoticeRateLimit();
    handleServerNotice({
      code: "01000",
      message: "rls_bypass_not_granted tbl=users",
      where: "PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE",
    });
    expect(chunks).toHaveLength(1);
    const block = filterBlock("rls_bypass_notice_unparsed");
    const pattern = /pattern\s*=\s*"\{ \$\.(\w+) = \\"([^"\\]+)\\" \}"/.exec(block);
    expect(pattern).not.toBeNull();
    const [, key, value] = pattern as RegExpExecArray;
    expect(JSON.parse(chunks[0])[key]).toBe(value);
    expect(block).toMatch(/for_each\s*=\s*var\.enable_monitoring \? local\.rls_bypass_report_log_groups : \{\}/);
    expect(block).toMatch(/log_group_name\s*=\s*each\.value/);
  });

  it("publishes both filters to the metric the alarm watches", () => {
    const alarm = alarmBlock();
    const alarmMetric = {
      name: /metric_name\s*=\s*"([^"]+)"/.exec(alarm)?.[1],
      namespace: /namespace\s*=\s*"([^"]+)"/.exec(alarm)?.[1],
    };
    expect(alarmMetric.name).toBeDefined();
    expect(alarmMetric.namespace).toBeDefined();
    expect(metricOf(filterBlock())).toEqual(alarmMetric);
    expect(metricOf(filterBlock("rls_bypass_notice_unparsed"))).toEqual(alarmMetric);
  });

  it("binds one filter to each service log group that can emit the line", () => {
    expect(filterBlock()).toMatch(/for_each\s*=\s*var\.enable_monitoring \? local\.rls_bypass_report_log_groups : \{\}/);
    expect(filterBlock()).toMatch(/log_group_name\s*=\s*each\.value/);
    const groups = /rls_bypass_report_log_groups = \{([^}]*)\}/.exec(TF);
    expect(groups).not.toBeNull();
    const entries = Object.fromEntries(
      [...(groups as RegExpExecArray)[1].matchAll(/(\w+)\s*=\s*([\w.]+)/g)].map((m) => [m[1], m[2]]),
    );
    expect(entries).toEqual({
      app: "aws_cloudwatch_log_group.app.name",
      audit_outbox_worker: "aws_cloudwatch_log_group.audit_outbox_worker.name",
      retention_gc_worker: "aws_cloudwatch_log_group.retention_gc_worker.name",
      audit_anchor_publisher: "aws_cloudwatch_log_group.audit_anchor_publisher.name",
      audit_chain_verify_worker: "aws_cloudwatch_log_group.audit_chain_verify_worker.name",
    });
  });
});

const tf = new TerraformConfig(TERRAFORM_DIR);

function filterPattern(name: string): string {
  return String(tf.attr(tf.resource("aws_cloudwatch_log_metric_filter", name), "pattern"));
}

const REFUSAL = {
  code: "42501",
  message: "RLS_BYPASS_NOT_GRANTED: sessions",
  hint: "bypass purpose auth_flow",
  where: "PL/pgSQL function public.rls_bypass_admits(text) line 21 at RAISE",
};

describe("rls.bypass_refused line vs its metric filter", () => {
  const pattern = filterPattern("rls_bypass_refused");

  /** The refusal as the stderr sink writes it. */
  function stderrLine(error: Parameters<typeof handleServerError>[0], warning = false): string {
    registerBypassNoticeSink(stderrBypassNoticeSink);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      if (warning) {
        handleServerNotice({ code: "01000", message: "rls_bypass_not_granted table=sessions purpose=auth_flow", where: REFUSAL.where });
      } else {
        handleServerError(error);
      }
      expect(write).toHaveBeenCalledTimes(1);
      return String(write.mock.calls[0][0]);
    } finally {
      write.mockRestore();
      registerBypassNoticeSink(null);
    }
  }

  function productionLine(emit: () => void): string {
    registerBypassNoticeSink(null);
    resetBypassNoticeRateLimit();
    chunks.length = 0;
    emit();
    expect(chunks).toHaveLength(1);
    return chunks[0];
  }

  it("matches the line the production sink writes for a refusal", () => {
    const line = productionLine(() => handleServerError(REFUSAL));
    expect(line.match(/"_logType"/g)).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ _logType: "rls.bypass_refused", table: "sessions", purpose: "auth_flow" });
    expect(matchesFilterPattern(pattern, JSON.parse(line))).toBe(true);
  });

  it("matches the line the stderr sink writes for a refusal", () => {
    expect(matchesFilterPattern(pattern, JSON.parse(stderrLine(REFUSAL)))).toBe(true);
  });

  it("does not match the warning line, from either sink", () => {
    const line = productionLine(() =>
      handleServerNotice({ code: "01000", message: "rls_bypass_not_granted table=sessions purpose=auth_flow", where: REFUSAL.where }),
    );
    expect(JSON.parse(line)._logType).toBe("rls.bypass_not_granted");
    expect(matchesFilterPattern(pattern, JSON.parse(line))).toBe(false);
    expect(matchesFilterPattern(pattern, JSON.parse(stderrLine(REFUSAL, true)))).toBe(false);
  });

  it("does not match the unparsed line", () => {
    const line = productionLine(() => handleServerError({ ...REFUSAL, hint: undefined }));
    expect(JSON.parse(line)._logType).toBe("rls.bypass_notice_unparsed");
    expect(matchesFilterPattern(pattern, JSON.parse(line))).toBe(false);
  });

  it("is not counted by the warning filter, so each kind is counted by one filter", () => {
    const refusalLine = JSON.parse(productionLine(() => handleServerError(REFUSAL)));
    expect(matchesFilterPattern(filterPattern("rls_bypass_not_granted"), refusalLine)).toBe(false);
  });

  it("publishes to the metric the alarm watches", () => {
    const alarm = tf.resource("aws_cloudwatch_metric_alarm", "rls_bypass_not_granted");
    const filter = tf.resource("aws_cloudwatch_log_metric_filter", "rls_bypass_refused");
    const [transformation] = nested(filter, "metric_transformation");
    expect({ name: tf.attr(transformation, "name"), namespace: tf.attr(transformation, "namespace") }).toEqual({
      name: tf.attr(alarm, "metric_name"),
      namespace: tf.attr(alarm, "namespace"),
    });
  });

  it("iterates the five service log groups, one filter each", () => {
    const filter = tf.resource("aws_cloudwatch_log_metric_filter", "rls_bypass_refused");
    const groups = tf.local("rls_bypass_report_log_groups");
    expect(Object.keys(groups as object)).toHaveLength(5);
    expect(plain(tf.attr(filter, "for_each", { vars: { enable_monitoring: true } }))).toEqual(plain(groups));
    expect(tf.attr(filter, "for_each", { vars: { enable_monitoring: false } })).toEqual({});
    const each = { key: "app", value: (groups as Record<string, unknown>).app };
    expect(String(tf.attr(filter, "log_group_name", { each }))).toBe(String(each.value));
  });
});

describe("report lines under a LOG_LEVEL above warn", () => {
  // LOG_LEVEL is a task-definition variable; "error" and "fatal" are the env
  // schema's values above warn, and pino's "silent" takes the same path. Each
  // would drop a warn line without throwing.
  /** The stderr lines `emit` wrote at `level`; nothing may also go through the logger. */
  function stderrLines(level: string, emit: () => void): string[] {
    registerBypassNoticeSink(null);
    resetBypassNoticeRateLimit();
    chunks.length = 0;
    const previous = logger.level;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      logger.level = level;
      emit();
      if (level !== "warn") expect(chunks).toEqual([]);
      return write.mock.calls.map((c) => String(c[0]));
    } finally {
      write.mockRestore();
      logger.level = previous;
    }
  }

  it.each(["error", "fatal", "silent"])("writes each kind to stderr, matched by its filter, at %s", (level) => {
    const refusal = stderrLines(level, () => handleServerError(REFUSAL));
    const warning = stderrLines(level, () =>
      handleServerNotice({ code: "01000", message: "rls_bypass_not_granted table=sessions purpose=auth_flow", where: REFUSAL.where }),
    );
    const unparsed = stderrLines(level, () => handleServerError({ ...REFUSAL, hint: undefined }));
    for (const [lines, filter] of [
      [refusal, "rls_bypass_refused"],
      [warning, "rls_bypass_not_granted"],
      [unparsed, "rls_bypass_notice_unparsed"],
    ] as const) {
      expect(lines).toHaveLength(1);
      expect(matchesFilterPattern(filterPattern(filter), JSON.parse(lines[0]))).toBe(true);
    }
    expect(JSON.parse(refusal[0])).toEqual({ _logType: "rls.bypass_refused", table: "sessions", purpose: "auth_flow" });
  });

  it("logs through the logger, not stderr, at warn", () => {
    expect(stderrLines("warn", () => handleServerError(REFUSAL))).toEqual([]);
    expect(chunks).toHaveLength(1);
  });
});
