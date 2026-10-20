import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type pg from "pg";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => {
  const logger = { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: logger, getLogger: () => logger };
});

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
// A plain RAISE WARNING carries SQLSTATE 01000; LOG-level messages carry 00000.
const report = (message: string, where = WHERE, code = "01000") => ({ severity: "WARNING", code, message, where });

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

  it("accepts a report whose severity and context line are localized", () => {
    // Under lc_messages=ja_JP the S field and the context line are translated;
    // the SQLSTATE, the function name and the function's own text are not.
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    // As pg-protocol builds it: `severity` is set from the localized S field.
    const localized = {
      severity: "警告",
      code: "01000",
      message: "rls_bypass_not_granted table=sessions purpose=auth_flow",
      where: "PL/pgSQL関数rls_bypass_admits(text)の17行目 - RAISE",
    };
    handleServerNotice(localized);
    expect(seen).toEqual([{ table: "sessions", purpose: "auth_flow" }]);
  });

  it("logs to the production sink when nothing is registered", () => {
    handleServerNotice(report("rls_bypass_not_granted table=sessions purpose=token_lifecycle"));
    expect(mockWarn).toHaveBeenCalledWith(
      { _logType: "rls.bypass_not_granted", table: "sessions", purpose: "token_lifecycle" },
      "rls.bypass_not_granted",
    );
  });

  it.each([
    ["a notice below WARNING", report("rls_bypass_not_granted table=sessions purpose=x", WHERE, "00000")],
    ["a WARNING from another function", report("rls_bypass_not_granted table=sessions purpose=x", "PL/pgSQL function other_fn(text) line 1 at RAISE")],
    ["a WARNING with no source", { severity: "WARNING", code: "01000", message: "rls_bypass_not_granted table=sessions purpose=x" }],
    ["statement logging carrying a secret", report("statement: SELECT 'secret-param-value'", "", "00000")],
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

describe("unparsed reports", () => {
  it("logs one constant line per window, however many distinct ones arrive", () => {
    handleServerNotice(report("rls_bypass_not_granted tbl=users"));
    handleServerNotice(report("rls_bypass_not_granted tbl=sessions"));
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith({ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed");
  });

  it("logs again once the window has passed (the boundary logs)", () => {
    vi.useFakeTimers();
    try {
      handleServerNotice(report("rls_bypass_not_granted tbl=users"));
      vi.advanceTimersByTime(59_999);
      handleServerNotice(report("rls_bypass_not_granted tbl=users"));
      expect(mockWarn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      handleServerNotice(report("rls_bypass_not_granted tbl=users"));
      expect(mockWarn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use up a parsed report's slot", () => {
    handleServerNotice(report("rls_bypass_not_granted tbl=users"));
    handleServerNotice(report("rls_bypass_not_granted table=users purpose=auth_flow"));
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenLastCalledWith(
      { _logType: "rls.bypass_not_granted", table: "users", purpose: "auth_flow" },
      "rls.bypass_not_granted",
    );
  });
});

describe("productionBypassNoticeSink", () => {
  it("logs one line per (table, purpose) per window", () => {
    productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ table: "users", purpose: "auth_flow" });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("logs the same pair again once the window has passed", () => {
    vi.useFakeTimers();
    try {
      productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
      vi.advanceTimersByTime(59_999);
      productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
      expect(mockWarn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      productionBypassNoticeSink({ table: "sessions", purpose: "auth_flow" });
      expect(mockWarn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("createPool / createClient attach the report listener", () => {
  const notice = report("rls_bypass_not_granted table=users purpose=auth_flow");

  it("routes a notice on a pooled connection to the sink", async () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db" });
    try {
      // What pg emits for each new physical connection.
      const connection = new EventEmitter();
      pool.emit("connect", connection as unknown as pg.PoolClient);
      connection.emit("notice", notice);
      expect(seen).toEqual([{ table: "users", purpose: "auth_flow" }]);
    } finally {
      await pool.end();
    }
  });

  it("routes a notice on a single client to the sink", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const client = createClient({ connectionString: "postgresql://u:p@localhost:5432/db" });
    client.emit("notice", notice);
    expect(seen).toEqual([{ table: "users", purpose: "auth_flow" }]);
  });
});

describe("createPool / createClient refuse to silence the reports", () => {
  it.each([
    ["the config's options", { options: "-c client_min_messages=error" }],
    ["the connection string's options", { connectionString: "postgresql://u:p@localhost:5432/db?options=-c%20client_min_messages%3Derror" }],
    // PostgreSQL folds `-` into `_` in option names.
    ["the config's options, dashed", { options: "-c client-min-messages=error" }],
    ["the connection string's options, dashed", { connectionString: "postgresql://u:p@localhost:5432/db?options=-c%20client-min-messages%3Derror" }],
    // The server drops a backslash and keeps the next character (pg_split_opts).
    ["the config's options, backslash-escaped", { options: "-c client\\_min\\_messages=error" }],
    ["the config's options, an escaped letter", { options: "-c clien\\t_min_messages=error" }],
    ["the connection string's options, backslash-escaped", { connectionString: "postgresql://u:p@localhost:5432/db?options=-c%20client%5C_min%5C_messages%3Derror" }],
    // `new URL` rejects a host-less URL; pg parses it and applies its options.
    ["a host-less connection string's options", { connectionString: "postgres://u:p@/db?options=-c%20client_min_messages%3Derror" }],
  ])("rejects client_min_messages in %s", (_label, config) => {
    expect(() => createPool(config)).toThrow("must not set client_min_messages");
    expect(() => createClient(config)).toThrow("must not set client_min_messages");
  });

  it("rejects client_min_messages in PGOPTIONS", () => {
    vi.stubEnv("PGOPTIONS", "-c client_min_messages=error");
    expect(() => createPool({ connectionString: "postgresql://u:p@localhost:5432/db" })).toThrow("must not set client_min_messages");
  });

  it("rejects a backslash-escaped client_min_messages in PGOPTIONS", () => {
    vi.stubEnv("PGOPTIONS", "-c client\\_min\\_messages=error");
    expect(() => createPool({ connectionString: "postgresql://u:p@localhost:5432/db" })).toThrow("must not set client_min_messages");
  });

  it("accepts connection-string options carrying backslash escapes", async () => {
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db?options=-c%20application_name%3Da%5C%20b" });
    await pool.end();
  });

  it("rejects a dashed client-min-messages in PGOPTIONS", () => {
    vi.stubEnv("PGOPTIONS", "-c client-min-messages=error");
    expect(() => createPool({ connectionString: "postgresql://u:p@localhost:5432/db" })).toThrow("must not set client_min_messages");
  });

  it.each([
    ["application_name in the URL", { connectionString: "postgres://u:p@localhost:5432/db?application_name=x%00client_min_messages%00error" }],
    ["application_name in the config", { connectionString: "postgresql://u:p@localhost:5432/db", application_name: "x\0client_min_messages\0error" }],
    ["the URL's user", { connectionString: "postgres://u%00client_min_messages%00error:p@localhost:5432/db" }],
    ["the URL's database", { connectionString: "postgres://u:p@localhost:5432/db%00client_min_messages%00error" }],
    ["a NUL as the last character", { connectionString: "postgresql://u:p@localhost:5432/db", application_name: "app\0" }],
    ["options", { connectionString: "postgresql://u:p@localhost:5432/db", options: "-c statement_timeout=5\0client_min_messages\0error" }],
    ["fallback_application_name", { connectionString: "postgresql://u:p@localhost:5432/db", fallback_application_name: "x\0client_min_messages\0error" }],
    // pg sends replication as `'' + value`: a non-string carries its string form.
    ["an object replication value", { connectionString: "postgresql://u:p@localhost:5432/db", replication: { toString: (): string => "x\0client_min_messages\0error" } }],
    ["an array replication value", { connectionString: "postgresql://u:p@localhost:5432/db", replication: ["x\0client_min_messages\0error"] }],
  ])("rejects a NUL byte in %s, which injects a startup setting", (_label, config) => {
    expect(() => createPool(config)).toThrow("must not contain a NUL byte");
    expect(() => createClient(config)).toThrow("must not contain a NUL byte");
  });

  it.each([
    ["replication: true", { replication: true }],
    ['replication: "database"', { replication: "database" }],
    ["an ordinary fallback_application_name", { fallback_application_name: "passwd-sso" }],
    ["an empty application_name", { application_name: "" }],
  ])("accepts %s", async (_label, extra) => {
    // The NUL check coerces as pg does; it must not refuse a non-string or an
    // empty value that carries no NUL.
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db", ...extra });
    await pool.end();
  });

  it("accepts an ordinary application_name", async () => {
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db", application_name: "passwd-sso worker 1" });
    await pool.end();
  });

  it("accepts other options carrying backslash escapes", async () => {
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db", options: "-c application_name=a\\ b" });
    await pool.end();
  });

  it("accepts other options", async () => {
    const pool = createPool({ connectionString: "postgresql://u:p@localhost:5432/db", options: "-c statement_timeout=5000" });
    await pool.end();
  });
});
