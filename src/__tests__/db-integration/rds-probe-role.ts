/**
 * An owner-shaped probe role: what the migration role is on RDS, where it is
 * neither SUPERUSER nor BYPASSRLS, so SECURITY DEFINER bodies and operator
 * scripts that run as it are subject to row-level security. In dev and CI the
 * migration role is a superuser, so a cell that wants the RDS shape connects
 * as this role (or swaps a routine's owner to it) instead.
 *
 * The probe is `LOGIN NOSUPERUSER NOBYPASSRLS` and holds the role that owns the
 * tables with `INHERIT TRUE, SET FALSE`: it has exactly the owner's privileges
 * by inheritance and nothing is listed by hand, yet it cannot `SET ROLE` to the
 * owner, so a session that logs in as the probe stays the probe. That is what
 * lets the grant evidence record (rls-grant-evidence-recorder.ts) credit the
 * login user without reading statements. Nothing is ever made a member of the
 * probe, and it holds no ACL entries of its own, so DROP ROLE removes it.
 *
 * Inheriting the owner makes the probe the owner of the tables (and, where the
 * owner is a superuser, as in dev and CI, of everything the bootstrap role
 * owns): it could add a policy that admits every row, turn FORCE off, or
 * replace a function body, and row-level security would stop applying to what
 * it runs. A cell that uses the probe therefore issues no DDL on the owner's
 * objects (a policy, a table, a function); nothing checks this but review.
 *
 * Roles are cluster-global: callers drop the probe in `finally`, and a sweep at
 * creation removes the leftovers of runs that never reached theirs.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { superuserConnectionString } from "./helpers";
import { PROBE_ROLE_MAX_AGE_MS, PROBE_ROLE_PREFIX, probeRoleName, staleProbeRoles } from "./probe-role-names";
import { ROLE_ATTRIBUTES_SQL, recordRoleAttributes, type RoleAttributes } from "./rls-grant-evidence-recorder";

export type ProbeRole = {
  name: string;
  /** The superuser URL with the probe as its login user: same host, port and database. */
  connectionString: string;
  drop: () => Promise<void>;
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function createProbeRole(): Promise<ProbeRole> {
  const superuserUrl = superuserConnectionString();
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    const { rows: self } = await client.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    if (!self[0]?.rolsuper) {
      throw new Error("the probe role is created through MIGRATION_DATABASE_URL, which must name a superuser");
    }

    const { rows: existing } = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE $1`,
      [`${PROBE_ROLE_PREFIX.replace(/_/g, "\\_")}%`],
    );
    for (const leftover of staleProbeRoles(existing.map((r) => r.rolname), Date.now())) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(leftover)}`);
    }

    const { rows: owners } = await client.query<{ tableowner: string }>(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`,
    );
    if (owners.length !== 1) throw new Error("could not read the owner of public.users");

    const name = probeRoleName(Date.now(), randomBytes(6).toString("hex"));
    // DDL cannot bind the password, so it is interpolated: 32 hex characters,
    // which need no escaping. The harness neither logs it nor writes it to
    // disk; a server that logs DDL records the statement, for a role the file
    // drops when it ends.
    const password = randomBytes(16).toString("hex");
    // One transaction, so a failed GRANT leaves no login role behind; and the
    // password stops working after the sweep's age limit should a run never
    // reach its drop.
    const validUntil = new Date(Date.now() + PROBE_ROLE_MAX_AGE_MS).toISOString();
    await client.query("BEGIN");
    try {
      await client.query(
        `CREATE ROLE ${quoteIdent(name)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}' VALID UNTIL '${validUntil}'`,
      );
      await client.query(`GRANT ${quoteIdent(owners[0].tableowner)} TO ${quoteIdent(name)} WITH INHERIT TRUE, SET FALSE`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const drop = async () => {
      const dropper = new Client({ connectionString: superuserUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP ROLE IF EXISTS ${quoteIdent(name)}`);
      } finally {
        await dropper.end();
      }
    };
    try {
      const { rows: attrs } = await client.query<RoleAttributes>(ROLE_ATTRIBUTES_SQL, [[name]]);
      recordRoleAttributes(attrs);
    } catch (error) {
      await drop();
      throw error;
    }
    const url = new URL(superuserUrl);
    url.username = name;
    url.password = password;
    return { name, connectionString: url.toString(), drop };
  } finally {
    await client.end();
  }
}
