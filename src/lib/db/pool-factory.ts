import pg from "pg";
import ConnectionParameters from "pg/lib/connection-parameters";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
// The base logger, not getLogger(): a notice is emitted from the pooled
// socket's callback, which runs in the async context of whichever request first
// opened that connection, so a request-scoped logger would stamp the report
// with that earlier request's id and path.
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/**
 * The only place production code builds a database pool, client or Prisma
 * client (check-bypass-rls's pool rule). Every connection gets the listener
 * that turns `public.rls_bypass_admits`'s report into a log line: in report
 * mode the database admits a bypassed statement that reached a table outside
 * its grant and raises a WARNING naming the table and purpose.
 */

/** A report from `rls_bypass_admits`: the table reached and the bypass purpose. */
export type BypassNotice = { table: string; purpose: string };
export type BypassNoticeSink = (notice: BypassNotice) => void;

// The function's own text, matched whole; `purpose` is sanitised in SQL.
const REPORT_RE = /^rls_bypass_not_granted table=([a-z0-9_]{1,63}) purpose=([a-z0-9_-]{1,64}|<invalid>)$/;
const REPORT_SOURCE = "rls_bypass_admits";

// Per process, at most one line per (table, purpose) per window; the map is
// bounded so a flood of distinct pairs cannot grow it without limit.
const RATE_WINDOW_MS = MS_PER_MINUTE;
const RATE_MAP_MAX = 1_000;
const lastLogged = new Map<string, number>();

/** True when a line for `key` may be logged now; bounded, per process. */
function withinRateLimit(key: string): boolean {
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < RATE_WINDOW_MS) return false;
  if (!lastLogged.has(key) && lastLogged.size >= RATE_MAP_MAX) {
    const oldest = lastLogged.keys().next().value;
    if (oldest !== undefined) lastLogged.delete(oldest);
  }
  lastLogged.set(key, now);
  return true;
}

export const productionBypassNoticeSink: BypassNoticeSink = ({ table, purpose }) => {
  if (!withinRateLimit(`${table}\u0000${purpose}`)) return;
  logger.warn({ _logType: "rls.bypass_not_granted", table, purpose }, "rls.bypass_not_granted");
};

export const stderrBypassNoticeSink: BypassNoticeSink = ({ table, purpose }) => {
  process.stderr.write(`${JSON.stringify({ _logType: "rls.bypass_not_granted", table, purpose })}\n`);
};

let registeredSink: BypassNoticeSink | null = null;

/**
 * Route reports to `sink` for this process. Resolved when a notice arrives,
 * not when the pool is built, so a sink registered after a pool exists (or a
 * test sink) still receives it. Pass null to restore the production default.
 */
export function registerBypassNoticeSink(sink: BypassNoticeSink | null): void {
  registeredSink = sink;
}

/** Test seam: clear the production sink's rate-limit state. */
export function resetBypassNoticeRateLimit(): void {
  lastLogged.clear();
}

// SQLSTATE of a plain RAISE WARNING. Matched instead of `severity`, which is
// the localized S field: under a non-English lc_messages it is not "WARNING".
const WARNING_SQLSTATE = "01000";

/**
 * Turn one server notice into a report, or drop it. Only a 01000 warning whose
 * context names `rls_bypass_admits` and whose text matches the report exactly
 * is accepted (code that can issue arbitrary SQL can still raise a look-alike,
 * which is outside this control);
 * anything else — statement logging, other functions' notices — is dropped
 * without any part of it being logged. Every field compared is
 * locale-independent: the SQLSTATE, the function name (substituted into the
 * localized context line), and the message the function formats itself.
 */
