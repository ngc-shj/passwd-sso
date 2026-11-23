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
//      by the role MIGRATION_DATABASE_URL names; see staleScratchDatabases);
//   2. CREATE DATABASE <passwd_it_…> TEMPLATE template0 on the cluster
//      MIGRATION_DATABASE_URL names (a superuser), empty: never a copy of the
//      dev database, whose data is the problem. COMMENT ON DATABASE sets the
//      marker setup.ts requires, with a nonce only this run holds
//      (scripts/lib/integration-scratch-db.mjs);
//   3. the per-database half of scripts/bootstrap-rds-roles.mjs
//      (applyPrivilegeSequence: passwd_app's CONNECT/schema/table grants and
//      default privileges, the worker roles' schema privileges), BEFORE the
//      migrations — where initdb and the RDS bootstrap put it — so the
//      migrations' own grants and revokes land on top, as in dev and
//      production. Role creation and passwords are cluster-global and are not
//      touched: the roles must already exist (dev: initdb; CI: the full
//      bootstrap in the step before this one);
//   4. `prisma migrate deploy`, then `bootstrap-rds-roles.mjs --denied-only`
//      (the must-never-be-granted policy, every target required);
//   5. the cluster-global state of the existing passwd_* roles (attributes,
//      password, connection limit, memberships, cluster-wide settings) must
//      be unchanged by 3–4. The migrations re-run their role statements on
//      every new database; on a cluster that already ran them they are no-ops,
//      and this check holds that rather than assuming it. CI, whose cluster is
//      created for the job, sets INTEGRATION_ALLOW_CLUSTER_ROLE_CHANGES=1;
//   6. `npm run db:check-drift` against the scratch database;
//   7. vitest with vitest.integration.config.ts and the arguments given, with
//      DATABASE_URL, MIGRATION_DATABASE_URL and every *_DATABASE_URL in the
//      environment pointed at the scratch database;
//   8. drop it (WITH (FORCE), which terminates its connections) and confirm
//      it is gone — only if step 2's CREATE succeeded, and only while the
//      database is still owned by this role and carries this run's exact
//      marker (dropScratchDatabase). Anything else is reported, not dropped.
//
// Step 8 runs however the run ends. Once it starts, INT/TERM/HUP are ignored
// (the handlers stay installed, so they cannot kill the process mid-drop); a
// signal before that is forwarded to the running child (a second one kills
// it) and the run goes straight to step 8. A drop that fails, or a database
// still present after it, prints INTEGRATION_CLEANUP_INCOMPLETE and exits
// nonzero even when every test passed. SIGKILL is irreducible: step 1 of the
// next run on this host removes what it left.
//
// Exit: vitest's status; 128+n after signal n; 1 for a setup or cleanup
// failure.

import { spawn } from "node:child_process";
import { constants as osConstants, hostname } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { applyPrivilegeSequence, loadDeniedPolicy } from "./bootstrap-rds-roles.mjs";
import {
  dropScratchDatabase,
  scratchDatabaseEnv,
  scratchDatabaseName,
  scratchMarker,
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
      `INTEGRATION_CLEANUP_INCOMPLETE ${name} was not dropped; check its owner and comment, and drop it by hand (DROP DATABASE … WITH (FORCE), as the superuser) only if this run created it`,
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
 * The scratch database's create and drop. drop() removes only what create()
 * made: nothing when CREATE did not succeed (a database of that name that
 * already existed is someone else's), and otherwise only through
 * dropScratchDatabase, expecting the marker once COMMENT succeeded and no
 * comment before that.
 *
 * @param {{
 *   name: string,
 *   marker: string,
 *   connect: <T>(fn: (c: { query: Function, escapeLiteral: (s: string) => string }) => Promise<T>) => Promise<T>,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function scratchDatabaseLifecycle({ name, marker, connect, log: say = log }) {
  let created = false;
  let comment = null;
  return {
    create: () =>
      connect(async (c) => {
        await c.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
        created = true;
        await c.query(`COMMENT ON DATABASE "${name}" IS ${c.escapeLiteral(marker)}`);
        comment = marker;
      }),
    drop: async () => {
      if (!created) {
        say(`${name} was not created by this run; nothing to drop`);
        return true;
      }
      return connect((c) => dropScratchDatabase(c, name, comment));
    },
  };
}

function urlFor(base, database) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
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
  const scratch = scratchDatabaseLifecycle({
    name,
    marker: scratchMarker({ host: hostname(), pid: process.pid, createdAt: new Date() }),
    connect,
  });
  const env = { ...process.env, ...scratchDatabaseEnv(process.env, name) };
  const allowRoleChanges = process.env.INTEGRATION_ALLOW_CLUSTER_ROLE_CHANGES === "1";

  return runWithScratchDatabase({
    name,
    drop: scratch.drop,
    main: async ({ run, checkInterrupted }) => {
      await sweepStale(connect);
      checkInterrupted();
      log(`creating scratch database ${name}`);
      await scratch.create();
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
      const changed = roleStateChanges(rolesBefore, rolesAfter);
      if (changed.length > 0 && !allowRoleChanges) {
        throw new Error(
          [
            "preparing the scratch database changed cluster-global state of existing roles:",
            ...changed.map((c) => `  ${c}`),
            "Roles are shared by every database on the cluster, the dev database included. A migration changed them;",
            "find which, and make it converge to the state an already-migrated cluster has.",
          ].join("\n"),
        );
      }
      if ((await run("npm", ["run", "--silent", "db:check-drift"], env)) !== 0) {
        throw new Error("schema.prisma does not match the migrated scratch database (npm run db:check-drift)");
      }
      return run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts", ...argv], env);
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
