/**
 * #1009 (C1): the retention GC worker's TeamMemberKey prune, end to end on the
 * real database — sweepOnce with the flag on, on the worker role's connection,
 * through the team_member_key_prune SECURITY DEFINER function.
 *
 * Every reference cell asserts by (team, version), never by a count: the
 * prune is global (it sweeps every team of the database, the developer's dev
 * data included — RT11), so a cell only reads its own team. Each has a
 * positive control in the same team: an unreferenced old version that IS
 * pruned, so a prune that did nothing cannot pass.
 *
 * Race cells: production sweepOnce (connection B) runs while a writer
 * (connection A, a held Prisma interactive transaction) has moved a
 * reference but not committed; the prune's single statement reads one
 * snapshot, so the version survives. The negative control runs a two-
 * statement check-then-delete straddling A's commit and loses the version,
 * which shows the harness can observe a loss.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  createTestContext,
  appConnectionString,
  expectBypassNotices,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createRaceHelpers, holdPrismaWriter } from "./race-helpers";
import { sweepOnce } from "@/workers/retention-gc-worker/sweep";
import { BYPASS_GRANT, defineGrant, setBypassGucs, type BypassGrant } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

const BATCH = 1000;
const MAX_TICKS = 20;
const HOLD_TIMEOUT_MS = 60_000;
const PRUNE_GRANT = BYPASS_GRANT.RETENTION_TEAM_KEY_PRUNE;
const OTHER_GRANT = defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["user"]);
const REFERENCE_COLUMNS = [
  "e.team_key_version",
  "h.team_key_version",
  "a.key_version",
  "a.encryption_mode = 0",
  "t.team_key_version",
] as const;

type PruneRow = { pruned_tenant_id: string; pruned_team_id: string; pruned_key_version: number; pruned_user_ids: string[] };

const hex = (n: number) => randomBytes(n).toString("hex");

/** Thrown inside a transaction to roll it back after the cell observed it. */
class Rollback extends Error {}