export function handleServerNotice(notice: { code?: string; message?: string; where?: string }): void {
  if (notice.code !== WARNING_SQLSTATE || !notice.where?.includes(REPORT_SOURCE)) return;
  const match = REPORT_RE.exec(notice.message ?? "");
  if (!match) {
    // No content to key on, so one shared rate-limit slot.
    if (withinRateLimit("\u0000unparsed")) {
      logger.warn({ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed");
    }
    return;
  }
  (registeredSink ?? productionBypassNoticeSink)({ table: match[1], purpose: match[2] });
}

function attachNoticeListener(client: pg.Client | pg.PoolClient): void {
  client.on("notice", handleServerNotice);
}

// PostgreSQL's option parser folds `-` into `_`, so `client-min-messages`
// sets the same parameter.
const CLIENT_MIN_MESSAGES_RE = /client[-_]min[-_]messages/i;

// The server splits startup `options` in pg_split_opts, where a backslash
// escapes the next character and is dropped: `client\_min\_messages` arrives
// as `client_min_messages`. Undo the escapes before matching, as it does.
function unescapeStartupOptions(options: string): string {
  return options.replace(/\\(.)/gs, "$1");
}

// The string startup parameters pg sends. The packet is a run of NUL-terminated
// name/value pairs, and the server applies an unrecognised name as a GUC, so a
// NUL inside any of these values injects a parameter of the sender's choosing
// (`application_name=x%00client_min_messages%00error` sets it; verified).
const STARTUP_STRING_PARAMS = [
  "user",
  "database",
  "application_name",
  "fallback_application_name",
  "options",
  "replication",
] as const;

/**
 * Refuse a configuration that would raise `client_min_messages` above WARNING
 * for these connections and so silence the reports: a startup parameter
 * carrying a NUL, or `options` naming the parameter. Values are read the way pg
 * reads them — pg's own ConnectionParameters for the connection string (which
 * accepts strings `new URL` rejects) and for the PG* environment — and every
 * source is checked, a superset of the one pg applies. A connection string pg
 * cannot parse throws here, as it would on connect. A role-level setting is
 * not visible here (SC5's canary detects it).
 */
function assertReportsNotSuppressed(config: pg.ClientConfig): void {
  const sources: Record<string, unknown>[] = [
    config as Record<string, unknown>,
    ...(config.connectionString ? [new ConnectionParameters(config.connectionString) as unknown as Record<string, unknown>] : []),
    new ConnectionParameters() as unknown as Record<string, unknown>,
  ];
  for (const source of sources) {
    for (const name of STARTUP_STRING_PARAMS) {
      const value = source[name];
      if (typeof value === "string" && value.includes("\0")) {
        throw new Error(`database connection parameter ${name} must not contain a NUL byte: it can inject startup settings`);
      }
    }
    const options = source.options;
    if (typeof options === "string" && CLIENT_MIN_MESSAGES_RE.test(unescapeStartupOptions(options))) {
      throw new Error("database connection options must not set client_min_messages: it would silence RLS bypass reports");
    }
  }
}

export function createPool(config: pg.PoolConfig): pg.Pool {
  assertReportsNotSuppressed(config);
  const pool = new pg.Pool(config);
  pool.on("connect", attachNoticeListener);
  return pool;
}

export function createClient(config: pg.ClientConfig): pg.Client {
  assertReportsNotSuppressed(config);
  const client = new pg.Client(config);
  attachNoticeListener(client);
  return client;
}

/**
 * `ownsPool`: end `pool` when the client disconnects. The adapter leaves an
 * external pool open by default, and pg's idle timer then holds the process
 * for idleTimeoutMillis — right for the app and the workers, which end their
 * pools themselves on shutdown (ending twice throws), wrong for a script that
 * only calls `$disconnect()`. With `ownsPool`, do not query after
 * `$disconnect()`: the adapter would reconnect through a pool it builds itself,
 * which has neither the notice listener nor the options check.
 */
export function createPrismaClient(
  pool: pg.Pool,
  options: Omit<Prisma.PrismaClientOptions, "adapter" | "accelerateUrl"> = {},
  { ownsPool = false }: { ownsPool?: boolean } = {},
): PrismaClient {
  return new PrismaClient({ ...options, adapter: new PrismaPg(pool, { disposeExternalPool: ownsPool }) });
}
