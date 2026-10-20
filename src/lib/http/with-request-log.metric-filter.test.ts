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
 * Whether a JSON log line matches a CloudWatch filter pattern built from
 * `$.key <op> value` terms joined by `&&` / `||` and grouped by parentheses —
 * the only forms these filters use. Anything else throws, so an unsupported
 * pattern fails loudly rather than reading as "no match".
 */
function matches(pattern: string, line: Record<string, unknown>): boolean {
  const body = /^\{\s*(.*?)\s*\}$/.exec(pattern)?.[1];
  if (body === undefined) throw new Error(`unsupported pattern: ${pattern}`);
  const tokens = body.match(/\(|\)|&&|\|\||\$\.\w+\s*(?:=|!=|>=|<=|>|<)\s*(?:"[^"]*"|-?\d+(?:\.\d+)?)/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== body.replace(/\s/g, "")) throw new Error(`unsupported pattern: ${pattern}`);
  let i = 0;
  const term = (t: string): boolean => {
    const m = /^\$\.(\w+)\s*(=|!=|>=|<=|>|<)\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?))$/.exec(t);
    if (!m) throw new Error(`unsupported term: ${t}`);
    const [, key, op, str, num] = m;
    const actual = line[key];
    if (str !== undefined) return op === "=" ? actual === str : op === "!=" ? actual !== str : false;
    if (typeof actual !== "number") return false;
    const n = Number(num);
    return { "=": actual === n, "!=": actual !== n, ">=": actual >= n, "<=": actual <= n, ">": actual > n, "<": actual < n }[op] as boolean;
  };
  const primary = (): boolean => {
    const t = tokens[i++];
    if (t === "(") {
      const v = or();
      if (tokens[i++] !== ")") throw new Error(`unbalanced pattern: ${pattern}`);
      return v;
    }
    if (t === undefined) throw new Error(`truncated pattern: ${pattern}`);
    return term(t);
  };
  const and = (): boolean => {
    let v = primary();
    while (tokens[i] === "&&") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  function or(): boolean {
    let v = and();
    while (tokens[i] === "||") {
      i++;
      v = and() || v;
    }
    return v;
  }
  const result = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in pattern: ${pattern}`);
  return result;
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

/** The request.error line withRequestLog writes when the handler throws. */
async function requestErrorLine(path: string): Promise<Record<string, unknown>> {
  chunks.length = 0;
  const handler = withRequestLog(async (_req: NextRequest): Promise<Response> => {
    throw new Error("boom");
  });
  await expect(handler(new NextRequest(`https://app.example${path}`))).rejects.toThrow("boom");
  const line = chunks.map((c) => JSON.parse(c) as Record<string, unknown>).find((l) => l.msg === "request.error");
  expect(line).toBeDefined();
  return line as Record<string, unknown>;
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

  it("counts an unhandled throw, which Next answers with 500", async () => {
    // request.error carries no status; without its own arm the filter missed
    // exactly the unexpected-bug 5xx.
    expect(matches(patternOf("app_5xx"), await requestErrorLine("/api/passwords"))).toBe(true);
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
