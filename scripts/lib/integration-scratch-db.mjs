// The scratch database an integration run uses: one per run, created empty by
// scripts/run-integration-tests.mjs and dropped when the run ends. The
// harness (src/__tests__/db-integration/setup.ts) refuses any database that
// does not carry both the name prefix and the marker comment, so the suite
// can no longer write to the dev database a live instance and the compose
// workers use, or inherit rows an earlier crashed run left there.
//
// The marker is a COMMENT ON DATABASE: only the owner or a superuser can set
// it, CREATE DATABASE … TEMPLATE does not copy it, and every role can read it
// back (pg_shdescription is world-readable), the app role setup.ts probes as
// included. The name prefix alone would be a convention anyone can match by
// accident; the comment is a deliberate act.
//
// Neither is proof that a run made the database: any role with CREATEDB can
// create a database of that name and comment on it. What only the runner (or
// a principal already able to drop anything) can produce is a database OWNED
// by the role the runner connects as. The runner therefore drops a database
// only through dropScratchDatabase, which requires that owner and the exact
// comment it expects; the comment carries a per-run nonce so the expectation
// names one run's database, not any scratch-shaped one.

import { randomBytes } from "node:crypto";

export const SCRATCH_DB_PREFIX = "passwd_it_";
export const SCRATCH_DB_MARKER = "passwd-sso integration scratch database";
/** application_name of the connection a run holds to its own scratch database. */
export const SCRATCH_DB_KEEPER = "passwd-sso-integration-keeper";

const NAME_PATTERN = new RegExp(`^${SCRATCH_DB_PREFIX}\\d{14}_\\d+_[0-9a-f]{8}$`);
const MARKER_PATTERN = new RegExp(
  `^${SCRATCH_DB_MARKER} \\(host=(\\S+) pid=(\\d+) created=(\\S+) nonce=([0-9a-f]{32})\\)$`,
);
const URL_KEY = /^(?:[A-Z0-9_]+_)?DATABASE_URL$/;

/** passwd_it_<UTC yyyymmddhhmmss>_<pid>_<8 hex>: unique per run, under 63 bytes. */
export function scratchDatabaseName(
  now = new Date(),
  pid = process.pid,
  suffix = randomBytes(4).toString("hex"),
) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${SCRATCH_DB_PREFIX}${stamp}_${pid}_${suffix}`;
}

/** Whether `name` is one scratchDatabaseName could have produced. */
export function isScratchDatabaseName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

/**
 * The comment the runner sets; host and pid let a later run find its
 * leftovers, the nonce ties it to the one run that holds the whole string.
 */
export function scratchMarker({ host, pid, createdAt, nonce = randomBytes(16).toString("hex") }) {
  return `${SCRATCH_DB_MARKER} (host=${host} pid=${pid} created=${createdAt.toISOString()} nonce=${nonce})`;
}

/** { host, pid } of a marker comment, or null when the comment is not one. */
export function parseScratchMarker(comment) {
  const m = typeof comment === "string" ? MARKER_PATTERN.exec(comment) : null;
  return m ? { host: m[1], pid: Number(m[2]) } : null;
}

/**
 * Why the harness must not run on this database, or null when it is a
 * scratch database. Both signals are required.
 */
export function scratchDatabaseRefusal(name, comment) {
  if (!isScratchDatabaseName(name)) {
    return `database "${name}" is not a scratch integration database (its name does not match ${SCRATCH_DB_PREFIX}<stamp>_<pid>_<hex>)`;
  }
  if (!parseScratchMarker(comment)) {
    return `database "${name}" does not carry the scratch marker comment ("${SCRATCH_DB_MARKER} (…)")`;
  }
  return null;
}

/**
 * The key holding the scratch marker in the Redis logical database a run
 * claims (scripts/run-integration-tests.mjs). Here rather than there
 * because setup.ts checks it and loads only this module.
 */
export const REDIS_CLAIM_KEY = "passwd-sso:integration-scratch";

/**
 * Why the harness must not use the Redis database it is connected to, or null
 * when the database carries a scratch claim. `claim` is the claim key's value.
 */
export function scratchRedisRefusal(claim, { sentinel = false } = {}) {
  if (sentinel) {
    return "REDIS_SENTINEL is true: the Sentinel client ignores REDIS_URL's database index, so the suite would share the live keyspace";
  }
  if (!parseScratchMarker(claim)) {
    return `the Redis database REDIS_URL selects does not carry the scratch claim (${REDIS_CLAIM_KEY}); it may be the live instance's`;
  }
  return null;
}

