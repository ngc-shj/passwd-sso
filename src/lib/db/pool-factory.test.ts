import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import pg from "pg";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => {
  const logger = { warn: mockWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: logger, getLogger: () => logger };
});

import {
  BYPASS_REPORT_KIND,
  createClient,
  createPool,
  handleServerError,
  handleServerNotice,
  productionBypassNoticeSink,
  registerBypassNoticeSink,
  resetBypassNoticeRateLimit,
  stderrBypassNoticeSink,
  type BypassNotice,
} from "@/lib/db/pool-factory";

// The function runs with a pinned search_path, so the context line schema-qualifies it.
const WHERE = "PL/pgSQL function public.rls_bypass_admits(text) line 19 at RAISE";
const REFUSAL_WHERE = "PL/pgSQL function public.rls_bypass_admits(text) line 21 at RAISE";
// A plain RAISE WARNING carries SQLSTATE 01000; LOG-level messages carry 00000.
const report = (message: string, where = WHERE, code = "01000") => ({ severity: "WARNING", code, message, where });
// The function's RAISE EXCEPTION ... USING ERRCODE = '42501', as the ErrorResponse carries it.
// `over` may carry non-string values: pg-protocol types nothing at runtime.
const refusal = (over: Record<string, unknown> = {}) =>
  ({
    code: "42501",
    message: "RLS_BYPASS_NOT_GRANTED: password_entries",
    hint: "bypass purpose auth_flow",
    where: REFUSAL_WHERE,
    ...over,
  }) as Parameters<typeof handleServerError>[0];
