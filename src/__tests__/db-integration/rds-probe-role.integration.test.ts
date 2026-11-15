/**
 * The owner-shaped probe role (rds-probe-role.ts): a login whose
 * `current_user` is a NOSUPERUSER NOBYPASSRLS member of the table owner that
 * cannot become the owner, which is the principal the migration role is on RDS. Every RDS-shaped cell relies
 * on these properties, so they are asserted here once rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createPool, createPrismaClient } from "@/lib/db/pool-factory";
import { defineGrant, setBypassGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";
import {
  assertRlsApplies,
  createTestContext,
  expectBypassRefusal,
  superuserConnectionString,
  type TestContext,
} from "./helpers";
import { probeRoleName } from "./probe-role-names";
import { createProbeRole, type ProbeRole } from "./rds-probe-role";
import { ROLE_ATTRIBUTES_SQL, type RoleAttributes } from "./rls-grant-evidence-recorder";

// Omits users; not a production member's pair, which a refusal cell must not credit.
const TENANT_AND_SESSIONS = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "session"]);
const USERS_AND_TENANTS = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "user"]);

async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: superuserConnectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const roleNames = (like: string) =>
  withSuperuser(async (c) => (await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [like])).rows.map((r) => r.rolname));

describe("owner-shaped probe role", () => {
  let ctx: TestContext;
  let probe: ProbeRole;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    probe = await createProbeRole();
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    try {
      await ctx.deleteTestData(tenantId);
      await ctx.cleanup();
    } finally {
      await probe.drop();
    }
  });

  it("a pool built on its URL logs in as the probe, which RLS applies to", async () => {
    const pool = createPool({ connectionString: probe.connectionString, max: 1 });
    const prisma = createPrismaClient(pool, {}, { ownsPool: true });
    try {
      await assertRlsApplies(prisma);
      const [who] = await prisma.$queryRawUnsafe<{ current_user: string; session_user: string }[]>(
        `SELECT current_user, session_user`,
      );
      expect(who.current_user).toBe(probe.name);
      expect(who.session_user).toBe(probe.name);
      const [attrs] = await prisma.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]>(
        `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
        probe.name,
      );
      expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("holds the owner's privileges: it reads a seeded user under a grant naming users, and sees none without one", async () => {
    const pool = createPool({ connectionString: probe.connectionString, max: 1 });
    const prisma = createPrismaClient(pool, {}, { ownsPool: true });
    try {
      const outside = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM users WHERE id = $1::uuid`, userId);
      expect(outside).toEqual([]);
      const granted = await prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, USERS_AND_TENANTS);
        return tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM users WHERE id = $1::uuid`, userId);
      });
      expect(granted).toEqual([{ id: userId }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("a bypass whose grant omits users is refused on its connection, naming users", async () => {
    const pool = createPool({ connectionString: probe.connectionString, max: 1 });
    const prisma = createPrismaClient(pool, {}, { ownsPool: true });
    try {
      const { notices, table } = await expectBypassRefusal(() =>
        prisma.$transaction(async (tx) => {
          await setBypassGucs(tx, TENANT_AND_SESSIONS);
          return tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = $1::uuid`, userId);
        }),
      );
      expect(table).toBe("users");
      expect(notices).toEqual([{ table: "users", purpose: BYPASS_PURPOSE.SYSTEM_MAINTENANCE }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("a session logged in as the probe cannot become the owner or a superuser", async () => {
    const owner = (await withSuperuser((c) => c.query<{ tableowner: string }>(`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`))).rows[0].tableowner;
    const client = new Client({ connectionString: probe.connectionString });
    await client.connect();
    try {
      const denied = async (sql: string, values?: unknown[]) => {
        await expect(client.query(sql, values)).rejects.toMatchObject({ code: "42501" });
      };
      await denied(`SET ROLE "${owner}"`);
      await denied(`SET SESSION AUTHORIZATION "${owner}"`);
      await denied(`SELECT set_config('role', $1, false)`, [owner]);
      const { rows } = await client.query<{ current_user: string; session_user: string }>(`SELECT current_user, session_user`);
      expect(rows).toEqual([{ current_user: probe.name, session_user: probe.name }]);
    } finally {
      await client.end();
    }
  });

  it("holds its owner membership with INHERIT and without SET", async () => {
    const rows = await withSuperuser(async (c) =>
      (await c.query<{ inherit_option: boolean; set_option: boolean }>(
        `SELECT m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
        [probe.name],
      )).rows,
    );
    expect(rows).toEqual([{ inherit_option: true, set_option: false }]);
  });

  // The positive control for `canSetRole`: without it, "the probe reads false"
  // would also hold for an expression that is always false.
  it("the attribute query tells a role that can change role from one that cannot", async () => {
    const tag = randomBytes(4).toString("hex");
    const name = (kind: string) => `attr_ctl_${tag}_${kind}`;
    const rows = await withSuperuser(async (c) => {
      await c.query("BEGIN");
      try {
        for (const kind of ["group", "settable", "inherit_only", "admin_only", "other", "admin_holder", "inherits_admin"]) {
          await c.query(`CREATE ROLE "${name(kind)}" NOLOGIN`);
        }
        await c.query(`CREATE ROLE "${name("creator")}" NOLOGIN CREATEROLE`);
        await c.query(`GRANT "${name("group")}" TO "${name("settable")}" WITH INHERIT FALSE, SET TRUE`);
        await c.query(`GRANT "${name("group")}" TO "${name("inherit_only")}" WITH INHERIT TRUE, SET FALSE`);
        await c.query(`GRANT "${name("group")}" TO "${name("admin_only")}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        // ADMIN reached through an inherited membership: inherits_admin can
        // grant itself SET on "other" although its own membership has neither.
        await c.query(`GRANT "${name("other")}" TO "${name("admin_holder")}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await c.query(`GRANT "${name("admin_holder")}" TO "${name("inherits_admin")}" WITH INHERIT TRUE, SET FALSE`);
        const names = ["group", "settable", "inherit_only", "admin_only", "creator", "inherits_admin"].map(name);
        return (await c.query<RoleAttributes>(ROLE_ATTRIBUTES_SQL, [names])).rows;
      } finally {
        await c.query("ROLLBACK");
      }
    });
    expect(Object.fromEntries(rows.map((r) => [r.name.slice(`attr_ctl_${tag}_`.length), r.canSetRole]))).toEqual({
      group: false,
      settable: true,
      inherit_only: false,
      admin_only: true,
      creator: true,
      inherits_admin: true,
    });
  });

  it("drop removes the role, and creating another sweeps only probes older than an hour", async () => {
    const hex = () => randomBytes(6).toString("hex");
    const stale = probeRoleName(Date.now() - 2 * MS_PER_HOUR, hex());
    const fresh = probeRoleName(Date.now() - 5 * MS_PER_MINUTE, hex());
    const malformed = `rls_probe_not_a_probe_${hex()}`;
    await withSuperuser(async (c) => {
      for (const name of [stale, fresh, malformed]) await c.query(`CREATE ROLE "${name}" NOLOGIN`);
    });
    let second: ProbeRole | undefined;
    try {
      second = await createProbeRole();
      const left = await roleNames("rls\\_probe\\_%");
      expect(left).not.toContain(stale);
      expect(left).toContain(fresh);
      expect(left).toContain(malformed);
      expect(left).toContain(second.name);
      expect(left).toContain(probe.name);

      await second.drop();
      expect(await roleNames(second.name)).toEqual([]);
      second = undefined;
    } finally {
      await second?.drop();
      await withSuperuser(async (c) => {
        for (const name of [stale, fresh, malformed]) await c.query(`DROP ROLE IF EXISTS "${name}"`);
      });
    }
    // The first probe was not the sweep's to remove.
    expect(await roleNames(probe.name)).toEqual([probe.name]);
  });
});
