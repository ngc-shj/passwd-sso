/**
 * An owner-shaped probe role: what the migration role is on RDS, where it is
 * neither SUPERUSER nor BYPASSRLS, so SECURITY DEFINER bodies and operator
 * scripts that run as it are subject to row-level security. In dev and CI the
 * migration role is a superuser, so a cell that wants the RDS shape connects
 * (or swaps a routine's owner) as this role instead.
 *
 * The probe is `NOLOGIN NOSUPERUSER NOBYPASSRLS` and a member of the role that
 * owns the tables, so it holds exactly the owner's privileges by inheritance
 * and nothing is listed by hand. Nothing is ever made a member of the probe,
 * and it holds no ACL entries of its own, so DROP ROLE removes it.
 *
 * Roles are cluster-global: callers drop the probe in `finally`, and a sweep at
 * creation removes the leftovers of runs that never reached theirs.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { superuserConnectionString } from "./helpers";
import { PROBE_ROLE_PREFIX, probeRoleName, staleProbeRoles } from "./probe-role-names";
import { recordRoleAttributes } from "./rls-grant-evidence-recorder";

export type ProbeRole = {
  name: string;
  /** The superuser URL whose sessions run as the probe: `options=-c role=<probe>`. */
  connectionString: string;
  drop: () => Promise<void>;
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `connectionString` with the startup option `-c role=<role>` appended (URL-encoded). */
export function connectionStringAsRole(connectionString: string, role: string): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  url.searchParams.set("options", `${existing ? `${existing} ` : ""}-c role=${role}`);
  // URLSearchParams writes a space as `+`; %20 is read the same by every pg parser.
  url.search = url.searchParams.toString().replace(/\+/g, "%20");
  return url.toString();
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
    await client.query(
      `CREATE ROLE ${quoteIdent(name)} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${quoteIdent(owners[0].tableowner)}`,
    );
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
      const { rows: attrs } = await client.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
        [name],
      );
      recordRoleAttributes(attrs);
    } catch (error) {
      await drop();
      throw error;
    }
    return { name, connectionString: connectionStringAsRole(superuserUrl, name), drop };
  } finally {
    await client.end();
  }
}