const UNPARSED_LINE = '{"_logType":"rls.bypass_notice_unparsed"}\n';

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
    expect(seen).toEqual([{ kind: "warning", table: "password_entries", purpose: "auth_flow" }]);
  });

  it("accepts a table name with digits and the invalid-purpose marker", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(report("rls_bypass_not_granted table=oauth2_grants purpose=<invalid>"));
    expect(seen).toEqual([{ kind: "warning", table: "oauth2_grants", purpose: "<invalid>" }]);
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
      // Constructed from PostgreSQL's message catalog, not observed: the
      // worktree server has no translations installed.
      where: "PL/pgSQL関数public.rls_bypass_admits(text)の19行目 - RAISE",
    };
    handleServerNotice(localized);
    expect(seen).toEqual([{ kind: "warning", table: "sessions", purpose: "auth_flow" }]);
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
    productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
    productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "users", purpose: "auth_flow" });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("logs the same pair again once the window has passed", () => {
    vi.useFakeTimers();
    try {
      productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
      vi.advanceTimersByTime(59_999);
      productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
      expect(mockWarn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
      expect(mockWarn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps its rate-limit map bounded under many distinct pairs", () => {
    for (let i = 0; i < 1_500; i++) productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: `t${i}`, purpose: "p" });
    expect(mockWarn).toHaveBeenCalledTimes(1_500);
    mockWarn.mockReset();
    // The earliest pairs were evicted, so they log again.
    productionBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "t0", purpose: "p" });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe("stderrBypassNoticeSink", () => {
  it("writes the report as a JSON line to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stderrBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "users", purpose: "system_maintenance" });
      expect(write).toHaveBeenCalledWith('{"_logType":"rls.bypass_not_granted","table":"users","purpose":"system_maintenance"}\n');
    } finally {
      write.mockRestore();
    }
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
      const client = new pg.Client({ connectionString: "postgresql://u:p@localhost:5432/db" });
      pool.emit("connect", client as unknown as pg.PoolClient);
      client.emit("notice", notice);
      expect(seen).toEqual([{ kind: "warning", table: "users", purpose: "auth_flow" }]);
    } finally {
      await pool.end();
    }
  });

  it("routes a notice on a single client to the sink", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const client = createClient({ connectionString: "postgresql://u:p@localhost:5432/db" });
    client.emit("notice", notice);
    expect(seen).toEqual([{ kind: "warning", table: "users", purpose: "auth_flow" }]);
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
  ])("rejects a NUL byte in %s, which injects a startup setting", (_label, config) => {
    expect(() => createPool(config)).toThrow("must not contain a NUL byte");
    expect(() => createClient(config)).toThrow("must not contain a NUL byte");
  });

  it.each([
    // pg writes replication as `'' + value` (valueOf first): an object could show
    // a check one string and send another, so only primitives are taken.
    ["an object replication value", { replication: { toString: (): string => "x\0client_min_messages\0error" } }, "replication must be a string or boolean"],
    ["an array replication value", { replication: ["x\0client_min_messages\0error"] }, "replication must be a string or boolean"],
    ["a valueOf/toString split", { replication: { valueOf: (): string => "x\0client_min_messages\0error", toString: (): string => "database" } }, "replication must be a string or boolean"],
    ["a non-string user", { user: { toString: (): string => "u" } }, "user must be a string"],
  ])("rejects %s", (_label, extra, message) => {
    const config = { connectionString: "postgresql://u:p@localhost:5432/db", ...extra } as unknown as pg.PoolConfig;
    expect(() => createPool(config)).toThrow(message);
    expect(() => createClient(config as pg.ClientConfig)).toThrow(message);
  });

  it("checks the value pg.Client is given, reading a getter once", () => {
    let reads = 0;
    const config = { connectionString: "postgresql://u:p@localhost:5432/db" } as pg.ClientConfig;
    Object.defineProperty(config, "application_name", {
      enumerable: true,
      get: () => (++reads === 1 ? "clean" : "x\0client_min_messages\0error"),
    });
    const client = createClient(config);
    expect(reads).toBe(1);
    expect((client as unknown as { connectionParameters: { application_name?: string } }).connectionParameters.application_name).toBe("clean");
  });

  it("checks the value pg is given, reading a getter once", async () => {
    // A getter clean on the first read and injecting on the second: what was
    // checked must be what the pool holds.
    let reads = 0;
    const config = { connectionString: "postgresql://u:p@localhost:5432/db" } as pg.PoolConfig;
    Object.defineProperty(config, "application_name", {
      enumerable: true,
      get: () => (++reads === 1 ? "clean" : "x\0client_min_messages\0error"),
    });
    const pool = createPool(config);
    try {
      expect(reads).toBe(1);
      expect((pool as unknown as { options: { application_name?: string } }).options.application_name).toBe("clean");
    } finally {
      await pool.end();
    }
  });

  it.each([
    ["replication: true", { replication: true }],
    ['replication: "database"', { replication: "database" }],
    ["an ordinary fallback_application_name", { fallback_application_name: "passwd-sso" }],
    ["an empty application_name", { application_name: "" }],
  ])("accepts %s", async (_label, extra) => {
    // The checks must not over-block: a boolean replication, an empty string
    // and an ordinary value carry no NUL.
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

describe("handleServerError", () => {
  it("routes a refusal from rls_bypass_admits to the registered sink", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(refusal());
    expect(seen).toEqual([{ kind: "refusal", table: "password_entries", purpose: "auth_flow" }]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["the invalid-purpose marker", refusal({ hint: "bypass purpose <invalid>" }), { table: "password_entries", purpose: "<invalid>" }],
    ["a table name with digits", refusal({ message: "RLS_BYPASS_NOT_GRANTED: oauth2_grants" }), { table: "oauth2_grants", purpose: "auth_flow" }],
    ["a 63-character table", refusal({ message: `RLS_BYPASS_NOT_GRANTED: ${"t".repeat(63)}` }), { table: "t".repeat(63), purpose: "auth_flow" }],
    ["a 64-character purpose", refusal({ hint: `bypass purpose ${"p".repeat(64)}` }), { table: "password_entries", purpose: "p".repeat(64) }],
    [
      "a localized context line",
      // Constructed from PostgreSQL's message catalog, not observed: the
      // worktree server has no translations installed.
      refusal({ where: "PL/pgSQL関数public.rls_bypass_admits(text)の21行目 - RAISE" }),
      { table: "password_entries", purpose: "auth_flow" },
    ],
  ])("accepts %s", (_label, error, expected) => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(error);
    expect(seen).toEqual([{ kind: "refusal", ...expected }]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["a 64-character table", refusal({ message: `RLS_BYPASS_NOT_GRANTED: ${"t".repeat(64)}` })],
    ["a 65-character purpose", refusal({ hint: `bypass purpose ${"p".repeat(65)}` })],
    ["text after the table", refusal({ message: "RLS_BYPASS_NOT_GRANTED: users secret-value" })],
    ["a newline and text after the table", refusal({ message: "RLS_BYPASS_NOT_GRANTED: users\nsecret-value" })],
    ["text before the message", refusal({ message: "secret-value RLS_BYPASS_NOT_GRANTED: users" })],
    ["text before the hint", refusal({ hint: "secret-value bypass purpose auth_flow" })],
    ["a newline in the hint", refusal({ hint: "bypass purpose auth_flow\nsecret-value" })],
    ["a trailing newline in the hint", refusal({ hint: "bypass purpose auth_flow\n" })],
    ["a missing hint", refusal({ hint: undefined })],
    ["a missing message", refusal({ message: undefined })],
    // Coerced, these would match: only the typeof guards refuse them.
    ["a non-string hint", refusal({ hint: { toString: () => "bypass purpose auth_flow" } })],
    ["a non-string message", refusal({ message: { toString: () => "RLS_BYPASS_NOT_GRANTED: users" } })],
  ])("logs one constant line, with no content, for %s", (_label, error) => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(error);
    expect(seen).toEqual([]);
    expect(mockWarn.mock.calls).toEqual([[{ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed"]]);
  });

  it("logs a constant line, not a refusal, when only an outer frame names the function", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(
      refusal({
        where: 'PL/pgSQL function public.other_fn() line 4 at RAISE\nSQL statement "SELECT public.rls_bypass_admits(\'x\')"',
      }),
    );
    expect(seen).toEqual([]);
    expect(mockWarn.mock.calls).toEqual([[{ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed"]]);
  });

  it("drops a look-alike whose context is another function, logging nothing", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(refusal({ where: "PL/pgSQL function public.other_fn(text) line 21 at RAISE" }));
    expect(seen).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs the unqualified innermost frame as unparsed, and the qualified frame as a refusal", () => {
    // Without the function's pinned search_path the frame reads unqualified:
    // real refusals would all land on the unparsed line (the alarm) rather
    // than read as zero.
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(refusal({ where: "PL/pgSQL function rls_bypass_admits(text) line 21 at RAISE" }));
    expect(seen).toEqual([]);
    expect(mockWarn.mock.calls).toEqual([[{ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed"]]);
    resetBypassNoticeRateLimit();
    mockWarn.mockReset();
    handleServerError(refusal());
    expect(seen).toEqual([{ kind: "refusal", table: "password_entries", purpose: "auth_flow" }]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs the unqualified innermost frame of a warning as unparsed, and the qualified frame as a report", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const message = "rls_bypass_not_granted table=users purpose=auth_flow";
    handleServerNotice(report(message, "PL/pgSQL function rls_bypass_admits(text) line 19 at RAISE"));
    expect(seen).toEqual([]);
    expect(mockWarn.mock.calls).toEqual([[{ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed"]]);
    resetBypassNoticeRateLimit();
    mockWarn.mockReset();
    handleServerNotice(report(message));
    expect(seen).toEqual([{ kind: "warning", table: "users", purpose: "auth_flow" }]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs a warning whose outer frame alone names the function as unparsed", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerNotice(
      report(
        "rls_bypass_not_granted table=users purpose=auth_flow",
        'PL/pgSQL function public.other_fn() line 4 at RAISE\nSQL statement "SELECT public.rls_bypass_admits(\'x\')"',
      ),
    );
    expect(seen).toEqual([]);
    expect(mockWarn.mock.calls).toEqual([[{ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed"]]);
  });

  it.each([
    ["a plain permission denied", { code: "42501", message: 'permission denied for table "users"' }],
    ["a plain permission denied with another function's context", { code: "42501", message: "permission denied", where: "PL/pgSQL function public.other_fn() line 3 at SQL statement" }],
    ["the exact fields under SQLSTATE P0001", refusal({ code: "P0001" })],
    ["the exact fields with no SQLSTATE", refusal({ code: undefined })],
    ["an empty error", {}],
  ])("drops %s without logging anything", (_label, error) => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    expect(() => handleServerError(error)).not.toThrow();
    expect(seen).toEqual([]);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe("a sink that throws", () => {
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    registerBypassNoticeSink(() => {
      throw new Error("log transport down");
    });
  });

  afterEach(() => {
    write.mockRestore();
  });

  it("does not throw out of the refusal listener, and writes one fixed unparsed line to stderr", () => {
    expect(() => handleServerError(refusal())).not.toThrow();
    expect(write.mock.calls).toEqual([[UNPARSED_LINE]]);
  });

  it("does not throw out of the notice listener, and writes one fixed unparsed line to stderr", () => {
    expect(() => handleServerNotice(report("rls_bypass_not_granted table=users purpose=auth_flow"))).not.toThrow();
    expect(write.mock.calls).toEqual([[UNPARSED_LINE]]);
  });

  it("writes one line for two failures in one window, and another once the window has passed", () => {
    vi.useFakeTimers();
    try {
      handleServerError(refusal());
      vi.advanceTimersByTime(59_999);
      handleServerError(refusal({ message: "RLS_BYPASS_NOT_GRANTED: sessions" }));
      expect(write.mock.calls).toEqual([[UNPARSED_LINE]]);
      vi.advanceTimersByTime(1);
      handleServerError(refusal());
      expect(write.mock.calls).toEqual([[UNPARSED_LINE], [UNPARSED_LINE]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when stderr itself fails", () => {
    write.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    expect(() => handleServerError(refusal())).not.toThrow();
  });

  it("writes no such line when the sink works", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    handleServerError(refusal());
    handleServerNotice(report("rls_bypass_not_granted table=users purpose=auth_flow"));
    expect(seen).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("a logger that throws on an unparsed report", () => {
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockWarn.mockImplementation(() => {
      throw new Error("log transport down");
    });
  });

  afterEach(() => {
    write.mockRestore();
  });

  it.each([
    ["the refusal listener", () => handleServerError(refusal({ message: "RLS_BYPASS_NOT_GRANTED: users trailing" }))],
    ["the notice listener", () => handleServerNotice(report("rls_bypass_not_granted tbl=users"))],
  ])("does not throw out of %s, and writes one fixed unparsed line to stderr", (_label, emit) => {
    expect(emit).not.toThrow();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(write.mock.calls).toEqual([[UNPARSED_LINE]]);
  });

  it("writes nothing to stderr when the logger works", () => {
    mockWarn.mockReset();
    handleServerError(refusal({ message: "RLS_BYPASS_NOT_GRANTED: users trailing" }));
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("productionBypassNoticeSink by kind", () => {
  const warning: BypassNotice = { kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" };
  const refused: BypassNotice = { kind: BYPASS_REPORT_KIND.REFUSAL, table: "sessions", purpose: "auth_flow" };

  it("logs a warning as rls.bypass_not_granted and a refusal as rls.bypass_refused", () => {
    productionBypassNoticeSink(warning);
    productionBypassNoticeSink({ ...refused, table: "users" });
    expect(mockWarn.mock.calls).toEqual([
      [{ _logType: "rls.bypass_not_granted", table: "sessions", purpose: "auth_flow" }, "rls.bypass_not_granted"],
      [{ _logType: "rls.bypass_refused", table: "users", purpose: "auth_flow" }, "rls.bypass_refused"],
    ]);
  });

  it("logs a warning and then a refusal for one pair as two lines", () => {
    productionBypassNoticeSink(warning);
    productionBypassNoticeSink(refused);
    expect(mockWarn.mock.calls.map(([fields]) => fields._logType)).toEqual(["rls.bypass_not_granted", "rls.bypass_refused"]);
  });

  it("logs a repeated refusal within the window once", () => {
    productionBypassNoticeSink(refused);
    productionBypassNoticeSink(refused);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe("stderrBypassNoticeSink by kind", () => {
  it("writes a refusal as rls.bypass_refused and a warning as rls.bypass_not_granted", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stderrBypassNoticeSink({ kind: BYPASS_REPORT_KIND.REFUSAL, table: "users", purpose: "system_maintenance" });
      stderrBypassNoticeSink({ kind: BYPASS_REPORT_KIND.WARNING, table: "users", purpose: "system_maintenance" });
      expect(write.mock.calls).toEqual([
        ['{"_logType":"rls.bypass_refused","table":"users","purpose":"system_maintenance"}\n'],
        ['{"_logType":"rls.bypass_not_granted","table":"users","purpose":"system_maintenance"}\n'],
      ]);
    } finally {
      write.mockRestore();
    }
  });
});

describe("createPool / createClient attach the refusal listener", () => {
  const URL = "postgresql://u:p@localhost:5432/db";
  const connectionOf = (client: pg.Client) => (client as unknown as { connection: EventEmitter }).connection;

  it("routes an ErrorResponse on a single client's connection to the sink", () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const client = createClient({ connectionString: URL });
    connectionOf(client).emit("errorMessage", refusal());
    expect(seen).toEqual([{ kind: "refusal", table: "password_entries", purpose: "auth_flow" }]);
  });

  it("counts a pooled client's refusal ahead of a handler on the same connection that throws", async () => {
    // pg adds its own errorMessage handler in _connect, and it can throw into
    // the emit; this one stands in for it.
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const pool = createPool({ connectionString: URL });
    try {
      const client = new pg.Client({ connectionString: URL });
      connectionOf(client).on("errorMessage", () => {
        throw new Error("pg handler threw");
      });
      pool.emit("connect", client as unknown as pg.PoolClient);
      try {
        connectionOf(client).emit("errorMessage", refusal());
      } catch {
        // The throwing handler's error reaches the emitter; the count must not depend on it.
      }
      expect(seen).toEqual([{ kind: "refusal", table: "password_entries", purpose: "auth_flow" }]);
    } finally {
      await pool.end();
    }
  });

  it("counts one refusal on a pooled client with no throwing handler", async () => {
    const seen: BypassNotice[] = [];
    registerBypassNoticeSink((n) => seen.push(n));
    const pool = createPool({ connectionString: URL });
    try {
      const client = new pg.Client({ connectionString: URL });
      pool.emit("connect", client as unknown as pg.PoolClient);
      connectionOf(client).emit("errorMessage", refusal());
      expect(seen).toEqual([{ kind: "refusal", table: "password_entries", purpose: "auth_flow" }]);
    } finally {
      await pool.end();
    }
  });
});
