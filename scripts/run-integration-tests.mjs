#!/usr/bin/env node
// `npm run test:integration [-- <vitest args>]`: run the real-DB integration
// suite on a database created for this run and dropped when it ends — locally
// and in CI (.github/workflows/ci-integration.yml), one path.
//
// The suite used to run on whatever DATABASE_URL named, in practice the dev
// database: a live instance and the compose workers use it, the workers raced
// the tests for the same rows, and rows a crashed run (or a seed script) left
// behind broke later runs. Now:
//
//   1. drop the scratch databases a dead run on this host left behind (owned
//      by the role MIGRATION_DATABASE_URL names, marked, and with no
//      connection; see staleScratchDatabases);
//   2. CREATE DATABASE <passwd_it_…> TEMPLATE template0 on the cluster
//      MIGRATION_DATABASE_URL names (a superuser), empty: never a copy of the
//      dev database, whose data is the problem. A keeper connection
//      (application_name passwd-sso-integration-keeper) is opened to it, then
//      COMMENT ON DATABASE sets the marker setup.ts requires, with a nonce
//      only this run holds (scripts/lib/integration-scratch-db.mjs). The
//      keeper stays open until step 9, so the database of a live run always
//      has a connection, and a sweep never takes it for a dead run's;
//   3. with REDIS_URL set: flush the Redis logical databases dead runs on
//      this host claimed, then claim one for this run — empty, no client
//      selected on it, never the index REDIS_URL names — on a keeper
//      connection that stays selected on it until step 9
//      (the Redis section below); REDIS_SENTINEL=true is
//      refused (the Sentinel client ignores the index);
//   4. the per-database half of scripts/bootstrap-rds-roles.mjs
//      (applyPrivilegeSequence: passwd_app's CONNECT/schema/table grants and
//      default privileges, the worker roles' schema privileges), BEFORE the
//      migrations — where initdb and the RDS bootstrap put it — so the
//      migrations' own grants and revokes land on top, as in dev and
//      production. Role creation and passwords are cluster-global and are not
//      touched: the roles must already exist (dev: initdb; CI: the full
//      bootstrap and one `prisma migrate deploy` of the job's default
//      database, in the steps before this one);
//   5. `prisma migrate deploy`, then `bootstrap-rds-roles.mjs --denied-only`
//      (the must-never-be-granted policy, every target required);
//   6. the cluster-global state of the existing passwd_* roles (attributes,
//      password, connection limit, memberships, cluster-wide settings) must
//      be unchanged by 4–5, and the snapshot taken before them must have
//      found roles to compare. The migrations re-run their role statements on
//      every new database; on a cluster that already ran them they are no-ops,
//      and this check holds that rather than assuming it;
//   7. `npm run db:check-drift` against the scratch database;
//   8. vitest with vitest.integration.config.ts and the arguments given, with
//      DATABASE_URL, MIGRATION_DATABASE_URL and every *_DATABASE_URL in the
//      environment pointed at the scratch database, REDIS_URL at the
//      claimed logical database and INTEGRATION_REDIS_CLAIM set to the marker
//      it was claimed under (setup.ts refuses any other claim); a keeper that
//      ended before this point or during it fails the run;
//   9. FLUSHDB the claimed Redis database if it still carries this run's
//      claim, close the keepers, then drop the scratch database (WITH (FORCE),
//      which terminates its connections) and confirm it is gone — only if
//      step 2's CREATE succeeded, and only while the database is still owned
//      by this role and carries this run's exact marker
//      (dropScratchDatabase). Anything else is reported, not dropped; a
//      CREATE whose reply was lost, leaving a database of that name present,
//      is reported too.
//
// What is isolated per run: the Postgres database (every table, sequence and
// per-database grant) and the Redis keyspace of one logical database. What is
// not: Postgres roles and their cluster-wide state (shared, checked in step
// 6), the Redis server's memory and eviction, and any service a test reaches
// by its own URL (the S3 stand-in, Jackson).
//
// Step 9 runs however the run ends. Once it starts, INT/TERM/HUP are ignored
// (the handlers stay installed, so they cannot kill the process mid-drop); a
// signal before that is forwarded to the running child (a second one kills
// it) and the run goes straight to step 9. A drop that fails, a database
// still present after it, or a Redis database that could not be flushed
// prints INTEGRATION_CLEANUP_INCOMPLETE and exits nonzero even when every
// test passed. SIGKILL is irreducible: steps 1 and 3 of the next run on this
// host remove what it left (its keepers die with it).
//
// Exit: vitest's status; 128+n after signal n; 1 for a setup or cleanup
// failure.