/**
 * Every DATABASE_URL / *_DATABASE_URL in env, pointed at `database` on the
 * same host, port and credentials. Generic over the key rather than a list,
 * so a role URL added to the harness later cannot keep naming the dev
 * database; one left unset is derived from DATABASE_URL by helpers.ts.
 */
export function scratchDatabaseEnv(env, database) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!URL_KEY.test(key) || !value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${key} is not a connection URL`);
    }
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error(`${key} is not a postgres connection URL`);
    }
    url.pathname = `/${database}`;
    out[key] = url.toString();
  }
  return out;
}

/**
 * The scratch databases a dead run on this host left behind: owned by the
 * role the runner connects as, marked, created here by a pid that no longer
 * exists, and with no connection. A database another role owns is never
 * chosen, whatever its name and comment say. Each comes with the comment it
 * was chosen by, for dropScratchDatabase to require.
 *
 * The pid alone cannot tell a live run from a dead one: a run in another PID
 * namespace with the same hostname (a container sharing the host's UTS
 * namespace) has a pid this process cannot see. What does is the connection
 * count: a run holds a keeper connection (SCRATCH_DB_KEEPER) to its database
 * from before COMMENT sets the marker until just before its own drop, so a
 * marked database of a live run always has one, between steps included.
 *
 * @param {{ name: string, owner: string, comment: string | null, connections: number }[]} rows
 * @param {{ role: string, host: string, isAlive: (pid: number) => boolean }} self
 * @returns {{ name: string, comment: string }[]}
 */
export function staleScratchDatabases(rows, { role, host, isAlive }) {
  return rows
    .filter((r) => {
      if (r.owner !== role) return false;
      if (scratchDatabaseRefusal(r.name, r.comment) !== null || r.connections > 0) return false;
      const marker = parseScratchMarker(r.comment);
      return marker.host === host && !isAlive(marker.pid);
    })
    .map((r) => ({ name: r.name, comment: r.comment }));
}

export class ScratchDropRefused extends Error {}

/**
 * Drop scratch database `name` as the role `client` is connected as, only if
 * that role owns it and its comment is exactly `expectedComment` (null: none).
 * Returns true when the database is gone (including when it was already
 * absent), false when it is still present after the drop; throws
 * ScratchDropRefused, naming the database, when it is not provably this
 * caller's.
 *
 * Verification and DROP are two statements (DROP DATABASE cannot run in a
 * transaction block), on one session. In between, the owner, the comment and
 * the name can be changed only by the owner (the verified role) or a
 * superuser — COMMENT, ALTER … OWNER and RENAME all require ownership, and
 * renaming another database onto this name requires this one renamed away
 * first. Anyone who can do that can already drop the database themselves.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount: number | null }> }} client
 */
export async function dropScratchDatabase(client, name, expectedComment) {
  if (!isScratchDatabaseName(name)) throw new ScratchDropRefused(`refusing to drop "${name}": not a scratch database name`);
  const { rows } = await client.query(
    `SELECT pg_get_userbyid(d.datdba) AS owner, current_user AS self,
            shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_database d WHERE d.datname = $1`,
    [name],
  );
  if (rows.length === 0) return true;
  const [{ owner, self, comment }] = rows;
  if (owner !== self) {
    throw new ScratchDropRefused(`refusing to drop "${name}": it is owned by another role, not ${self}`);
  }
  if (comment !== expectedComment) {
    throw new ScratchDropRefused(`refusing to drop "${name}": its comment is not this run's marker`);
  }
  await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rowCount === 0;
}
