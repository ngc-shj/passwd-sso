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
 * client (check-bypass-rls's pool rule). Every connection gets the listeners
 * that turn `public.rls_bypass_admits`'s reports into log lines: when a
 * bypassed statement reaches a table outside its grant the database raises a
 * WARNING naming the table and purpose, then refuses the statement (42501).
 * The log lines and their metric are how an operator learns of a refusal a
 * caller caught.
 *
 * Both are counted because they fail differently. The WARNING is the only
 * signal in report mode, but a `client_min_messages` above `warning` (a role or
 * database setting changed between deploys) keeps it from reaching the client.
 * The refusal is always delivered, since a statement-ending error is sent
 * whatever that setting says, but it only exists while the database enforces.
 */

export const BYPASS_REPORT_KIND = { WARNING: "warning", REFUSAL: "refusal" } as const;
export type BypassReportKind = (typeof BYPASS_REPORT_KIND)[keyof typeof BYPASS_REPORT_KIND];

/** A report from `rls_bypass_admits`: which signal, the table reached and the bypass purpose. */
export type BypassNotice = { kind: BypassReportKind; table: string; purpose: string };
export type BypassNoticeSink = (notice: BypassNotice) => void;

// The function's own text, matched whole; `purpose` is sanitised in SQL.
const REPORT_RE = /^rls_bypass_not_granted table=([a-z0-9_]{1,63}) purpose=([a-z0-9_-]{1,64}|<invalid>)$/;
const REFUSAL_RE = /^RLS_BYPASS_NOT_GRANTED: ([a-z0-9_]{1,63})$/;
const REFUSAL_HINT_RE = /^bypass purpose ([a-z0-9_-]{1,64}|<invalid>)$/;
const REPORT_SOURCE = "rls_bypass_admits";
// The function runs with `SET search_path = pg_catalog, pg_temp`, so `public` is
// not visible while its context line is formatted and PostgreSQL schema-qualifies
// the name. Should that setting ever be dropped the frame reads
// `rls_bypass_admits(text)` unqualified: every real report then lands on the
// unparsed line, which raises the alarm, instead of reading as zero.
const REPORT_FRAME = "public.rls_bypass_admits(text)";
const UNPARSED_KEY = "\u0000unparsed";

// The `_logType` of each line; infra/terraform/monitoring.tf counts all three.
const REPORT_LOG_TYPE = {
  WARNING: "rls.bypass_not_granted",
  REFUSAL: "rls.bypass_refused",
  UNPARSED: "rls.bypass_notice_unparsed",
} as const;

const logTypeOf = (kind: BypassReportKind): string =>
  kind === BYPASS_REPORT_KIND.REFUSAL ? REPORT_LOG_TYPE.REFUSAL : REPORT_LOG_TYPE.WARNING;

/**
 * Where a server message came from. `exact`: the innermost frame (the first
 * line of `where`) is the function itself. `mentioned`: the name appears, but
 * not as the innermost frame — an outer `SQL statement "…"` frame, a function
 * in another schema, or the unqualified form above — so the message is counted
 * as unparsed rather than trusted or dropped. The context line is localized
 * around the signature, never inside it.
 */
function bypassAdmitsFrame(where: unknown): "exact" | "mentioned" | "none" {
  if (typeof where !== "string" || !where.includes(REPORT_SOURCE)) return "none";
  const innermost = where.split("\n", 1)[0];
  return innermost.includes(REPORT_FRAME) ? "exact" : "mentioned";
}

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

// Keyed by kind too: a refusal arrives right after its WARNING for the same
// pair, and must not find its slot already taken.
export const productionBypassNoticeSink: BypassNoticeSink = ({ kind, table, purpose }) => {
  if (!withinRateLimit(`${kind}\u0000${table}\u0000${purpose}`)) return;
  const _logType = logTypeOf(kind);
  logger.warn({ _logType, table, purpose }, _logType);
};

export const stderrBypassNoticeSink: BypassNoticeSink = ({ kind, table, purpose }) => {
  process.stderr.write(`${JSON.stringify({ _logType: logTypeOf(kind), table, purpose })}\n`);
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

// No content to key on, so one shared rate-limit slot.
function logUnparsed(): void {
  if (withinRateLimit(UNPARSED_KEY)) {
    logger.warn({ _logType: REPORT_LOG_TYPE.UNPARSED }, REPORT_LOG_TYPE.UNPARSED);
  }
}

/**
 * Hand a report to the sink. The listeners run inside pg's parser callback, so
 * a sink that throws must not propagate (it would leave the query unsettled or
 * escape as an uncaught exception), and must not read as zero reports either:
 * the constant unparsed line, which the same metric counts, goes to stderr
 * directly, since the sink that failed may be the logger.
 */
function deliver(notice: BypassNotice): void {
  try {
    (registeredSink ?? productionBypassNoticeSink)(notice);
  } catch {
    try {
      if (withinRateLimit(UNPARSED_KEY)) {
        process.stderr.write(`${JSON.stringify({ _logType: REPORT_LOG_TYPE.UNPARSED })}\n`);
      }
    } catch {
      // stderr itself failed; nothing is left to write to.
    }
  }
}

// SQLSTATE of a plain RAISE WARNING. Matched instead of `severity`, which is
// the localized S field: under a non-English lc_messages it is not "WARNING".
const WARNING_SQLSTATE = "01000";
// The function's refusal (`ERRCODE = '42501'`); a plain `permission denied`
// carries the same SQLSTATE, so the source frame decides.
const REFUSAL_SQLSTATE = "42501";

/**
 * Turn one server notice into a report, or drop it. Only a 01000 warning whose
 * innermost frame is `public.rls_bypass_admits(text)` and whose text matches
 * the report exactly is accepted (code that can issue arbitrary SQL can still
 * raise a look-alike, which is outside this control); one that only mentions
 * the function is logged as unparsed, with no content. Anything else —
 * statement logging, other functions' notices — is dropped without any part of
 * it being logged. Every field compared is locale-independent: the SQLSTATE,
 * the function signature (substituted into the localized context line), and
 * the message the function formats itself.
 */
export function handleServerNotice(notice: { code?: string; message?: string; where?: string }): void {
  if (notice.code !== WARNING_SQLSTATE) return;
  const frame = bypassAdmitsFrame(notice.where);
  if (frame === "none") return;
  const match = frame === "exact" && typeof notice.message === "string" ? REPORT_RE.exec(notice.message) : null;
  if (!match) {
    logUnparsed();
    return;
  }
  deliver({ kind: BYPASS_REPORT_KIND.WARNING, table: match[1], purpose: match[2] });
}

/**
 * Turn one server error into a refusal report, or drop it: the same rules as
 * the notice, over the function's `RAISE EXCEPTION` — SQLSTATE 42501, the
 * message `RLS_BYPASS_NOT_GRANTED: <table>` and the hint `bypass purpose
 * <purpose>`, all the function's own text.
 */
export function handleServerError(error: { code?: string; message?: string; hint?: string; where?: string }): void {
  if (error.code !== REFUSAL_SQLSTATE) return;
  const frame = bypassAdmitsFrame(error.where);
  if (frame === "none") return;
  const exact = frame === "exact";
  const table = exact && typeof error.message === "string" ? REFUSAL_RE.exec(error.message)?.[1] : undefined;
  const purpose = exact && typeof error.hint === "string" ? REFUSAL_HINT_RE.exec(error.hint)?.[1] : undefined;
  if (table === undefined || purpose === undefined) {
    logUnparsed();
    return;
  }
  deliver({ kind: BYPASS_REPORT_KIND.REFUSAL, table, purpose });
}

// Set only once the probe passes, so a failed probe throws on every call: a
// caller that retries after a caught startup error must not get a pool whose
// refusals go uncounted.
let listenerSupportVerified = false;

/**
 * Refuse to build a pool or client when pg no longer exposes the connection's
 * event emitter, where `errorMessage` is emitted. Attaching would throw inside
 * pg-pool's `connect` emit, or worse, a missing hook would read as zero
 * refusals. This proves the listener API is there, not that pg still emits
 * `errorMessage`; the integration suite's refusal cells catch an event rename.
 */
function assertListenerSupport(): void {
  if (listenerSupportVerified) return;
  const probe = new pg.Client() as { connection?: { prependListener?: unknown } };
  if (typeof probe.connection?.prependListener !== "function") {
    throw new Error("pg.Client exposes no connection event emitter: RLS bypass refusals could not be counted");
  }
  listenerSupportVerified = true;
}

/** Test seam: forget that the listener-support probe passed. */
export function resetListenerSupportProbe(): void {
  listenerSupportVerified = false;
}

// pg's own `errorMessage` handler settles the query, and runs a callback-style
// query's callback synchronously, so a listener behind it can be skipped by a
// throw. Prepending makes the count independent of what a caller does.
function attachListeners(client: pg.Client): void {
  client.on("notice", handleServerNotice);
  client.connection.prependListener("errorMessage", handleServerError);
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
 * Take the configuration pg will use, once, and refuse it if it would raise
 * `client_min_messages` above WARNING for these connections and so silence the
 * reports: a startup parameter carrying a NUL, or `options` naming the
 * parameter.
 *
 * The check runs on a snapshot (`{ ...config }`, so a getter runs once) whose
 * startup string parameters must already be primitives — a string, or for
 * `replication` a string or boolean — and the SAME snapshot is what pg gets. A
 * value checked one way and serialised another (`String(x)` reads `toString`,
 * pg's `'' + x` reads `valueOf`; a getter read twice) therefore cannot differ
 * from what is sent. pg throws on a non-string in the other parameters anyway.
 *
 * Values are read the way pg reads them — pg's own ConnectionParameters for the
 * connection string (which accepts strings `new URL` rejects) and for the PG*
 * environment — and every source is checked, a superset of the one pg applies.
 * A connection string pg cannot parse throws here, as it would on connect. A
 * role-level setting is not visible here (the grant audit reads it from
 * pg_db_role_setting).
 */
function checkedConfig<T extends pg.ClientConfig>(config: T): T {
  const snapshot = { ...config };
  const fields = snapshot as Record<string, unknown>;
  // The listener probe checks pg.Client; a pool building another class would
  // hand `connect` clients the probe never saw.
  for (const name of ["Client", "native"]) {
    if (fields[name] !== undefined) {
      throw new Error(`database connection config must not set ${name}: the RLS bypass listeners are checked against pg.Client`);
    }
  }
  for (const name of STARTUP_STRING_PARAMS) {
    const value = fields[name];
    if (value === undefined || value === null) continue;
    const allowed = typeof value === "string" || (name === "replication" && typeof value === "boolean");
    if (!allowed) {
      throw new Error(`database connection parameter ${name} must be a string${name === "replication" ? " or boolean" : ""}`);
    }
  }
  const sources: Record<string, unknown>[] = [
    fields,
    ...(snapshot.connectionString ? [new ConnectionParameters(snapshot.connectionString) as unknown as Record<string, unknown>] : []),
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
  return snapshot;
}

export function createPool(config: pg.PoolConfig): pg.Pool {
  assertListenerSupport();
  const pool = new pg.Pool(checkedConfig(config));
  // pg-pool builds pg.Client instances (checkedConfig refuses another class).
  pool.on("connect", (client) => attachListeners(client as unknown as pg.Client));
  return pool;
}

export function createClient(config: pg.ClientConfig): pg.Client {
  assertListenerSupport();
  const client = new pg.Client(checkedConfig(config));
  attachListeners(client);
  return client;
}

/**
 * `ownsPool`: end `pool` when the client disconnects. The adapter leaves an
 * external pool open by default, and pg's idle timer then holds the process
 * for idleTimeoutMillis — right for the app and the workers, which end their
 * pools themselves on shutdown (ending twice throws), wrong for a script that
 * only calls `$disconnect()`. With `ownsPool`, do not query after
 * `$disconnect()`: the adapter would reconnect through a pool it builds itself,
 * which has neither the report listeners nor the options check.
 */
export function createPrismaClient(
  pool: pg.Pool,
  options: Omit<Prisma.PrismaClientOptions, "adapter" | "accelerateUrl"> = {},
  { ownsPool = false }: { ownsPool?: boolean } = {},
): PrismaClient {
  return new PrismaClient({ ...options, adapter: new PrismaPg(pool, { disposeExternalPool: ownsPool }) });
}
