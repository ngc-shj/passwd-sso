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

import { handleServerNotice, registerBypassNoticeSink, resetBypassNoticeRateLimit } from "@/lib/db/pool-factory";

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
      where: "PL/pgSQL function rls_bypass_admits(text) line 17 at RAISE",
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
        where: "PL/pgSQL function rls_bypass_admits(text) line 17 at RAISE",
      }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain("earlier-request");
    // The unparsed path logs through the same base logger.
    requestContext.run(base.child({ requestId: "earlier-request" }), () =>
      handleServerNotice({
        code: "01000",
        message: "rls_bypass_not_granted tbl=users",
        where: "PL/pgSQL function rls_bypass_admits(text) line 17 at RAISE",
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
      where: "PL/pgSQL function rls_bypass_admits(text) line 17 at RAISE",
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
