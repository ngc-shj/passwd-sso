/**
 * The request log lines against the CloudWatch metric filters that count them
 * (5xx, health-check failure, high latency). Both sides come from the real
 * sources: lines from withRequestLog through the logger's real options, and
 * patterns parsed out of infra/terraform/monitoring.tf. A filter keyed on a
 * field the logger does not emit (these once matched `_logType = "app"`, which
 * moved to `_stream`) then fails here instead of counting nothing in
 * production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { NextRequest } from "next/server";

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

// src/__tests__/setup.ts replaces withRequestLog with a passthrough; this file
// needs the real wrapper, as with-request-log.test.ts does.
vi.unmock("@/lib/http/with-request-log");

import { withRequestLog } from "@/lib/http/with-request-log";

const TF = readFileSync(resolve(__dirname, "../../../infra/terraform/monitoring.tf"), "utf8");
const VARIABLES = readFileSync(resolve(__dirname, "../../../infra/terraform/variables.tf"), "utf8");

/** The pattern of a metric filter resource, with `${var.x}` replaced by its default. */
function patternOf(resource: string): string {
  const start = TF.indexOf(`resource "aws_cloudwatch_log_metric_filter" "${resource}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = TF.slice(start, TF.indexOf("\n}\n", start));
  const raw = /pattern\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  expect(raw).toBeDefined();
  return (raw as string).replace(/\\"/g, '"').replace(/\$\{var\.(\w+)\}/g, (_m, name: string) => {
    const def = new RegExp(`variable "${name}" \\{[^}]*?default\\s*=\\s*([^\\s]+)`).exec(VARIABLES)?.[1];
    expect(def, `default for var.${name}`).toBeDefined();
    return def as string;
  });
}

/**
 * Whether a JSON log line matches a CloudWatch filter pattern of the form
 * `{ $.a = "x" && $.b >= 500 }`, the only form these filters use. A term this
 * evaluator cannot read throws, so an unsupported pattern fails loudly rather
 * than reading as "no match".
 */
function matches(pattern: string, line: Record<string, unknown>): boolean {
  const body = /^\{\s*(.*?)\s*\}$/.exec(pattern)?.[1];
  if (body === undefined) throw new Error(`unsupported pattern: ${pattern}`);
  return body.split("&&").every((term) => {
    const m = /^\s*\$\.(\w+)\s*(=|>=|<=|>|<|!=)\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?))\s*$/.exec(term);
    if (!m) throw new Error(`unsupported term: ${term}`);
    const [, key, op, str, num] = m;
    const actual = line[key];
    if (str !== undefined) return op === "=" ? actual === str : op === "!=" ? actual !== str : false;
    if (typeof actual !== "number") return false;
    const n = Number(num);
    return { "=": actual === n, "!=": actual !== n, ">=": actual >= n, "<=": actual <= n, ">": actual > n, "<": actual < n }[op] as boolean;
  });
}

/** The request.end line withRequestLog writes for one request. */
async function requestEndLine(path: string, status: number, durationMs = 1): Promise<Record<string, unknown>> {
  chunks.length = 0;
  const now = vi.spyOn(performance, "now");
  now.mockReturnValueOnce(0).mockReturnValueOnce(durationMs);
  try {
    const handler = withRequestLog(async (_req: NextRequest) => new Response(null, { status }));
    await handler(new NextRequest(`https://app.example${path}`));
  } finally {
    now.mockRestore();
  }
  const end = chunks.map((c) => JSON.parse(c) as Record<string, unknown>).find((l) => l.msg === "request.end");
  expect(end).toBeDefined();
  return end as Record<string, unknown>;
}

describe("request metric filters vs the request log line", () => {
  beforeEach(() => {
    chunks.length = 0;
  });

  it("counts a 5xx response and not a 2xx one", async () => {
    const p = patternOf("app_5xx");
    expect(matches(p, await requestEndLine("/api/passwords", 500))).toBe(true);
    expect(matches(p, await requestEndLine("/api/passwords", 200))).toBe(false);
  });

  it("counts a 503 from the readiness probe and not from another path", async () => {
    const p = patternOf("health_check_failures");
    expect(matches(p, await requestEndLine("/api/health/ready", 503))).toBe(true);
    expect(matches(p, await requestEndLine("/api/passwords", 503))).toBe(false);
  });

  it("counts a request at the latency threshold and not one below it", async () => {
    const p = patternOf("high_latency");
    const threshold = Number(/durationMs >= (\d+)/.exec(p)?.[1]);
    expect(threshold).toBeGreaterThan(0);
    expect(matches(p, await requestEndLine("/api/passwords", 200, threshold))).toBe(true);
    expect(matches(p, await requestEndLine("/api/passwords", 200, threshold - 1))).toBe(false);
  });
});
