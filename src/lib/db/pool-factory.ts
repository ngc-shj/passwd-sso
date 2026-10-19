import pg from "pg";
import ConnectionParameters from "pg/lib/connection-parameters";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { getLogger } from "@/lib/logger";
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

export const productionBypassNoticeSink: BypassNoticeSink = ({ table, purpose }) => {
  const key = `${table}\u0000${purpose}`;
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < RATE_WINDOW_MS) return;
  if (!lastLogged.has(key) && lastLogged.size >= RATE_MAP_MAX) {
    const oldest = lastLogged.keys().next().value;
    if (oldest !== undefined) lastLogged.delete(oldest);
  }
  lastLogged.set(key, now);
  getLogger().warn({ _logType: "rls.bypass_not_granted", table, purpose }, "rls.bypass_not_granted");
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
    getLogger().warn({ _logType: "rls.bypass_notice_unparsed" }, "rls.bypass_notice_unparsed");
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

/**
 * Refuse a configuration that would raise `client_min_messages` above WARNING
 * for these connections and so silence the reports. The startup `options` are
 * read the way pg reads them — pg's own ConnectionParameters for the
 * connection string (which accepts strings `new URL` rejects) and for
 * PGOPTIONS — and every source is checked, a superset of the one pg applies.
 * A connection string pg cannot parse throws here, as it would on connect. A
 * role-level setting is not visible here (SC5's canary detects it).
 */
function assertReportsNotSuppressed(config: pg.ClientConfig): void {
  const sources = [
    config.options,
    config.connectionString ? new ConnectionParameters(config.connectionString).options : undefined,
    new ConnectionParameters().options,
  ];
  for (const source of sources) {
    if (source && CLIENT_MIN_MESSAGES_RE.test(source)) {
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

export function createPrismaClient(
  pool: pg.Pool,
  options: Omit<Prisma.PrismaClientOptions, "adapter" | "accelerateUrl"> = {},
): PrismaClient {
  return new PrismaClient({ ...options, adapter: new PrismaPg(pool) });
}