import { spawn } from "node:child_process";
import { constants as osConstants, hostname } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import Redis from "ioredis";
import { applyPrivilegeSequence, loadDeniedPolicy } from "./bootstrap-rds-roles.mjs";
import {
  CLAIM_SCRIPT,
  REDIS_CLAIM_ENV,
  REDIS_CLAIM_KEY,
  RELEASE_SCRIPT,
  SCRATCH_DB_KEEPER,
  dropScratchDatabase,
  parseScratchMarker,
  scratchDatabaseEnv,
  scratchDatabaseName,
  scratchMarker,
  scratchRedisRefusal,
  staleScratchDatabases,
} from "./lib/integration-scratch-db.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIGNALS = [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
];

const log = (msg) => process.stderr.write(`[test:integration] ${msg}\n`);

class Interrupted extends Error {}

/**
 * Run `main`, then `drop`, whatever happens in between. Returns the exit status.
 *
 * @param {{
 *   main: (ctx: { run: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>, checkInterrupted: () => void }) => Promise<number>,
 *   drop: () => Promise<boolean>,
 *   name?: string,
 *   signals?: NodeJS.EventEmitter,
 *   log?: (msg: string) => void,
 * }} steps
 */
export async function runWithScratchDatabase({ main, drop, name = "the scratch database", signals = process, log: say = log }) {
  const state = { child: null, signal: null, status: 0, cleaning: false };
  const handlers = SIGNALS.map(([sig, num]) => {
    const handler = () => {
      if (state.cleaning) return;
      if (state.signal === null) {
        state.signal = sig;
        state.status = 128 + num;
        say(`${sig}: stopping, then dropping the scratch database`);
        state.child?.kill(sig);
      } else {
        state.child?.kill("SIGKILL");
      }
    };
    signals.on(sig, handler);
    return [sig, handler];
  });

  const checkInterrupted = () => {
    if (state.signal !== null) throw new Interrupted(`interrupted by ${state.signal}`);
  };
  const run = (cmd, args, env) =>
    new Promise((resolve, reject) => {
      checkInterrupted();
      const child = spawn(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
      state.child = child;
      child.on("error", (e) => {
        state.child = null;
        reject(e);
      });
      child.on("close", (code, sig) => {
        state.child = null;
        resolve(code ?? 128 + (osConstants.signals[sig] ?? 0));
      });
    });

  let status;
  let dropped = false;
  try {
    status = await main({ run, checkInterrupted });
  } catch (e) {
    // After a signal, the step it cut short failing is the expected outcome.
    if (state.signal === null) say(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
    status = 1;
  } finally {
    state.cleaning = true;
    try {
      dropped = await drop();
    } catch (e) {
      say(`dropping the scratch database failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [sig, handler] of handlers) signals.off(sig, handler);
  }
  if (!dropped) {
    say(
      `INTEGRATION_CLEANUP_INCOMPLETE ${name} or this run's Redis database was not removed (the lines above say which); check the database's owner and comment and drop it by hand (DROP DATABASE … WITH (FORCE), as the superuser) only if this run created it`,
    );
    return status !== 0 ? status : 1;
  }
  return state.signal !== null ? state.status : status;
}

/**
 * One line per existing role whose cluster-global state differs, naming the
 * changed columns only (one is a password digest). Roles in only one snapshot
 * are not compared: a concurrent run's probe roles come and go.
 */
export function roleStateChanges(before, after) {
  const prior = new Map(before.map((r) => [r.rolname, r]));
  const changes = [];
  for (const row of after) {
    const old = prior.get(row.rolname);
    if (!old) continue;
    const cols = Object.keys(row).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(old[k]));
    if (cols.length > 0) changes.push(`${row.rolname}: ${cols.join(", ")}`);
  }
  return changes;
}

// The roles the migrations name all carry the project's prefix; memberships
// are read from the member's side (what the role can act as), so a probe role
// a concurrent run grants passwd_app to does not count.
const ROLE_STATE_SQL = `
  SELECT a.rolname, a.rolsuper, a.rolinherit, a.rolcreaterole, a.rolcreatedb,
         a.rolcanlogin, a.rolreplication, a.rolbypassrls, a.rolconnlimit,
         a.rolvaliduntil::text AS rolvaliduntil,
         md5(coalesce(a.rolpassword, '')) AS password_digest,
         ARRAY(SELECT g.rolname || ':' || m.admin_option || m.inherit_option || m.set_option
                 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = a.oid ORDER BY 1) AS member_of,
         ARRAY(SELECT unnest(s.setconfig) FROM pg_db_role_setting s
                WHERE s.setrole = a.oid AND s.setdatabase = 0 ORDER BY 1) AS settings
    FROM pg_authid a
   WHERE a.rolname LIKE 'passwd\\_%'
   ORDER BY a.rolname`;

/**
 * One line per problem with the cluster-global role state around preparing
 * the scratch database, or [] when it is unchanged. An empty `before` is a
 * problem in itself: a snapshot that examined no role proves nothing
 * unchanged (a cluster whose roles are missing or renamed would pass).
 */
export function roleStateProblems(before, after) {
  if (before.length === 0) {
    return ["the role snapshot found no passwd_* role on this cluster, so it cannot show them unchanged"];
  }
  return roleStateChanges(before, after);
}

// SQLSTATE duplicate_database: CREATE DATABASE failed because the name was
// taken, so nothing was created. Any other failure (the reply lost to a reset
// connection among them) leaves open whether it committed.
const DUPLICATE_DATABASE = "42P04";

/**
 * The scratch database's create and drop. drop() removes only what create()
 * made: nothing when CREATE did not succeed (a database of that name that
 * already existed is someone else's), and otherwise only through
 * dropScratchDatabase, expecting the marker once COMMENT succeeded and no
 * comment before that.
 *
 * A CREATE whose outcome is unknown (an error other than duplicate_database)
 * is checked at drop time: a database of that name then present may be this
 * run's, but nothing proves it, so it is reported (drop() returns false, the
 * caller prints INTEGRATION_CLEANUP_INCOMPLETE naming it), never dropped.
 *
 * Between CREATE and COMMENT, openKeeper() opens the keeper connection to the
 * new database (see staleScratchDatabases): the database is never marked
 * without a connection, so another run's sweep cannot take it for a dead
 * run's. drop() closes it just before the drop; keeperLost() says whether it
 * ended before that.
 *
 * @param {{
 *   name: string,
 *   marker: string,
 *   connect: <T>(fn: (c: { query: Function, escapeLiteral: (s: string) => string }) => Promise<T>) => Promise<T>,
 *   openKeeper: () => Promise<{ close: () => Promise<void>, lost: () => boolean }>,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function scratchDatabaseLifecycle({ name, marker, connect, openKeeper, log: say = log }) {
  let created = false;
  let outcomeUnknown = false;
  let comment = null;
  let keeper = null;
  return {
    create: async () => {
      try {
        await connect((c) => c.query(`CREATE DATABASE "${name}" TEMPLATE template0`));
      } catch (e) {
        if (e?.code !== DUPLICATE_DATABASE) outcomeUnknown = true;
        throw e;
      }
      created = true;
      keeper = await openKeeper();
      await connect((c) => c.query(`COMMENT ON DATABASE "${name}" IS ${c.escapeLiteral(marker)}`));
      comment = marker;
    },
    keeperLost: () => keeper?.lost() ?? false,
    drop: async () => {
      if (keeper) {
        await keeper.close();
        keeper = null;
      }
      if (!created) {
        if (!outcomeUnknown) {
          say(`${name} was not created by this run; nothing to drop`);
          return true;
        }
        const { rowCount } = await connect((c) => c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]));
        if (rowCount === 0) return true;
        say(
          `${name} exists although its CREATE DATABASE reported an error (the reply may have been lost after the commit); this run cannot prove it created it, so it is not dropping it`,
        );
        return false;
      }
      return connect((c) => dropScratchDatabase(c, name, comment));
    },
  };
}

// ---- Redis: the logical database a run claims ----
//
// The Redis half of an integration run's isolation: the logical database
// (SELECT index) this runner claims for one run on the
// server REDIS_URL names, points the suite's REDIS_URL at, and FLUSHDBs when
// the run ends. The suite drives rate-limit buckets, session-cache entries and
// tombstones (e.g. mcp-token-ip-rate-capacity's rl:mcp:token:ip:unknown) that
// the live instance on the same Redis reads; on the instance's own database
// the suite resets its limiters and inherits its state.
//
// Why a logical database, not a key prefix: a prefix isolates only the keys a
// client prefixes. The app's client (src/lib/redis.ts) has none, the suite
// opens its own ioredis clients from REDIS_URL, and every one of them, plus
// any child process the suite spawns, would have to honour it; a client that
// does not writes into the live keyspace. SELECT is part of the connection
// URL, so every client built from REDIS_URL lands in the claimed database.
// What a logical database does not isolate: memory, eviction, and server-wide
// commands (FLUSHALL, CONFIG); no test issues the latter.
//
// Redis has no owner for a database, so the claim stands in for one: a
// database is taken only if it is empty and no other client has it selected
// (checked, then claimed by a script that sets the claim key only while
// DBSIZE is 0 — atomic on the server), and it is flushed only by a script
// that first compares the claim key with the run's own marker (CLAIM_SCRIPT
// and RELEASE_SCRIPT, scripts/lib/integration-scratch-db.mjs). The claiming
// connection (the keeper) stays selected on the database until the release,
// so a live run's database always has a client on it, and the sweep of a dead
// run's database requires none (the same rule as the Postgres scratch
// database's keeper).

/**
 * The logical database REDIS_URL selects (its path), 0 when it names none.
 *
 * Read as the app's client reads it (ioredis, src/lib/redis.ts, which passes
 * REDIS_URL with no db option): ioredis also takes connection options from
 * the query string, `?db=N` among them (and host, port, password, tls, …), so
 * a URL with a query is refused rather than read as naming the index its
 * path does. The scheme must be spelled redis:// or rediss://: ioredis turns
 * TLS on only for the exact lowercase "rediss://", while redisUrlForIndex
 * (new URL) would lowercase it. Credentials, host and port pass through
 * redisUrlForIndex unchanged, so the keeper connects to the server the live
 * instance does.
 */
export function redisDatabaseIndex(url) {
  if (!/^rediss?:\/\//.test(url)) throw new Error("REDIS_URL must start with redis:// or rediss://");
  const parsed = new URL(url);
  if (parsed.search !== "") {
    throw new Error(
      "REDIS_URL has a query string; ioredis reads connection options from it (?db=N selects a database), so the runner cannot tell which database the live instance uses — name the database in the path (redis://host:port/N) instead",
    );
  }
  const path = parsed.pathname.replace(/^\//, "");
  if (path === "") return 0;
  if (!/^\d+$/.test(path)) throw new Error("REDIS_URL's path is not a database index");
  return Number(path);
}

/** `url` with its database index replaced by `index`. */
export function redisUrlForIndex(url, index) {
  const u = new URL(url);
  u.pathname = `/${index}`;
  return u.toString();
}

/** CLIENT LIST output as [{ id, db }]. */
export function parseClientList(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const fields = Object.fromEntries(
        line
          .trim()
          .split(" ")
          .map((kv) => {
            const i = kv.indexOf("=");
            return [kv.slice(0, i), kv.slice(i + 1)];
          }),
      );
      return { id: Number(fields.id), db: Number(fields.db) };
    });
}

async function clientsOn(client, index, selfId) {
  const list = parseClientList(String(await client.call("CLIENT", "LIST")));
  return list.filter((c) => c.db === index && c.id !== selfId).length;
}

async function databaseCount(client) {
  try {
    const reply = await client.call("CONFIG", "GET", "databases");
    const n = Number(Array.isArray(reply) ? reply[1] : NaN);
    return Number.isInteger(n) && n > 0 ? n : 16;
  } catch {
    // CONFIG may be renamed or denied by ACL; 16 is the server default.
    return 16;
  }
}

/**
 * Flush the databases dead runs on this host claimed: claim parses, created
 * here by a pid that no longer exists, and no client has the database
 * selected. Each flush re-checks the claim on the server.
 *
 * @param {{ call: (...args: unknown[]) => Promise<unknown> }} client the keeper
 */
export async function sweepStaleRedis(client, { devIndex, host, isAlive, log }) {
  const selfId = Number(await client.call("CLIENT", "ID"));
  const count = await databaseCount(client);
  for (let index = 0; index < count; index++) {
    if (index === devIndex) continue;
    await client.call("SELECT", index);
    const claim = await client.call("GET", REDIS_CLAIM_KEY);
    const marker = parseScratchMarker(claim);
    if (!marker || marker.host !== host || isAlive(marker.pid)) continue;
    if ((await clientsOn(client, index, selfId)) > 0) continue;
    if (Number(await client.call("EVAL", RELEASE_SCRIPT, 1, REDIS_CLAIM_KEY, claim)) === 1) {
      log(`flushed Redis database ${index}, claimed by a run on this host that no longer exists`);
    }
  }
}

/**
 * Claim an empty Redis database no other client has selected, leaving
 * `client` (the keeper) selected on it. Never the database `devIndex` names.
 * Returns the index.
 *
 * @param {{ call: (...args: unknown[]) => Promise<unknown> }} client
 */
export async function claimScratchRedis(client, { devIndex, marker }) {
  const selfId = Number(await client.call("CLIENT", "ID"));
  const count = await databaseCount(client);
  for (let index = 0; index < count; index++) {
    if (index === devIndex) continue;
    if ((await clientsOn(client, index, selfId)) > 0) continue;
    await client.call("SELECT", index);
    if (Number(await client.call("EVAL", CLAIM_SCRIPT, 1, REDIS_CLAIM_KEY, marker)) === 1) return index;
  }
  throw new Error(
    `no Redis logical database is free for this run (every index but ${devIndex} is non-empty or has a client selected)`,
  );
}

/**
 * Flush the claimed database if the claim is still `marker`. Returns whether
 * it was flushed.
 */
export async function releaseScratchRedis(client, marker) {
  return Number(await client.call("EVAL", RELEASE_SCRIPT, 1, REDIS_CLAIM_KEY, marker)) === 1;
}

/**
 * The Redis logical database this run claims (see above):
 * claim() sweeps dead runs' claims, claims a free database on the keeper and
 * returns REDIS_URL pointed at it; release() flushes it if the claim is still
 * this run's, then closes the keeper. Without a REDIS_URL both do nothing.
 *
 * @param {{
 *   url: string | undefined,
 *   sentinel: boolean,
 *   marker: string,
 *   openKeeper: (url: string) => Promise<{ call: (...args: unknown[]) => Promise<unknown>, close: () => Promise<void>, lost: () => boolean }>,
 *   host?: string,
 *   isAlive?: (pid: number) => boolean,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function scratchRedisLifecycle({ url, sentinel, marker, openKeeper, host = hostname(), isAlive: alive = isAlive, log: say = log }) {
  let keeper = null;
  let index = null;
  return {
    claim: async () => {
      if (!url) return undefined;
      if (sentinel) throw new Error(scratchRedisRefusal(null, { sentinel }));
      const devIndex = redisDatabaseIndex(url);
      keeper = await openKeeper(redisUrlForIndex(url, devIndex));
      await sweepStaleRedis(keeper, { devIndex, host, isAlive: alive, log: say });
      index = await claimScratchRedis(keeper, { devIndex, marker });
      say(`claimed Redis logical database ${index}`);
      return redisUrlForIndex(url, index);
    },
    keeperLost: () => keeper?.lost() ?? false,
    release: async () => {
      if (!keeper) return true;
      try {
        if (index === null) return true;
        if (await releaseScratchRedis(keeper, marker)) return true;
        say(`Redis logical database ${index} no longer carries this run's claim; it was not flushed`);
        return false;
      } finally {
        await keeper.close();
        keeper = null;
      }
    },
  };
}

function urlFor(base, database) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

async function openPgKeeper(url) {
  const client = new pg.Client({ connectionString: url, application_name: SCRATCH_DB_KEEPER });
  let closing = false;
  let lost = false;
  const onGone = () => {
    if (!closing) lost = true;
  };
  client.on("error", onGone);
  client.on("end", onGone);
  await client.connect();
  return {
    lost: () => lost,
    close: async () => {
      closing = true;
      await client.end().catch(() => {});
    },
  };
}

async function openRedisKeeper(url) {
  // No reconnect: a reconnected keeper would come back on another database
  // without the run noticing it had left this one unattended.
  const client = new Redis(url, {
    connectionName: SCRATCH_DB_KEEPER,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  let closing = false;
  let lost = false;
  client.on("error", () => {});
  client.on("end", () => {
    if (!closing) lost = true;
  });
  await client.connect();
  return {
    call: (...args) => client.call(...args),
    lost: () => lost,
    close: async () => {
      closing = true;
      await client.quit().catch(() => client.disconnect());
    },
  };
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url, application_name: "passwd-sso-integration-runner" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Drop the scratch databases a dead run on this host left behind. A dead run's
 * nonce died with it, so what proves the database is a runner's is its owner:
 * only this role (or a superuser, who can drop anything anyway) can create a
 * database it owns or set that database's comment. Each drop re-verifies the
 * owner and the comment the database was chosen by.
 */
export async function sweepStale(connect, { host = hostname(), isAlive: alive = isAlive, log: say = log } = {}) {
  const { rows } = await connect((c) =>
    c.query(
      `SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner, current_user AS role,
              shobj_description(d.oid, 'pg_database') AS comment,
              (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
         FROM pg_database d WHERE d.datname LIKE 'passwd\\_it\\_%'`,
    ),
  );
  const role = rows[0]?.role;
  for (const { name, comment } of staleScratchDatabases(rows, { role, host, isAlive: alive })) {
    say(`dropping ${name}, left by a run on this host that no longer exists`);
    try {
      if (!(await connect((c) => dropScratchDatabase(c, name, comment)))) say(`WARNING: ${name} is still present`);
    } catch (e) {
      say(`WARNING: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function loadEnv() {
  // The precedence of src/lib/load-env.ts: exported > .env.local > .env.
  config({ path: `${ROOT}/.env.local`, quiet: true });
  config({ path: `${ROOT}/.env`, quiet: true });
}

async function cli(argv) {
  loadEnv();
  const superuserUrl = process.env.MIGRATION_DATABASE_URL;
  if (!superuserUrl) {
    log("MIGRATION_DATABASE_URL must name a superuser on the cluster to create the scratch database on (set it in .env)");
    return 1;
  }
  const maintenanceUrl = urlFor(superuserUrl, "postgres");
  const name = scratchDatabaseName();
  const scratchUrl = urlFor(superuserUrl, name);
  const connect = (fn) => withClient(maintenanceUrl, fn);
  const marker = scratchMarker({ host: hostname(), pid: process.pid, createdAt: new Date() });
  const scratch = scratchDatabaseLifecycle({ name, marker, connect, openKeeper: () => openPgKeeper(scratchUrl) });
  const redis = scratchRedisLifecycle({
    url: process.env.REDIS_URL,
    sentinel: process.env.REDIS_SENTINEL === "true",
    marker,
    openKeeper: openRedisKeeper,
  });
  const keeperLost = () => {
    if (scratch.keeperLost()) {
      throw new Error(`the keeper connection to ${name} ended; another run's sweep may have taken the database for a dead run's`);
    }
    if (redis.keeperLost()) {
      throw new Error("the keeper connection to the claimed Redis database ended; another run's sweep may have flushed it");
    }
  };

  return runWithScratchDatabase({
    name,
    drop: async () => {
      // Both, whichever fails: a Redis claim left behind blocks no one but
      // holds the suite's keys until the next run's sweep.
      let redisReleased = false;
      try {
        redisReleased = await redis.release();
      } catch (e) {
        log(`releasing the Redis database failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return (await scratch.drop()) && redisReleased;
    },
    main: async ({ run, checkInterrupted }) => {
      await sweepStale(connect);
      checkInterrupted();
      log(`creating scratch database ${name}`);
      await scratch.create();
      checkInterrupted();
      const redisUrl = await redis.claim();
      const env = {
        ...process.env,
        ...scratchDatabaseEnv(process.env, name),
        ...(redisUrl ? { REDIS_URL: redisUrl, [REDIS_CLAIM_ENV]: marker } : {}),
      };
      checkInterrupted();
      const rolesBefore = await withClient(scratchUrl, async (c) => (await c.query(ROLE_STATE_SQL)).rows);
      await withClient(scratchUrl, async (c) => {
        await c.query("BEGIN");
        try {
          await applyPrivilegeSequence(c, loadDeniedPolicy());
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        }
      });
      checkInterrupted();
      if ((await run("npx", ["prisma", "migrate", "deploy"], env)) !== 0) throw new Error("prisma migrate deploy failed");
      if ((await run(process.execPath, ["scripts/bootstrap-rds-roles.mjs", "--denied-only"], env)) !== 0) {
        throw new Error("bootstrap-rds-roles.mjs --denied-only failed");
      }
      const rolesAfter = await withClient(scratchUrl, async (c) => (await c.query(ROLE_STATE_SQL)).rows);
      const problems = roleStateProblems(rolesBefore, rolesAfter);
      if (problems.length > 0) {
        throw new Error(
          [
            "the cluster-global state of the existing roles could not be shown unchanged by preparing the scratch database:",
            ...problems.map((c) => `  ${c}`),
            "Roles are shared by every database on the cluster, the dev database included. The roles must exist before",
            "the run (initdb locally; bootstrap-rds-roles.mjs, then one `prisma migrate deploy`, in CI), and a migration",
            "that changes them must converge to the state an already-migrated cluster has.",
          ].join("\n"),
        );
      }
      if ((await run("npm", ["run", "--silent", "db:check-drift"], env)) !== 0) {
        throw new Error("schema.prisma does not match the migrated scratch database (npm run db:check-drift)");
      }
      keeperLost();
      const status = await run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts", ...argv], env);
      keeperLost();
      return status;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (e) => {
      log(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
