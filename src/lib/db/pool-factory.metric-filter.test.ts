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
  return { ...actual, getLogger: () => logger };
});

import { handleServerNotice, registerBypassNoticeSink, resetBypassNoticeRateLimit } from "@/lib/db/pool-factory";

const TF = readFileSync(resolve(__dirname, "../../../infra/terraform/monitoring.tf"), "utf8");

/** The `rls_bypass_not_granted` metric filter resource block. */
function filterBlock(): string {
  const start = TF.indexOf('resource "aws_cloudwatch_log_metric_filter" "rls_bypass_not_granted"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = TF.indexOf("\n}\n", start);
  return TF.slice(start, end);
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
    });
  });
});