describe("team key prune (#1009)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantId = await ctx.createTenant();
    userA = await ctx.createUser(tenantId);
    userB = await ctx.createUser(tenantId);
  });

  afterAll(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.cleanup();
  });

  async function sql(text: string, ...params: unknown[]): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(text, ...params);
    });
  }

  async function rows<T>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** A team at `version` whose holders each hold every version 1..version. */
  async function seedTeam(version: number, holders: string[] = [userA, userB]): Promise<string> {
    const teamId = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, now(), now())`,
      teamId, tenantId, `prune-${teamId.slice(0, 8)}`, version,
    );
    for (const userId of holders) {
      for (let v = 1; v <= version; v++) {
        await sql(
          `INSERT INTO team_member_keys (
             id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
             ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
          randomUUID(), teamId, tenantId, userId, hex(32), hex(12), hex(16), hex(32), hex(32), v,
        );
      }
    }
    return teamId;
  }

  async function seedEntry(teamId: string, teamKeyVersion: number, itemKeyTeamKeyVersion = 0): Promise<string> {
    const entryId = randomUUID();
    await sql(
      `INSERT INTO team_password_entries (
         id, team_id, tenant_id, created_by_id, updated_by_id,
         encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
         team_key_version, item_key_team_key_version, entry_type, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $5, $6, $7, $8, $9, 'LOGIN', now(), now())`,
      entryId, teamId, tenantId, userA, hex(32), hex(12), hex(16), teamKeyVersion, itemKeyTeamKeyVersion,
    );
    return entryId;
  }

  async function seedHistory(entryId: string, teamKeyVersion: number): Promise<string> {
    const historyId = randomUUID();
    await sql(
      `INSERT INTO team_password_entry_histories (
         id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, changed_by_id, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, now())`,
      historyId, entryId, tenantId, hex(32), hex(12), hex(16), teamKeyVersion, userA,
    );
    return historyId;
  }

  async function seedAttachment(entryId: string, mode: number, keyVersion: number | null): Promise<void> {
    await sql(
      `INSERT INTO attachments (
         id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
         key_version, encryption_mode, tenant_id, team_password_entry_id, created_by_id, created_at
       ) VALUES ($1::uuid, 'a.bin', 'application/octet-stream', 1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::uuid, now())`,
      randomUUID(), Buffer.from([1]), hex(12), hex(16), keyVersion, mode, tenantId, entryId, userA,
    );
  }

  /** The team's key versions still present (any holder). */
  async function versions(teamId: string): Promise<number[]> {
    const found = await rows<{ v: number }>(
      `SELECT DISTINCT key_version AS v FROM team_member_keys WHERE team_id = $1::uuid ORDER BY 1`,
      teamId,
    );
    return found.map((r) => Number(r.v));
  }

  /** Production sweepOnce, flag on, until the prune finds nothing; never a failed tick. */
  async function pruneUntilDone(): Promise<void> {
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const counts = await sweepOnce(ctx.retentionWorker.prisma, BATCH, {
        intervalMs: 1,
        emitHeartbeatAudit: false,
        teamKeyPrune: true,
      });
      expect(counts.team_member_keys).not.toBe(-1);
      if (counts.team_member_keys === 0) return;
    }
    throw new Error(`the prune still deleted rows after ${MAX_TICKS} ticks`);
  }

  /** Call the function directly as the worker role, under `grant` or outside any bypass. */
  function callAsWorker<T>(grant: BypassGrant | null, run: (tx: Parameters<Parameters<typeof ctx.retentionWorker.prisma.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
    return ctx.retentionWorker.prisma.$transaction(async (tx) => {
      if (grant) await setBypassGucs(tx, grant);
      return run(tx);
    });
  }

  /** Run `fn` in a worker-role transaction that is rolled back afterwards. */
  async function rolledBack(grant: BypassGrant | null, fn: (tx: Parameters<Parameters<typeof ctx.retentionWorker.prisma.$transaction>[0]>[0]) => Promise<unknown>) {
    await callAsWorker(grant, async (tx) => {
      await fn(tx);
      throw new Rollback();
    }).catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  }

  describe("what keeps a version (each with an unreferenced control that is pruned)", () => {
    it("(a) an entry at k keeps k", async () => {
      const teamId = await seedTeam(3);
      await seedEntry(teamId, 2);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([2, 3]);
    });

    it("(b) an entry at version 0 keeps k = 1", async () => {
      const teamId = await seedTeam(3);
      await seedEntry(teamId, 0);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([1, 3]);
    });

    it("(c) a history row at k keeps k", async () => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      await seedHistory(entryId, 1);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([1, 3]);
    });

    it("(d) a mode-0 attachment at k keeps k", async () => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      await seedAttachment(entryId, 0, 2);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([2, 3]);
    });

    it.each([
      ["(e) NULL", null],
      ["(e') 0", 0],
    ])("%s on a mode-0 attachment keeps k = 1", async (_label, keyVersion) => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      await seedAttachment(entryId, 0, keyVersion);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([1, 3]);
    });

    it.each([1, 2])("(f) a mode-%s attachment's key_version does NOT keep k", async (mode) => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      await seedAttachment(entryId, mode, 2);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([3]);
    });

    it("(g) the current version is kept with no reference at all", async () => {
      const teamId = await seedTeam(3);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([3]);
    });

    it("(h) the re-key marker alone does not keep k", async () => {
      const teamId = await seedTeam(3);
      await seedEntry(teamId, 3, 2);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([3]);
    });

    it("another team's reference does not keep this team's k", async () => {
      const teamId = await seedTeam(3);
      const otherTeam = await seedTeam(3);
      await seedEntry(otherTeam, 2);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([3]);
      expect(await versions(otherTeam)).toEqual([2, 3]);
    });
  });

  it("(i) the batch bounds (team, version) pairs: exactly `batch` pairs go, the rest remain", async () => {
    await pruneUntilDone(); // nothing else in the database is eligible now
    const teamId = await seedTeam(6, [userA]);
    const returned = await callAsWorker(PRUNE_GRANT, (tx) =>
      tx.$queryRawUnsafe<PruneRow[]>(`SELECT * FROM team_member_key_prune(2)`),
    );
    expect(returned.map((r) => [r.pruned_team_id, Number(r.pruned_key_version)])).toEqual([
      [teamId, 1],
      [teamId, 2],
    ]);
    expect(returned.every((r) => r.pruned_user_ids.length === 1 && r.pruned_user_ids[0] === userA)).toBe(true);
    expect(await versions(teamId)).toEqual([3, 4, 5, 6]);
  });

  it("(j) writes one TEAM_MEMBER_KEY_PRUNED row per team with the versions and holders", async () => {
    const teamId = await seedTeam(3);
    await pruneUntilDone();
    const audits = await rows<{ tenant_id: string; payload: Record<string, unknown> }>(
      `SELECT tenant_id, payload FROM audit_outbox
        WHERE payload->>'action' = $1 AND payload->>'teamId' = $2`,
      AUDIT_ACTION.TEAM_MEMBER_KEY_PRUNED, teamId,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].tenant_id).toBe(tenantId);
    expect(audits[0].payload).toMatchObject({
      scope: "TEAM",
      actorType: "SYSTEM",
      teamId,
      targetId: teamId,
      metadata: { keyVersions: [1, 2], rows: 4, holderUserIds: [userA, userB].sort(), holderUserIdsOmitted: 0 },
    });
  });

  describe("the definer function's guards", () => {
    it("refuses outside the RLS bypass (42501)", async () => {
      await expect(
        callAsWorker(null, (tx) => tx.$queryRawUnsafe(`SELECT * FROM team_member_key_prune(1)`)),
      ).rejects.toThrow("TEAM_KEY_PRUNE_REQUIRES_BYPASS");
    });

    it("runs under the production grant, with no report", async () => {
      const notices = await expectBypassNotices(() =>
        rolledBack(PRUNE_GRANT, (tx) => tx.$queryRawUnsafe(`SELECT * FROM team_member_key_prune(1)`)),
      );
      expect(notices).toEqual([]);
    });

    it("runs under a grant that does not name team_member_keys, and reports it (report mode, #921)", async () => {
      const notices = await expectBypassNotices(() =>
        rolledBack(OTHER_GRANT, (tx) => tx.$queryRawUnsafe(`SELECT * FROM team_member_key_prune(1)`)),
      );
      expect(notices).toContainEqual({ table: "team_member_keys", purpose: "system_maintenance" });
    });

    it("refuses a batch below 1", async () => {
      await expect(
        callAsWorker(PRUNE_GRANT, (tx) => tx.$queryRawUnsafe(`SELECT * FROM team_member_key_prune(0)`)),
      ).rejects.toThrow("TEAM_KEY_PRUNE_BATCH");
    });

    it("grants EXECUTE to the worker role only: passwd_app is denied, PUBLIC holds nothing", async () => {
      const app = new Client({ connectionString: appConnectionString() });
      await app.connect();
      try {
        const { rows: [who] } = await app.query<{ name: string }>(`SELECT current_user AS name`);
        expect(who.name).toBe("passwd_app");
        await expect(app.query(`SELECT * FROM team_member_key_prune(1)`)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await app.end();
      }
      const acl = await rows<{ grantee: string }>(
        `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee
           FROM pg_proc p, aclexplode(p.proacl) x
           LEFT JOIN pg_roles r ON r.oid = x.grantee
          WHERE p.oid = 'public.team_member_key_prune(integer)'::regprocedure AND x.privilege_type = 'EXECUTE'`,
      );
      const grantees = acl.map((a) => a.grantee);
      expect(grantees).toContain("passwd_retention_gc_worker");
      expect(grantees).not.toContain("PUBLIC");
      expect(grantees).not.toContain("passwd_app");
    });

    it("the live definition names every reference column (C2's live counterpart)", async () => {
      const [{ def }] = await rows<{ def: string }>(
        `SELECT pg_get_functiondef('public.team_member_key_prune(integer)'::regprocedure) AS def`,
      );
      for (const column of REFERENCE_COLUMNS) expect(def).toContain(column);
      expect(def).not.toContain("item_key_team_key_version");
    });

    it("under an RDS-shaped owner (NOSUPERUSER NOBYPASSRLS, FORCE RLS) the body reads through the caller's bypass, and the grant covers every table it reads", async () => {
      await pruneUntilDone();
      const superuserUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
      const before = await rows<{ owner: string }>(
        `SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = 'public.team_member_key_prune(integer)'::regprocedure`,
      );
      const probe = "tmk_prune_probe_owner";
      const c = new Client({ connectionString: superuserUrl });
      // Report mode: a table the body reads outside the caller's grant raises
      // rls_bypass_not_granted as a WARNING, which this listener collects —
      // the enforce flip (#921) turns the same check into a refusal. (A test
      // cannot redefine rls_bypass_enforced(): routines are created only in
      // migrations, which check-bypass-rls enforces.)
      const notGranted: string[] = [];
      c.on("notice", (n) => {
        const m = /rls_bypass_not_granted table=(\S+)/.exec(n.message ?? "");
        if (m) notGranted.push(m[1]);
      });
      await c.connect();
      try {
        await c.query("BEGIN");
        try {
          await c.query(`CREATE ROLE ${probe} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
          await c.query(`GRANT USAGE ON SCHEMA public TO ${probe}`);
          await c.query(`GRANT SELECT ON teams, team_password_entries, team_password_entry_histories, attachments TO ${probe}`);
          await c.query(`GRANT SELECT, DELETE ON team_member_keys TO ${probe}`);
          await c.query(`GRANT EXECUTE ON FUNCTION public.rls_bypass_enforced(), public.rls_bypass_admits(text) TO ${probe}`);
          await c.query(`ALTER FUNCTION public.team_member_key_prune(integer) OWNER TO ${probe}`);
          for (const table of ["team_member_keys", "teams", "team_password_entries", "team_password_entry_histories", "attachments"]) {
            await c.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
          }
          const teamId = randomUUID();
          await c.query(
            `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3, $3, 3, now(), now())`,
            [teamId, tenantId, `prune-rds-${teamId.slice(0, 8)}`],
          );
          for (let v = 1; v <= 3; v++) {
            await c.query(
              `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
                 ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'k', 'iv', 'tag', 'epk', 'salt', $5, 1, now(), now())`,
              [randomUUID(), teamId, tenantId, userA, v],
            );
          }
          const entryId = randomUUID();
          await c.query(
            `INSERT INTO team_password_entries (id, team_id, tenant_id, created_by_id, updated_by_id, encrypted_blob, blob_iv,
               blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, team_key_version, entry_type, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, 'b', 'iv', 'tag', 'o', 'iv', 'tag', 3, 'LOGIN', now(), now())`,
            [entryId, teamId, tenantId, userA],
          );
          // v2 is kept by a history row, v1 by nothing: the body must see the
          // history table (not only the keys) through the caller's bypass.
          await c.query(
            `INSERT INTO team_password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, changed_by_id, changed_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'b', 'iv', 'tag', 2, $4::uuid, now())`,
            [randomUUID(), entryId, tenantId, userA],
          );
          await c.query(`SET LOCAL ROLE passwd_retention_gc_worker`);
          const setGrant = (tables: string) =>
            c.query(
              `SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', $1, true),
                      set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true),
                      set_config('app.bypass_tables', $2, true)`,
              [PRUNE_GRANT.purpose, tables],
            );

          // Control: a grant missing a table the body reads is reported, by name.
          await c.query("SAVEPOINT missing_table");
          await setGrant(PRUNE_GRANT.tables.split(",").filter((t) => t !== "team_password_entry_histories").join(","));
          await c.query(`SELECT * FROM team_member_key_prune(${BATCH})`);
          expect(notGranted).toContain("team_password_entry_histories");
          await c.query("ROLLBACK TO SAVEPOINT missing_table");
          notGranted.length = 0;

          await setGrant(PRUNE_GRANT.tables);
          const { rows: pruned } = await c.query<PruneRow>(`SELECT * FROM team_member_key_prune(${BATCH})`);
          expect(notGranted).toEqual([]);
          expect(pruned.filter((r) => r.pruned_team_id === teamId).map((r) => Number(r.pruned_key_version))).toEqual([1]);
          await c.query("RESET ROLE"); // the worker role holds no grant on the table itself
          const { rows: left } = await c.query<{ v: number }>(
            `SELECT key_version AS v FROM team_member_keys WHERE team_id = $1::uuid ORDER BY 1`,
            [teamId],
          );
          expect(left.map((r) => Number(r.v))).toEqual([2, 3]);
        } finally {
          await c.query("ROLLBACK");
        }
      } finally {
        await c.end();
      }

      // Nothing leaked: a fresh connection sees the original owner and no probe role.
      const fresh = new Client({ connectionString: superuserUrl });
      await fresh.connect();
      try {
        const { rows: [state] } = await fresh.query<{ enforced: boolean; owner: string; probe: boolean }>(
          `SELECT public.rls_bypass_enforced() AS enforced,
                  (SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.team_member_key_prune(integer)'::regprocedure) AS owner,
                  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS probe`,
          [probe],
        );
        expect(state).toEqual({ enforced: false, owner: before[0].owner, probe: false });
      } finally {
        await fresh.end();
      }
    });
  });

  describe("races: a reference moved by an uncommitted writer (production sweepOnce on B, writer on A)", () => {
    const race = () => createRaceHelpers(ctx.su.pool);

    /** Hold `write` on A, assert A is parked, run B, then commit A. */
    async function duringWriter(write: Parameters<typeof holdPrismaWriter>[1], whileHeld: () => Promise<void>) {
      const writer = await holdPrismaWriter(ctx.su.prisma, async (tx) => {
        await setBypassRlsGucs(tx);
        await write(tx);
      }, HOLD_TIMEOUT_MS);
      try {
        expect(await race().backendState(writer.pid)).toBe("idle in transaction");
        await whileHeld();
        expect(await race().backendState(writer.pid)).toBe("idle in transaction");
      } catch (e) {
        await writer.abort();
        throw e;
      }
      await expect(writer.release()).resolves.toBeUndefined();
    }

    it("restore (entry <- k, history row deleted): k survives", async () => {
      await pruneUntilDone();
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      const historyId = await seedHistory(entryId, 1);
      await duringWriter(
        async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE team_password_entries SET team_key_version = 1 WHERE id = $1::uuid`, entryId);
          await tx.$executeRawUnsafe(`DELETE FROM team_password_entry_histories WHERE id = $1::uuid`, historyId);
        },
        async () => {
          await pruneUntilDone();
          expect(await versions(teamId)).toEqual([1, 3]); // v2, unreferenced, is the positive control
        },
      );
      expect(await rows(`SELECT team_key_version AS v FROM team_password_entries WHERE id = $1::uuid`, entryId)).toEqual([{ v: 1 }]);
      expect(await rows(`SELECT id FROM team_password_entry_histories WHERE id = $1::uuid`, historyId)).toEqual([]);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([1, 3]);
    });

    it("snapshot (history inserted at k, entry -> current): k survives", async () => {
      await pruneUntilDone();
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 1);
      const historyId = randomUUID();
      await duringWriter(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO team_password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, changed_by_id, changed_at)
             SELECT $1::uuid, id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, created_by_id, now()
               FROM team_password_entries WHERE id = $2::uuid`,
            historyId, entryId,
          );
          await tx.$executeRawUnsafe(`UPDATE team_password_entries SET team_key_version = 3 WHERE id = $1::uuid`, entryId);
        },
        async () => {
          await pruneUntilDone();
          expect(await versions(teamId)).toEqual([1, 3]);
        },
      );
      expect(await rows(`SELECT team_key_version AS v FROM team_password_entries WHERE id = $1::uuid`, entryId)).toEqual([{ v: 3 }]);
      expect(await rows(`SELECT team_key_version AS v FROM team_password_entry_histories WHERE id = $1::uuid`, historyId)).toEqual([{ v: 1 }]);
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([1, 3]);
    });

    it("rotation committing between: the version current in B's snapshot survives", async () => {
      await pruneUntilDone();
      const teamId = await seedTeam(3);
      await seedEntry(teamId, 2);
      await duringWriter(
        async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE teams SET team_key_version = 4 WHERE id = $1::uuid`, teamId);
          for (const userId of [userA, userB]) {
            await tx.$executeRawUnsafe(
              `INSERT INTO team_member_keys (id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
                 ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'k', 'iv', 'tag', 'epk', 'salt', 4, 1, now(), now())`,
              randomUUID(), teamId, tenantId, userId,
            );
          }
        },
        async () => {
          await pruneUntilDone();
          // v3 is current (and unreferenced) in B's snapshot; v1 is the control.
          expect(await versions(teamId)).toEqual([2, 3]);
        },
      );
      expect(await rows(`SELECT team_key_version AS v FROM teams WHERE id = $1::uuid`, teamId)).toEqual([{ v: 4 }]);
      expect(await versions(teamId)).toEqual([2, 3, 4]);
      // Once the rotation is visible v3 is an unreferenced old version, which
      // the rule prunes; v4 (now current) and v2 (referenced) stay.
      await pruneUntilDone();
      expect(await versions(teamId)).toEqual([2, 4]);
    });

    /** A two-statement check-then-delete on the superuser connection, each statement its own snapshot. */
    async function twoStatementPrune(teamId: string, first: "entries" | "histories", between: () => Promise<void>) {
      const refs = {
        entries: `SELECT EXISTS (SELECT 1 FROM team_password_entries WHERE team_id = $1::uuid AND team_key_version = 1) AS ref`,
        histories: `SELECT EXISTS (SELECT 1 FROM team_password_entry_histories h JOIN team_password_entries e ON e.id = h.entry_id
                     WHERE e.team_id = $1::uuid AND h.team_key_version = 1) AS ref`,
      };
      const second = first === "entries" ? "histories" : "entries";
      const [one] = await rows<{ ref: boolean }>(refs[first], teamId);
      await between();
      const [two] = await rows<{ ref: boolean }>(refs[second], teamId);
      if (!one.ref && !two.ref) await sql(`DELETE FROM team_member_keys WHERE team_id = $1::uuid AND key_version = 1`, teamId);
    }

    it("negative control (restore shape): a check-then-delete straddling A's commit loses k", async () => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 3);
      const historyId = await seedHistory(entryId, 1);
      const writer = await holdPrismaWriter(ctx.su.prisma, async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`UPDATE team_password_entries SET team_key_version = 1 WHERE id = $1::uuid`, entryId);
        await tx.$executeRawUnsafe(`DELETE FROM team_password_entry_histories WHERE id = $1::uuid`, historyId);
      }, HOLD_TIMEOUT_MS);
      try {
        await twoStatementPrune(teamId, "entries", () => writer.release());
      } finally {
        await writer.abort();
      }
      expect(await versions(teamId)).not.toContain(1);
    });

    it("negative control (snapshot shape): histories first, entries after the commit, loses k", async () => {
      const teamId = await seedTeam(3);
      const entryId = await seedEntry(teamId, 1);
      const writer = await holdPrismaWriter(ctx.su.prisma, async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO team_password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, changed_by_id, changed_at)
           SELECT $1::uuid, id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, team_key_version, created_by_id, now()
             FROM team_password_entries WHERE id = $2::uuid`,
          randomUUID(), entryId,
        );
        await tx.$executeRawUnsafe(`UPDATE team_password_entries SET team_key_version = 3 WHERE id = $1::uuid`, entryId);
      }, HOLD_TIMEOUT_MS);
      try {
        await twoStatementPrune(teamId, "histories", () => writer.release());
      } finally {
        await writer.abort();
      }
      expect(await versions(teamId)).not.toContain(1);
    });
  });
});
