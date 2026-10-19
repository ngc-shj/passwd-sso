import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  createClient,
  createPool,
  handleServerNotice,
  productionBypassNoticeSink,
  registerBypassNoticeSink,
  resetBypassNoticeRateLimit,
  stderrBypassNoticeSink,
  type BypassNotice,
} from "@/lib/db/pool-factory";

const WHERE = "PL/pgSQL function rls_bypass_admits(text) line 17 at RAISE";
const report = (message: string, where = WHERE, severity = "WARNING") => ({ severity, message, where });

beforeEach(() => {
  mockWarn.mockReset();
  resetBypassNoticeRateLimit();
  registerBypassNoticeSink(null);
});

afterEach(() => {
  registerBypassNoticeSink(null);
  vi.unstubAllEnvs();
});

describe("handleServerNotice", () => {
  it("routes a report from rls_bypass_admits to the registered sink", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(report("rls_bypass_not_granted table=password_entries purpose=auth_flow"));
    expect(seen).toEqual([{ table: "password_entries", purpose: "auth_flow" }]);
  });

  it("accepts a table name with digits and the invalid-purpose marker", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(report("rls_bypass_not_granted table=oauth2_grants purpose=<invalid>"));
    expect(seen).toEqual([{ table: "oauth2_grants", purpose: "<invalid>" }]);
  });

  it("logs to the production sink when nothing is registered", () => {
    handleServerNotice(report("rls_bypass_not_granted table=sessions purpose=token_lifecycle"));
    expect(mockWarn).toHaveBeenCalledWith(
      { _logType: "rls.bypass_not_granted", table: "sessions", purpose: "token_lifecycle" },
      "rls.bypass_not_granted",
    );
  });

  it.each([
    ["a notice below WARNING", report("rls_bypass_not_granted table=sessions purpose=x", WHERE, "LOG")],
    ["a WARNING from another function", report("rls_bypass_not_granted table=sessions purpose=x", "PL/pgSQL function other_fn(text) line 1 at RAISE")],
    ["a WARNING with no source", { severity: "WARNING", message: "rls_bypass_not_granted table=sessions purpose=x" }],
    ["statement logging carrying a secret", report("statement: SELECT 'secret-param-value'", "", "LOG")],
  ])("drops %s without logging any part of it", (_label, notice) => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(notice);
    expect(seen).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs a constant line, with no content, for a report from the function that does not parse", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(report("rls_bypass_not_granted table=sessions purpose=x\nsecret-value"));
    expect(seen).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith({ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed");
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret-value");
  });
});

describe("productionBypassNoticeSink", () => {
  it("logs one line per (table, purpose) per window", () => {
    productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ table: "users", purpose: "auth_flow" });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("keeps its rate-limit map bounded under many distinct pairs", () => {
    for (let i = 0; i < 1_500; i++) productionBypassNoticeSink({ table: `t${i}`, purpose: "p" });
    expect(mockWarn).toHaveBeenCalledTimes(1_500);
    mockWarn.mockReset();
    // The earliest pairs were evicted, so they log again.
    productionBypassNoticeSink({ table: "t0", purpose: "p" });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe("stderrBypassNoticeSink", () => {
  it("writes the report as a JSON line to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stderrBypassNoticeSink({ table: "users", purpose: "system_maintenance" });
    expect(write).toHaveBeenCalledWith('{"_logType":"rls.bypass_not_granted","table":"users","purpose":"system_maintenance"}\n');
    write.mockRestore();
  });
});

describe("createPool / createClient refuse to silence the reports", () => {
  it.each([
    ["the config's options", { options: "-c client_min_messages=error" }],
    ["the connection string's options", { connectionString: "postgresql://u:p@localhost:5432/db?options=-c%20client_min_messages%3Derror" }],
  ])("rejects client_min_messages in %s", (_label, config) => {
    expect(() => createPool(config)).toThrow("must not set client_min_messages");
    expect(() => createClient(config)).toThrow("must not set client_min_messages");
  });

  it("rejects client_min_messages in PGOPTIONS", () => {
    vi.stubEnv("PGOPTIONS", "-c client_min_messages=error");
    expect(() => createPool({ connectionString: "postgresql://u:p@localhost:5432/db" })).toThrow("must not set client_min_messages");
  });

  it("accepts other options", async () => {
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db", options: "-c statement_timeout=5000" });
    await pool.end();
  });
});
