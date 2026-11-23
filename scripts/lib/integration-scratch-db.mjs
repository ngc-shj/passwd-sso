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

import { randomBytes } from "node:crypto";

export const SCRATCH_DB_PREFIX = "passwd_it_";
export const SCRATCH_DB_MARKER = "passwd-sso integration scratch database";

const NAME_PATTERN = new RegExp(`^${SCRATCH_DB_PREFIX}\\d{14}_\\d+_[0-9a-f]{8}$`);
const MARKER_PATTERN = new RegExp(
  `^${SCRATCH_DB_MARKER} \\(host=(\\S+) pid=(\\d+) created=(\\S+)\\)$`,
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

/** The comment the runner sets; host and pid let a later run find its leftovers. */
export function scratchMarker({ host, pid, createdAt }) {
  return `${SCRATCH_DB_MARKER} (host=${host} pid=${pid} created=${createdAt.toISOString()})`;
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
 * The scratch databases a dead run on this host left behind: marked, created
 * here by a pid that no longer exists, and with no connection. A database of
 * a live run (here or on another host sharing the cluster) is never chosen.
 *
 * @param {{ name: string, comment: string | null, connections: number }[]} rows
 * @param {{ host: string, isAlive: (pid: number) => boolean }} self
 */
export function staleScratchDatabases(rows, { host, isAlive }) {
  return rows
    .filter((r) => {
      if (scratchDatabaseRefusal(r.name, r.comment) !== null || r.connections > 0) return false;
      const marker = parseScratchMarker(r.comment);
      return marker.host === host && !isAlive(marker.pid);
    })
    .map((r) => r.name);
}
