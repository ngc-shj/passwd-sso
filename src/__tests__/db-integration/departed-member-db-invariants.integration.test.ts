/**
 * Integration test (real DB): the departed-member guard (departed_member_guard,
 * migration 20261117000000) holds the two departed-member invariants in the
 * database (docs/archive/review/departed-member-db-invariants-plan.md C7).
 *
 * - I1: no grant reaches a leftover membership (an active team_members row
 *   whose user departed the team's tenant at or after the row's admission), and
 *   no membership is activated while its user's tenant row is departed.
 * - I2: a transaction that departs a user from a tenant does not commit while
 *   the user, departed, holds an active membership of the tenant's teams (or,
 *   with the tenant row active at commit, a leftover one).
 *
 * Raw writes run on passwd_app under tenant context unless a cell says
 * otherwise. Every refusal asserts SQLSTATE 23514 and its
 * `DEPARTED_MEMBER_GUARD:<arm>` token, and whether it came at the statement
 * (the BEFORE triggers) or at COMMIT (the deferred departure check). Raw cells
 * keep departures at least a second from admissions, so no cell depends on the
 * clock's resolution. One tenant per cell (two where the subject spans
 * tenants), each deleted after the cell and swept by ctx.cleanup().
 *
 * Fixtures a migrated database refuses (residue, a departure record over an
 * active membership) are written through writeRefusedState.
 *
 * Not here: an unknown TeamRole label raising unknown_role needs ALTER TYPE
 * ADD VALUE, which cannot be rolled back and changes the type for the whole
 * database, so it runs only on a scratch copy (the red-proof runner); this
 * file proves the converse, that every current label is ranked.
 *
 * Run: npm run test:integration -- departed-member-db-invariants
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  appConnectionString,
  assertRlsApplies,
  createPrismaForRole,
  createTestContext,
  expectBypassRefusal,
  readGucs,
  setBypassRlsGucs,
  sqlStateOf,
  writeRefusedState,
  type GucState,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { createRaceHelpers, holdPrismaWriter, type HeldWriter } from "./race-helpers";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: async () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as acceptInvitation } from "@/app/api/teams/invitations/accept/route";
import { POST as rotateKeyRoute } from "@/app/api/teams/[teamId]/rotate-key/route";
import { createPool } from "@/lib/db/pool-factory";
import { prisma } from "@/lib/prisma";
import { SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";
import { withTenantRls } from "@/lib/tenant-rls";
import { setTenantGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
import { departCreatedMembership, departFromTenant, returnToTenant } from "@/lib/team/team-departure";
import { lockTenantMemberCreation, lockTenantRows } from "@/lib/team/tenant-row-lock";
import { deactivateScimUser } from "@/lib/services/scim-user-service";
import { hashToken } from "@/lib/crypto/crypto-server";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

const hex = (n: number) => randomBytes(n).toString("hex");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const ACTOR = { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM };
/** Long enough for a held writer to outlast every wait a race cell makes. */
const HOLD_MS = 20_000;
const GUARD = "trg_team_members_departed_member_guard";
/** A raw departure stamp of ($1 tenant, $2 user), with no ending of the user's team rows. */
const STAMP_NOW = `UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`;

const ARM = {
  TENANT_MISMATCH: "tenant_mismatch",
  CREATED_AT: "created_at",
  ACTIVATION_DEPARTED: "activation_departed",
  ACTIVATION_LEFTOVER: "activation_leftover",
  GRANT_LEFTOVER: "grant_leftover",
  KEY_LEFTOVER: "key_leftover",
  KEY_INACTIVE: "key_inactive",
  RECORD_LOWERED: "record_lowered",
  ISOLATION: "isolation",
  DEPARTURE_ACTIVE: "departure_active",
  DEPARTURE_LEFTOVER: "departure_leftover",
} as const;
type Arm = (typeof ARM)[keyof typeof ARM];

type Step = string | readonly [string, readonly unknown[]];
type Outcome =
  | { committed: true }
  | { committed: false; at: "statement" | "commit"; index: number; error: unknown };

/** The arm token of a guard refusal, from a pg error or a Prisma error wrapping one. */
function armOf(error: unknown): string | null {
  const texts: string[] = [];
  for (let e: unknown = error, depth = 0; e && depth < 6; depth++) {
    if (e instanceof Error) texts.push(e.message);
    const meta = (e as { meta?: { driverAdapterError?: { cause?: { message?: string } } } }).meta;
    if (meta?.driverAdapterError?.cause?.message) texts.push(meta.driverAdapterError.cause.message);
    e = (e as { cause?: unknown }).cause;
  }
  for (const text of texts) {
    const m = /DEPARTED_MEMBER_GUARD:([a-z_]+):/.exec(text);
    if (m) return m[1];
  }
  return null;
}

function expectGuardError(error: unknown, arm: Arm): void {
  expect({ code: sqlStateOf(error), arm: armOf(error) }).toEqual({ code: SQLSTATE_CHECK_VIOLATION, arm });
}

/** Refused at `at`; at the statement, `index` names the statement that failed. */
function expectRefused(outcome: Outcome, at: "statement" | "commit", arm: Arm, index?: number): void {
  if (outcome.committed) throw new Error(`expected a ${arm} refusal at ${at}, but the transaction committed`);
  expect(outcome.at).toBe(at);
  if (index !== undefined) expect(outcome.index).toBe(index);
  expectGuardError(outcome.error, arm);
}

function expectCommitted(outcome: Outcome): void {
  if (!outcome.committed) {
    throw new Error(
      `expected the transaction to commit, but it failed at ${outcome.at} (step ${outcome.index}): ` +
        `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
    );
  }
}

describe("departed-member DB invariants — real-DB integration", () => {
  let ctx: TestContext;
  let appPool: pg.Pool;
  let race: ReturnType<typeof createRaceHelpers>;
  const cellTenants: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
    await assertRlsApplies(ctx.app.prisma);
    appPool = createPool({ connectionString: appConnectionString(), max: 6, idleTimeoutMillis: 10_000 });
    const { rows } = await appPool.query<{ super: boolean; bypass: boolean }>(
      `SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ super: false, bypass: false });
    // Observation only (pg_locks, pg_stat_activity of every role): the superuser.
    race = createRaceHelpers(ctx.su.pool);
  });

  afterAll(async () => {
    await appPool?.end();
    await ctx.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
  });

  afterEach(async () => {
    for (const t of cellTenants.splice(0)) await ctx.deleteTestData(t);
    vi.unstubAllEnvs();
  });

  // ── Runners ───────────────────────────────────────────────────

  /**
   * One transaction of `steps` on `pool` under `gucs`, reporting whether it
   * committed, or which step failed: a statement (BEFORE triggers) or COMMIT
   * (the deferred departure check).
   */
  async function runTx(
    pool: pg.Pool,
    setGucs: (client: pg.PoolClient) => Promise<void>,
    steps: readonly Step[],
    opts: { isolation?: "REPEATABLE READ" } = {},
  ): Promise<Outcome> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(opts.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation}` : "BEGIN");
      await setGucs(client);
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const [text, params] = typeof step === "string" ? [step, []] : step;
        try {
          await client.query(text, [...params]);
        } catch (error) {
          await client.query("ROLLBACK").catch((e: unknown) => {
            broken = e instanceof Error ? e : new Error(String(e));
          });
          return { committed: false, at: "statement", index, error };
        }
      }
      try {
        await client.query("COMMIT");
      } catch (error) {
        return { committed: false, at: "commit", index: steps.length, error };
      }
      return { committed: true };
    } finally {
      client.release(broken);
    }
  }

  async function tenantGucs(client: pg.PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', 'off', true),
              set_config('app.bypass_tables', '', true)`,
      [tenantId],
    );
  }

  /** `steps` as passwd_app under `tenantId`'s context. */
  function asApp(tenantId: string, steps: readonly Step[], opts?: { isolation?: "REPEATABLE READ" }): Promise<Outcome> {
    return runTx(appPool, (c) => tenantGucs(c, tenantId), steps, opts);
  }

  /** `steps` as the superuser (migration role) with the tenant-context trigger bypassed. */
  function asSuperuser(steps: readonly Step[]): Promise<Outcome> {
    return runTx(
      ctx.su.pool,
      (c) =>
        c.query(
          `SELECT set_config('app.bypass_rls', 'on', true),
                  set_config('app.bypass_tables', 'tenant_members,team_members,tenant_member_departures,teams', true),
                  set_config('app.bypass_purpose', $1, true)`,
          [BYPASS_PURPOSE.SYSTEM_MAINTENANCE],
        ).then(() => {}),
      steps,
    );
  }

  // ── Fixtures (superuser; every write goes through the guard) ─────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /** The database clock, in ms. */
  async function clock(): Promise<number> {
    const [row] = await sql<{ t: Date }>(`SELECT clock_timestamp()::timestamptz(3) AS t`);
    return row.t.getTime();
  }

  async function tenant(): Promise<string> {
    const id = await ctx.createTenant();
    cellTenants.push(id);
    return id;
  }

  /** A tenant MEMBER with an active tenant row (createUser makes OWNERs). */
  async function member(t: string): Promise<string> {
    const id = await ctx.createUser(t);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, id);
    return id;
  }

  /** A user with no tenant row in `t`: a guest of its teams. */
  async function guest(t: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
      id, t, `guest-${id.slice(0, 8)}@example.com`, `Guest ${id.slice(0, 8)}`,
    );
    return id;
  }

  async function team(t: string, id: string = randomUUID()): Promise<string> {
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, t, `team-${id.slice(0, 8)}`,
    );
    return id;
  }

  type RowOpts = { role?: string; keyDistributed?: boolean; createdAt?: number; deactivatedAt?: number };

  /** A team_members row; times are database-clock ms. */
  async function addRow(t: string, teamId: string, userId: string, o: RowOpts = {}): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, deactivated_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", $6, $7::timestamptz, $8::timestamptz, now())`,
      id, teamId, userId, t, o.role ?? "MEMBER", o.keyDistributed ?? true,
      o.deactivatedAt === undefined ? null : new Date(o.deactivatedAt),
      new Date(o.createdAt ?? (await clock()) - HOUR),
    );
    return id;
  }

  const KEY_COLUMNS = `id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
    ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at`;

  /** VALUES for a key row: $1 team, $2 tenant, $3 user, $4 key version. */
  const KEY_VALUES = `(gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, '${hex(32)}', '${hex(12)}', '${hex(16)}',
    '${hex(32)}', '${hex(32)}', $4, 1, now(), now())`;

  async function addKey(t: string, teamId: string, userId: string, version = 1): Promise<void> {
    await sql(`INSERT INTO team_member_keys (${KEY_COLUMNS}) VALUES ${KEY_VALUES}`, teamId, t, userId, version);
  }

  /** Stamp a tenant row departed; valid only while the user holds no active row in the tenant's teams. */
  async function stamp(t: string, userId: string, at: number): Promise<void> {
    await sql(
      `UPDATE tenant_members SET deactivated_at = $3::timestamptz WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      t, userId, new Date(at),
    );
  }

  /** A departure record; valid only while it leaves the user no leftover row. */
  async function record(t: string, userId: string, at: number): Promise<void> {
    await sql(
      `INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES ($1::uuid, $2::uuid, $3::timestamptz)`,
      t, userId, new Date(at),
    );
  }

  /** Residue: the tenant row stamped departed while team rows stay active (refused since the guard). */
  async function residue(t: string, userId: string, at: number): Promise<void> {
    const rows = await writeRefusedState(
      ctx.su,
      `UPDATE tenant_members SET deactivated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND deactivated_at IS NULL RETURNING 1`,
      [t, userId, new Date(at)],
    );
    expect(rows).toHaveLength(1);
  }

  /** A departure record over a membership admitted at or before it (refused since the guard). */
  async function leftoverRecord(t: string, userId: string, at: number): Promise<void> {
    const rows = await writeRefusedState(
      ctx.su,
      `INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz) RETURNING 1`,
      [t, userId, new Date(at)],
    );
    expect(rows).toHaveLength(1);
  }

  type MemberRow = {
    user_id: string; role: string; key_distributed: boolean; deactivated_at: Date | null;
    created_at: Date; admitted_at: Date | null;
  };

  async function memberRow(rowId: string): Promise<MemberRow | null> {
    const [row] = await sql<MemberRow>(
      `SELECT user_id, role::text AS role, key_distributed, deactivated_at, created_at, admitted_at
         FROM team_members WHERE id = $1::uuid`,
      rowId,
    );
    return row ?? null;
  }

  async function tenantRow(t: string, userId: string): Promise<{ deactivated_at: Date | null } | null> {
    const [row] = await sql<{ deactivated_at: Date | null }>(
      `SELECT deactivated_at FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      t, userId,
    );
    return row ?? null;
  }

  async function keyRows(teamId: string, userId: string) {
    return sql<{ id: string; key_version: number; encrypted_team_key: string; updated_at: Date }>(
      `SELECT id, key_version, encrypted_team_key, updated_at FROM team_member_keys
        WHERE team_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
      teamId, userId,
    );
  }

  /** A tenant with a team and a MEMBER admitted (created) an hour ago, never departed. */
  async function memberTeam(o: RowOpts = {}) {
    const t = await tenant();
    const teamId = await team(t);
    const u = await member(t);
    const admitted = (await clock()) - HOUR;
    const rowId = await addRow(t, teamId, u, { createdAt: admitted, ...o });
    return { t, teamId, u, rowId, admitted };
  }

  const insertRow = (o: { tenantId?: string; createdAt?: string } = {}) =>
    o.tenantId === undefined
      ? `INSERT INTO team_members (id, team_id, user_id, role, key_distributed, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MEMBER', true, ${o.createdAt ?? "now()"}, now())`
      : `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '${o.tenantId}'::uuid, 'MEMBER', true, ${o.createdAt ?? "now()"}, now())`;

  // ── T1: grants ────────────────────────────────────────────────

  describe("T1: grants", () => {
    const RAISES = [
      { label: "VIEWER→MEMBER", from: { role: "VIEWER", kd: true }, to: { role: "MEMBER", kd: true } },
      { label: "MEMBER→ADMIN", from: { role: "MEMBER", kd: true }, to: { role: "ADMIN", kd: true } },
      { label: "ADMIN→OWNER", from: { role: "ADMIN", kd: true }, to: { role: "OWNER", kd: true } },
      { label: "key_distributed false→true", from: { role: "MEMBER", kd: false }, to: { role: "MEMBER", kd: true } },
    ] as const;

    /** How the membership became leftover; `admitted` is the row's created_at. */
    const STATES = {
      residue: (t: string, u: string, admitted: number) => residue(t, u, admitted + 30 * MINUTE),
      "containable = false (record, tenant row re-created)": (t: string, u: string, admitted: number) =>
        leftoverRecord(t, u, admitted + 30 * MINUTE),
      "containable = false (record, tenant row deleted)": async (t: string, u: string, admitted: number) => {
        await leftoverRecord(t, u, admitted + 30 * MINUTE);
        await sql(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, u);
      },
      "departure equal to admission": (t: string, u: string, admitted: number) => leftoverRecord(t, u, admitted),
    } as const;
    type State = keyof typeof STATES;

    type To = { role: string; kd: boolean };
    const SPELLINGS = {
      UPDATE: (r: { rowId: string }, to: To): Step => [
        `UPDATE team_members SET role = $2::"TeamRole", key_distributed = $3 WHERE id = $1::uuid`,
        [r.rowId, to.role, to.kd],
      ],
      "ON CONFLICT DO UPDATE": (r: { t: string; teamId: string; u: string }, to: To): Step => [
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::"TeamRole", $5, now(), now())
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role, key_distributed = EXCLUDED.key_distributed`,
        [r.teamId, r.u, r.t, to.role, to.kd],
      ],
      MERGE: (r: { rowId: string }, to: To): Step => [
        `MERGE INTO team_members tm USING (SELECT $1::uuid AS id) s ON tm.id = s.id
         WHEN MATCHED THEN UPDATE SET role = $2::"TeamRole", key_distributed = $3`,
        [r.rowId, to.role, to.kd],
      ],
    } as const;
    type Spelling = keyof typeof SPELLINGS;

    const denyCells = RAISES.flatMap((raise) =>
      (Object.keys(STATES) as State[]).flatMap((state) =>
        (Object.keys(SPELLINGS) as Spelling[]).map((spelling) => [raise.label, state, spelling, raise] as const),
      ),
    );

    it.each(denyCells)("deny %s on a leftover row (%s) via %s", async (_label, state, spelling, raise) => {
      const r = await memberTeam({ role: raise.from.role, keyDistributed: raise.from.kd });
      await STATES[state](r.t, r.u, r.admitted);

      const outcome = await asApp(r.t, [SPELLINGS[spelling](r, raise.to)]);

      // ON CONFLICT runs the BEFORE INSERT triggers on the proposed row before it
      // finds the conflict: against a departed tenant row that is an activation,
      // refused as one before the UPDATE's grant arm is reached.
      const arm = state === "residue" && spelling === "ON CONFLICT DO UPDATE" ? ARM.ACTIVATION_DEPARTED : ARM.GRANT_LEFTOVER;
      expectRefused(outcome, "statement", arm, 0);
      expect(await memberRow(r.rowId)).toMatchObject({ role: raise.from.role, key_distributed: raise.from.kd, deactivated_at: null });
    });

    it("allow: OWNER→VIEWER on residue", async () => {
      const r = await memberTeam({ role: "OWNER" });
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET role = 'VIEWER' WHERE id = $1::uuid`, [r.rowId]]]));
      expect(await memberRow(r.rowId)).toMatchObject({ role: "VIEWER", deactivated_at: null });
    });

    it("allow: a same-role no-op on residue", async () => {
      const r = await memberTeam({ role: "ADMIN" });
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET role = role, updated_at = now() WHERE id = $1::uuid`, [r.rowId]]]));
      expect(await memberRow(r.rowId)).toMatchObject({ role: "ADMIN", deactivated_at: null });
    });

    it("allow: ending a residue row", async () => {
      const r = await memberTeam({ role: "OWNER" });
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET deactivated_at = clock_timestamp() WHERE id = $1::uuid`, [r.rowId]]]));
      expect((await memberRow(r.rowId))?.deactivated_at).not.toBeNull();
    });

    it("allow: key_distributed true→false on residue", async () => {
      const r = await memberTeam({ keyDistributed: true });
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET key_distributed = false WHERE id = $1::uuid`, [r.rowId]]]));
      expect(await memberRow(r.rowId)).toMatchObject({ key_distributed: false });
    });

    it("allow: a grant to a never-departed member", async () => {
      const r = await memberTeam({ role: "MEMBER", keyDistributed: false });

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET role = 'ADMIN', key_distributed = true WHERE id = $1::uuid`, [r.rowId]]]));
      expect(await memberRow(r.rowId)).toMatchObject({ role: "ADMIN", key_distributed: true });
    });

    it("allow: a grant to a guest (no tenant row)", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const g = await guest(t);
      const rowId = await addRow(t, teamId, g, { keyDistributed: false });

      expectCommitted(await asApp(t, [[`UPDATE team_members SET role = 'ADMIN', key_distributed = true WHERE id = $1::uuid`, [rowId]]]));
      expect(await memberRow(rowId)).toMatchObject({ role: "ADMIN", key_distributed: true });
    });

    it("allow: a grant after a return (the row re-activated after the departure; admission is admitted_at)", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const now = await clock();
      // Created before the departure, ended by it; the tenant row re-created (record only).
      const rowId = await addRow(t, teamId, u, { createdAt: now - HOUR, deactivatedAt: now - 30 * MINUTE });
      await record(t, u, now - 30 * MINUTE);

      expectCommitted(await asApp(t, [
        [`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [rowId]],
        [`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [rowId]],
      ]));
      const row = await memberRow(rowId);
      expect(row).toMatchObject({ role: "ADMIN", deactivated_at: null });
      expect(row?.admitted_at?.getTime()).toBeGreaterThan(now - 30 * MINUTE);
    });

    it("allow: a grant to a row admitted 1 s after the departure", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const departed = (await clock()) - HOUR;
      await record(t, u, departed);
      const rowId = await addRow(t, teamId, u, { createdAt: departed + SECOND });

      expectCommitted(await asApp(t, [[`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [rowId]]]));
      expect(await memberRow(rowId)).toMatchObject({ role: "ADMIN" });
    });

    it("allow: scenario 3 — in one transaction, demote the leftover OWNER and promote a live member", async () => {
      const r = await memberTeam({ role: "OWNER" });
      const live = await member(r.t);
      const liveRow = await addRow(r.t, r.teamId, live, { role: "ADMIN" });
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);

      expectCommitted(await asApp(r.t, [
        [`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [r.rowId]],
        [`UPDATE team_members SET role = 'OWNER' WHERE id = $1::uuid`, [liveRow]],
      ]));
      expect(await memberRow(r.rowId)).toMatchObject({ role: "ADMIN" });
      expect(await memberRow(liveRow)).toMatchObject({ role: "OWNER" });
    });

    it("every pg_enum label of TeamRole is ranked: an UPDATE between each pair does not raise unknown_role", async () => {
      const labels = (await sql<{ label: string }>(
        `SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = '"TeamRole"'::regtype ORDER BY enumsortorder`,
      )).map((r) => r.label);
      expect(labels.length).toBeGreaterThanOrEqual(4);
      const r = await memberTeam();

      for (const from of labels) {
        for (const to of labels) {
          const outcome = await asApp(r.t, [
            [`UPDATE team_members SET role = $2::"TeamRole" WHERE id = $1::uuid`, [r.rowId, from]],
            [`UPDATE team_members SET role = $2::"TeamRole" WHERE id = $1::uuid`, [r.rowId, to]],
          ]);
          if (!outcome.committed) throw new Error(`${from}→${to}: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
          expect((await memberRow(r.rowId))?.role).toBe(to);
        }
      }
    });

    it("deny: an UPDATE of created_at", async () => {
      const r = await memberTeam();

      expectRefused(
        await asApp(r.t, [[`UPDATE team_members SET created_at = created_at - interval '1 second' WHERE id = $1::uuid`, [r.rowId]]]),
        "statement", ARM.CREATED_AT, 0,
      );
      expect((await memberRow(r.rowId))?.created_at.getTime()).toBe(r.admitted);
    });

    it("allow (pair): an UPDATE that sets created_at to its own value", async () => {
      const r = await memberTeam();

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET created_at = created_at WHERE id = $1::uuid`, [r.rowId]]]));
      expect((await memberRow(r.rowId))?.created_at.getTime()).toBe(r.admitted);
    });

    it("deny: a membership whose tenant_id is not its team's", async () => {
      const t = await tenant();
      const other = await tenant();
      const foreignTeam = await team(other);
      const u = await member(t);

      expectRefused(
        await asApp(t, [[insertRow({ tenantId: t }), [foreignTeam, u]]]),
        "statement", ARM.TENANT_MISMATCH, 0,
      );
      expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, foreignTeam)).toEqual([]);
    });
  });

  // ── T2: keys ──────────────────────────────────────────────────

  describe("T2: keys", () => {
    const keyInsert = (version: number): string => `INSERT INTO team_member_keys (${KEY_COLUMNS}) VALUES ${KEY_VALUES}`.replace("$4", String(version));
    const keyUpsert = `INSERT INTO team_member_keys (${KEY_COLUMNS}) VALUES ${KEY_VALUES}
      ON CONFLICT (team_id, user_id, key_version) DO UPDATE SET encrypted_team_key = EXCLUDED.encrypted_team_key, updated_at = now()`;
    const keyUpdate = `UPDATE team_member_keys SET encrypted_team_key = '${hex(32)}', updated_at = now()
      WHERE team_id = $1::uuid AND user_id = $2::uuid AND key_version = 1`;

    async function leftoverHolder() {
      const r = await memberTeam();
      await addKey(r.t, r.teamId, r.u);
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);
      return r;
    }

    /** A member a team admin removed: ended, never departed from the tenant. */
    async function endedHolder() {
      const r = await memberTeam();
      await addKey(r.t, r.teamId, r.u);
      await sql(`UPDATE team_members SET deactivated_at = clock_timestamp() WHERE id = $1::uuid`, r.rowId);
      return r;
    }

    it("deny: a key INSERT for a leftover recipient", async () => {
      const r = await leftoverHolder();
      expectRefused(await asApp(r.t, [[keyInsert(2), [r.teamId, r.t, r.u]]]), "statement", ARM.KEY_LEFTOVER, 0);
      expect((await keyRows(r.teamId, r.u)).map((k) => k.key_version)).toEqual([1]);
    });

    it("deny: a key UPDATE for a leftover recipient", async () => {
      const r = await leftoverHolder();
      const before = await keyRows(r.teamId, r.u);
      expectRefused(await asApp(r.t, [[keyUpdate, [r.teamId, r.u]]]), "statement", ARM.KEY_LEFTOVER, 0);
      expect(await keyRows(r.teamId, r.u)).toEqual(before);
    });

    it("deny: a key ON CONFLICT DO UPDATE for a leftover recipient", async () => {
      const r = await leftoverHolder();
      const before = await keyRows(r.teamId, r.u);
      expectRefused(await asApp(r.t, [[keyUpsert, [r.teamId, r.t, r.u, 1]]]), "statement", ARM.KEY_LEFTOVER, 0);
      expect(await keyRows(r.teamId, r.u)).toEqual(before);
    });

    it("deny: a key INSERT for an ended, non-leftover member (key_inactive is the only refusal)", async () => {
      const r = await endedHolder();
      expectRefused(await asApp(r.t, [[keyInsert(2), [r.teamId, r.t, r.u]]]), "statement", ARM.KEY_INACTIVE, 0);
      expect((await keyRows(r.teamId, r.u)).map((k) => k.key_version)).toEqual([1]);
    });

    it("deny: a key UPDATE for an ended, non-leftover member", async () => {
      const r = await endedHolder();
      const before = await keyRows(r.teamId, r.u);
      expectRefused(await asApp(r.t, [[keyUpdate, [r.teamId, r.u]]]), "statement", ARM.KEY_INACTIVE, 0);
      expect(await keyRows(r.teamId, r.u)).toEqual(before);
    });

    it("deny: a key whose tenant_id is not its team's", async () => {
      const r = await memberTeam();
      const other = await tenant();
      const foreignTeam = await team(other);
      expectRefused(await asApp(r.t, [[keyInsert(1), [foreignTeam, r.t, r.u]]]), "statement", ARM.TENANT_MISMATCH, 0);
      expect(await keyRows(foreignTeam, r.u)).toEqual([]);
    });

    it("allow: a key INSERT for an active, non-leftover member", async () => {
      const r = await memberTeam();
      await addKey(r.t, r.teamId, r.u);
      expectCommitted(await asApp(r.t, [[keyInsert(2), [r.teamId, r.t, r.u]]]));
      expect((await keyRows(r.teamId, r.u)).map((k) => k.key_version)).toEqual([1, 2]);
    });

    it("allow: ending a member, whose key rows stay untouched", async () => {
      const r = await memberTeam();
      await addKey(r.t, r.teamId, r.u);
      const before = await keyRows(r.teamId, r.u);

      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET deactivated_at = clock_timestamp() WHERE id = $1::uuid`, [r.rowId]]]));
      expect((await memberRow(r.rowId))?.deactivated_at).not.toBeNull();
      expect(await keyRows(r.teamId, r.u)).toEqual(before);
    });
  });

  // ── T3: activation ────────────────────────────────────────────

  describe("T3: activation", () => {
    it.each([
      ["tenant_id given", true],
      ["tenant_id omitted (derived by the tenant-context trigger)", false],
    ] as const)("deny: an INSERT born leftover, %s", async (_label, given) => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      // A departure record (tenant row re-created); the row claims an admission an hour before it.
      await record(t, u, await clock());

      expectRefused(
        await asApp(t, [[insertRow({ tenantId: given ? t : undefined, createdAt: "now() - interval '1 hour'" }), [teamId, u]]]),
        "statement", ARM.ACTIVATION_LEFTOVER, 0,
      );
      expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, teamId)).toEqual([]);
    });

    it("deny: an INSERT while the tenant row is departed (S1), admission after the departure", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      await stamp(t, u, (await clock()) - HOUR);

      expectRefused(await asApp(t, [[insertRow({ tenantId: t }), [teamId, u]]]), "statement", ARM.ACTIVATION_DEPARTED, 0);
      expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, teamId)).toEqual([]);
    });

    it("deny: a re-activation while the tenant row is departed", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const departed = (await clock()) - 30 * MINUTE;
      const rowId = await addRow(t, teamId, u, { createdAt: departed - 30 * MINUTE, deactivatedAt: departed });
      await stamp(t, u, departed);

      expectRefused(
        await asApp(t, [[`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [rowId]]]),
        "statement", ARM.ACTIVATION_DEPARTED, 0,
      );
      expect((await memberRow(rowId))?.deactivated_at).not.toBeNull();
    });

    it("deny: re-pointing an active row to a departed user", async () => {
      const r = await memberTeam();
      const departedUser = await member(r.t);
      await stamp(r.t, departedUser, (await clock()) - HOUR);

      expectRefused(
        await asApp(r.t, [[`UPDATE team_members SET user_id = $2::uuid WHERE id = $1::uuid`, [r.rowId, departedUser]]]),
        "statement", ARM.ACTIVATION_DEPARTED, 0,
      );
      expect((await memberRow(r.rowId))?.user_id).toBe(r.u);
    });

    it("deny: an activation under REPEATABLE READ", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);

      expectRefused(
        await asApp(t, [[insertRow({ tenantId: t }), [teamId, u]]], { isolation: "REPEATABLE READ" }),
        "statement", ARM.ISOLATION, 0,
      );
    });

    it("allow: an INSERT after a return", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      await stamp(t, u, (await clock()) - HOUR);
      await sql(`UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, u);

      expectCommitted(await asApp(t, [[insertRow({ tenantId: t }), [teamId, u]]]));
    });

    it("allow: a re-activation after a return", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const departed = (await clock()) - 30 * MINUTE;
      const rowId = await addRow(t, teamId, u, { createdAt: departed - 30 * MINUTE, deactivatedAt: departed });
      await stamp(t, u, departed);
      await sql(`UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, u);

      expectCommitted(await asApp(t, [[`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [rowId]]]));
      expect((await memberRow(rowId))?.deactivated_at).toBeNull();
    });

    it("allow: an INSERT for a guest", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const g = await guest(t);
      expectCommitted(await asApp(t, [[insertRow({ tenantId: t }), [teamId, g]]]));
    });

    it("allow: an INSERT for a guest who has a departure record and no tenant row (SC2)", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const g = await guest(t);
      await record(t, g, (await clock()) - HOUR);
      expectCommitted(await asApp(t, [[insertRow({ tenantId: t }), [teamId, g]]]));
    });

    it("allow: an INSERT with tenant_id omitted for a non-departed user", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      expectCommitted(await asApp(t, [[insertRow(), [teamId, u]]]));
      expect(await sql(`SELECT tenant_id FROM team_members WHERE team_id = $1::uuid`, teamId)).toEqual([{ tenant_id: t }]);
    });

    it("allow: re-pointing an active row to a non-departed user", async () => {
      const r = await memberTeam();
      const other = await member(r.t);
      expectCommitted(await asApp(r.t, [[`UPDATE team_members SET user_id = $2::uuid WHERE id = $1::uuid`, [r.rowId, other]]]));
      expect((await memberRow(r.rowId))?.user_id).toBe(other);
    });

    it("allow: an INSERT whose created_at is 1 s in the future, for a user who departed and returned (stored as given)", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const now = await clock();
      await stamp(t, u, now - HOUR);
      await sql(`UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, u);
      await record(t, u, now);
      const future = new Date(now + SECOND);

      expectCommitted(await asApp(t, [[
        `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'MEMBER', true, $4::timestamptz, now())`,
        [teamId, u, t, future],
      ]]));
      const [row] = await sql<{ created_at: Date }>(`SELECT created_at FROM team_members WHERE team_id = $1::uuid`, teamId);
      expect(row.created_at.getTime()).toBe(future.getTime());
    });

    /** The text between `-- BEGIN SCRIPT <name>` and `-- END SCRIPT <name>` in the runbook. */
    function runbookScript(name: string): string {
      const text = readFileSync(join(process.cwd(), "docs/operations/departed-member-access-backfill.md"), "utf8");
      const begin = `-- BEGIN SCRIPT ${name}\n`;
      const end = `-- END SCRIPT ${name}\n`;
      const from = text.indexOf(begin);
      if (from === -1 || text.indexOf(begin, from + 1) !== -1 || text.indexOf(end) < from) {
        throw new Error(`expected exactly one SCRIPT ${name} marker pair in the runbook`);
      }
      return text.slice(from + begin.length, text.indexOf(end));
    }

    it("allow: the runbook re-admit script, as the table owner, re-admits a residual member; the guard is enabled after it", async () => {
      const r = await memberTeam();
      // The residual class: never re-activated, departed after the admission, updated since.
      await sql(`UPDATE team_members SET updated_at = now() WHERE id = $1::uuid`, r.rowId);
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);
      const script = runbookScript("departed-member-readmit")
        .replace(/^.*-- INPUT:triples$/m, `  v_input uuid[] := '{{${r.t},${r.teamId},${r.u}}}'::uuid[]; -- INPUT:triples`)
        .replace(/^.*-- INPUT:label$/m, `  v_label text := $label$db-invariants-test$label$; -- INPUT:label`);

      const client = await ctx.su.pool.connect();
      try {
        await client.query(script);
      } catch (error) {
        // An aborted script would return the connection inside its transaction,
        // still holding team_members' ACCESS EXCLUSIVE lock from DISABLE TRIGGER.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      const row = await memberRow(r.rowId);
      expect(row?.deactivated_at).toBeNull();
      expect(row?.admitted_at).not.toBeNull();
      const [trigger] = await sql<{ tgenabled: string }>(
        `SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgrelid = 'team_members'::regclass AND tgname = $1`, GUARD,
      );
      expect(trigger.tgenabled).toBe("O");
    });

    it("the guard sorts after the same-event BEFORE triggers it depends on (pg_trigger name order)", async () => {
      // tgtype bits: 1 = ROW, 2 = BEFORE.
      const before = async (table: string) =>
        (await sql<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgtype & 3 = 3
            ORDER BY tgname COLLATE "C"`,
          table,
        )).map((r) => r.tgname);
      const members = await before("team_members");
      expect(members.at(-1)).toBe(GUARD);
      expect(members).toEqual(expect.arrayContaining(["team_members_set_admitted_at", "trg_enforce_tenant_id_team_members"]));
      const keys = await before("team_member_keys");
      expect(keys.at(-1)).toBe("trg_team_member_keys_departed_member_guard");
      expect(keys).toContain("trg_enforce_tenant_id_team_member_keys");
      const enabled = await sql<{ tgname: string; tgenabled: string }>(
        `SELECT tgname::text AS tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgfoid = 'public.departed_member_guard()'::regprocedure ORDER BY tgname`,
      );
      expect(enabled).toEqual([
        { tgname: "tenant_member_departures_ends_memberships", tgenabled: "O" },
        { tgname: "tenant_members_departure_ends_memberships_ins", tgenabled: "O" },
        { tgname: "tenant_members_departure_ends_memberships_upd", tgenabled: "O" },
        { tgname: "trg_team_member_keys_departed_member_guard", tgenabled: "O" },
        { tgname: GUARD, tgenabled: "O" },
        { tgname: "trg_tenant_member_departures_stamp_guard", tgenabled: "O" },
      ]);
    });

    describe("invitation accept (C9)", () => {
      /** A team owned by the tenant OWNER, and an invitation to `email` issued now. */
      async function invitedTeam(t: string, email: string) {
        const owner = await ctx.createUser(t);
        const teamId = await team(t);
        await addRow(t, teamId, owner, { role: "OWNER", createdAt: (await clock()) - 2 * HOUR });
        const token = hex(32);
        const invitationId = randomUUID();
        await sql(
          `INSERT INTO team_invitations (id, team_id, tenant_id, email, role, status, token_hash, expires_at, invited_by_id, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MEMBER', 'PENDING', $5, now() + interval '1 day', $6::uuid, now())`,
          invitationId, teamId, t, email, hashToken(token), owner,
        );
        return { teamId, invitationId, token };
      }

      async function emailOf(userId: string): Promise<string> {
        const [row] = await sql<{ email: string }>(`SELECT email FROM users WHERE id = $1::uuid`, userId);
        return row.email;
      }

      function accept(userId: string, email: string, token: string) {
        mockAuth.mockResolvedValue({ user: { id: userId, email } });
        return acceptInvitation(new NextRequest("http://localhost/api/teams/invitations/accept", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }));
      }

      it("an invitee departed before the invitation is answered INVITATION_EXPIRED, the invitation EXPIRED, no membership", async () => {
        const t = await tenant();
        const elsewhere = await tenant();
        const invitee = await member(t);
        await stamp(t, invitee, (await clock()) - HOUR);
        // Active in another tenant: the state in which a departed user can sign in and accept.
        await sql(
          `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
          randomUUID(), elsewhere, invitee,
        );
        const email = await emailOf(invitee);
        const inv = await invitedTeam(t, email);

        const res = await accept(invitee, email, inv.token);

        expect(res.status).toBe(410);
        expect((await res.json()).error).toBe("INVITATION_EXPIRED");
        const [status] = await sql<{ status: string }>(`SELECT status FROM team_invitations WHERE id = $1::uuid`, inv.invitationId);
        expect(status.status).toBe("EXPIRED");
        expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`, inv.teamId, invitee)).toEqual([]);
      });

      it("(pair) an active invitee is admitted", async () => {
        const t = await tenant();
        const invitee = await member(t);
        const email = await emailOf(invitee);
        const inv = await invitedTeam(t, email);

        const res = await accept(invitee, email, inv.token);

        expect(res.status).toBe(200);
        const [status] = await sql<{ status: string }>(`SELECT status FROM team_invitations WHERE id = $1::uuid`, inv.invitationId);
        expect(status.status).toBe("ACCEPTED");
        expect(await sql(
          `SELECT 1 FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid AND deactivated_at IS NULL`,
          inv.teamId, invitee,
        )).toHaveLength(1);
      });
    });
  });

  // ── T4: departure ─────────────────────────────────────────────

  describe("T4: departure", () => {
    const returnRow = `UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`;
    const endRows = `UPDATE team_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND deactivated_at IS NULL`;

    describe("refused at COMMIT, not at the statement", () => {
      it("a stamp that leaves an active row", async () => {
        const r = await memberTeam();
        expectRefused(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]]]), "commit", ARM.DEPARTURE_ACTIVE);
        expect(await tenantRow(r.t, r.u)).toEqual({ deactivated_at: null });
      });

      it("a back-dated first stamp that leaves a row admitted after it", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const u = await member(t);
        const now = await clock();
        await addRow(t, teamId, u, { createdAt: now - 10 * MINUTE });

        expectRefused(
          await asApp(t, [[`UPDATE tenant_members SET deactivated_at = $3::timestamptz WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [t, u, new Date(now - HOUR)]]]),
          "commit", ARM.DEPARTURE_ACTIVE,
        );
        expect(await tenantRow(t, u)).toEqual({ deactivated_at: null });
      });

      it("a restamp while residue is active", async () => {
        const r = await memberTeam();
        const stamped = r.admitted + 30 * MINUTE;
        await residue(r.t, r.u, stamped);

        expectRefused(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]]]), "commit", ARM.DEPARTURE_ACTIVE);
        expect((await tenantRow(r.t, r.u))?.deactivated_at?.getTime()).toBe(stamped);
      });

      it("a record INSERT that leaves a guest an active row", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const g = await guest(t);
        await addRow(t, teamId, g);

        expectRefused(
          await asApp(t, [[`INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES ($1::uuid, $2::uuid, clock_timestamp())`, [t, g]]]),
          "commit", ARM.DEPARTURE_ACTIVE,
        );
        expect(await sql(`SELECT 1 FROM tenant_member_departures WHERE tenant_id = $1::uuid`, t)).toEqual([]);
      });

      it("a record UPDATE that leaves a guest an active row", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const g = await guest(t);
        const now = await clock();
        // A record older than the guest's admission: a guest admitted after a SCIM DELETE (SC2).
        await record(t, g, now - 2 * HOUR);
        await addRow(t, teamId, g, { createdAt: now - HOUR });

        expectRefused(
          await asApp(t, [[`UPDATE tenant_member_departures SET departed_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [t, g]]]),
          "commit", ARM.DEPARTURE_ACTIVE,
        );
        const [rec] = await sql<{ departed_at: Date }>(`SELECT departed_at FROM tenant_member_departures WHERE tenant_id = $1::uuid`, t);
        expect(rec.departed_at.getTime()).toBe(now - 2 * HOUR);
      });

      it("a tenant row created deactivated that leaves a guest an active row", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const g = await guest(t);
        await addRow(t, teamId, g);

        expectRefused(
          await asApp(t, [[
            `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MEMBER', clock_timestamp(), now(), now())`,
            [t, g],
          ]]),
          "commit", ARM.DEPARTURE_ACTIVE,
        );
        expect(await tenantRow(t, g)).toBeNull();
      });

      it("a departure under REPEATABLE READ, even one that ends its rows", async () => {
        const r = await memberTeam();
        expectRefused(
          await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [endRows, [r.t, r.u]]], { isolation: "REPEATABLE READ" }),
          "commit", ARM.ISOLATION,
        );
        expect(await tenantRow(r.t, r.u)).toEqual({ deactivated_at: null });
      });

      it("a stamp and a return in one transaction, while a record later than the admission keeps the row leftover", async () => {
        const r = await memberTeam();
        await leftoverRecord(r.t, r.u, r.admitted + 30 * MINUTE);

        expectRefused(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [returnRow, [r.t, r.u]]]), "commit", ARM.DEPARTURE_LEFTOVER);
      });

      it("(pair) a stamp and a return in one transaction with no later record commits", async () => {
        const r = await memberTeam();
        expectCommitted(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [returnRow, [r.t, r.u]]]));
        expect(await tenantRow(r.t, r.u)).toEqual({ deactivated_at: null });
      });

      it("a record with a re-created active tenant row, leaving a row admitted before the record", async () => {
        const r = await memberTeam();
        expectRefused(
          await asApp(r.t, [
            [`INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at) VALUES ($1::uuid, $2::uuid, clock_timestamp())`, [r.t, r.u]],
            [`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]],
            [`INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
              VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MEMBER', now(), now())`, [r.t, r.u]],
          ]),
          "commit", ARM.DEPARTURE_LEFTOVER,
        );
        expect(await sql(`SELECT 1 FROM tenant_member_departures WHERE tenant_id = $1::uuid`, r.t)).toEqual([]);
      });

      describe("re-keying a departed tenant row (superuser: the tenant-context trigger refuses it for the app)", () => {
        it.each([
          ["onto a user who holds an active row: refused", true],
          ["(pair) onto a user who holds none: commits", false],
        ] as const)("by user_id %s", async (_label, holdsRow) => {
          const t = await tenant();
          const teamId = await team(t);
          const departed = await member(t);
          await stamp(t, departed, (await clock()) - HOUR);
          const target = await guest(t);
          if (holdsRow) await addRow(t, teamId, target);

          const outcome = await asSuperuser([[
            `UPDATE tenant_members SET user_id = $3::uuid WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
            [t, departed, target],
          ]]);

          if (holdsRow) {
            expectRefused(outcome, "commit", ARM.DEPARTURE_ACTIVE);
            expect(await tenantRow(t, target)).toBeNull();
          } else {
            expectCommitted(outcome);
            expect((await tenantRow(t, target))?.deactivated_at).not.toBeNull();
          }
        });

        it.each([
          ["onto a tenant where the user holds an active row: refused", true],
          ["(pair) onto a tenant where the user holds none: commits", false],
        ] as const)("by tenant_id %s", async (_label, holdsRow) => {
          const t = await tenant();
          const other = await tenant();
          const departed = await member(t);
          await stamp(t, departed, (await clock()) - HOUR);
          const otherTeam = await team(other);
          if (holdsRow) await addRow(other, otherTeam, departed);

          const outcome = await asSuperuser([[
            `UPDATE tenant_members SET tenant_id = $3::uuid WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
            [t, departed, other],
          ]]);

          if (holdsRow) {
            expectRefused(outcome, "commit", ARM.DEPARTURE_ACTIVE);
            expect(await tenantRow(other, departed)).toBeNull();
          } else {
            expectCommitted(outcome);
            expect((await tenantRow(other, departed))?.deactivated_at).not.toBeNull();
          }
        });
      });
    });

    describe("refused at the statement", () => {
      it("lowering a record's departed_at", async () => {
        const t = await tenant();
        const g = await guest(t);
        const at = (await clock()) - HOUR;
        await record(t, g, at);

        expectRefused(
          await asApp(t, [[`UPDATE tenant_member_departures SET departed_at = departed_at - interval '1 second' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [t, g]]]),
          "statement", ARM.RECORD_LOWERED, 0,
        );
      });

      it("SET CONSTRAINTS ALL IMMEDIATE before the ending runs the departure check there", async () => {
        // A writer that makes the check immediate must end the rows first: the
        // check judges the state at the SET, not at commit.
        const r = await memberTeam();
        expectRefused(
          await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], "SET CONSTRAINTS ALL IMMEDIATE", [endRows, [r.t, r.u]]]),
          "statement", ARM.DEPARTURE_ACTIVE, 1,
        );
      });
    });

    describe("allowed", () => {
      it("a departure that ends its rows", async () => {
        const r = await memberTeam();
        expectCommitted(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [endRows, [r.t, r.u]]]));
        expect((await memberRow(r.rowId))?.deactivated_at).not.toBeNull();
      });

      it("(pair, immediate) SET CONSTRAINTS ALL IMMEDIATE after the ending", async () => {
        const r = await memberTeam();
        expectCommitted(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [endRows, [r.t, r.u]], "SET CONSTRAINTS ALL IMMEDIATE"]));
      });

      it("a return and then a re-admission in one transaction", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const u = await member(t);
        const departed = (await clock()) - 30 * MINUTE;
        const rowId = await addRow(t, teamId, u, { createdAt: departed - 30 * MINUTE, deactivatedAt: departed });
        await stamp(t, u, departed);

        expectCommitted(await asApp(t, [
          [returnRow, [t, u]],
          [`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [rowId]],
        ]));
        expect((await memberRow(rowId))?.deactivated_at).toBeNull();
      });

      it.each([
        ["raised", "departed_at + interval '1 second'"],
        ["equal", "departed_at"],
      ] as const)("a %s departed_at", async (_label, expr) => {
        const t = await tenant();
        const g = await guest(t);
        await record(t, g, (await clock()) - HOUR);
        expectCommitted(await asApp(t, [[`UPDATE tenant_member_departures SET departed_at = ${expr} WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [t, g]]]));
      });

      it("a non-transition write of a residue user (the stamp left alone)", async () => {
        const r = await memberTeam();
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);
        expectCommitted(await asApp(r.t, [[
          `UPDATE tenant_members SET role = 'MEMBER', updated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
          [r.t, r.u],
        ]]));
      });

      it("departing X while Y is leftover", async () => {
        const r = await memberTeam();
        const y = await member(r.t);
        await addRow(r.t, r.teamId, y, { createdAt: r.admitted });
        await residue(r.t, y, r.admitted + 30 * MINUTE);

        expectCommitted(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [endRows, [r.t, r.u]]]));
      });

      it("departing from A while the user is active in B", async () => {
        const r = await memberTeam();
        const b = await tenant();
        const bTeam = await team(b);
        const bRow = await addRow(b, bTeam, r.u);

        expectCommitted(await asApp(r.t, [[STAMP_NOW, [r.t, r.u]], [endRows, [r.t, r.u]]]));
        expect((await memberRow(bRow))?.deactivated_at).toBeNull();
      });

      it("deleting an active tenant row whose user holds active rows (bootstrap shape; not judged, Q3)", async () => {
        const r = await memberTeam();
        expectCommitted(await asApp(r.t, [[`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]]]));
        expect((await memberRow(r.rowId))?.deactivated_at).toBeNull();
      });

      it("return-then-delete of a residue user (undoing a departure; not judged, Q3)", async () => {
        const r = await memberTeam();
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);
        expectCommitted(await asApp(r.t, [
          [returnRow, [r.t, r.u]],
          [`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]],
        ]));
        expect((await memberRow(r.rowId))?.deactivated_at).toBeNull();
      });

      it("a return of a user whose row a later record keeps leftover (undoing a departure; not judged, Q3)", async () => {
        const r = await memberTeam();
        await leftoverRecord(r.t, r.u, r.admitted + 30 * MINUTE);
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);

        expectCommitted(await asApp(r.t, [[returnRow, [r.t, r.u]]]));
        expect(await tenantRow(r.t, r.u)).toEqual({ deactivated_at: null });
        expect((await memberRow(r.rowId))?.deactivated_at).toBeNull();
      });

      it("an INSERT deactivated with a placeholder 1 s in the future, then a lower clock_timestamp() restamp (F2-2)", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const g = await guest(t);
        const rowId = await addRow(t, teamId, g);

        expectCommitted(await asApp(t, [
          [`INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
            VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MEMBER', clock_timestamp() + interval '1 second', now(), now())`, [t, g]],
          [STAMP_NOW, [t, g]],
          [endRows, [t, g]],
        ]));
        expect((await memberRow(rowId))?.deactivated_at).not.toBeNull();
        expect((await tenantRow(t, g))?.deactivated_at?.getTime()).toBeLessThan(Date.now() + SECOND);
      });

      it("the integration teardown over a departed tenant row and its residue", async () => {
        const r = await memberTeam();
        await addKey(r.t, r.teamId, r.u);
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);
        await record(r.t, await guest(r.t), (await clock()) - HOUR);

        await ctx.deleteTestData(r.t);
        cellTenants.splice(cellTenants.indexOf(r.t), 1);
        expect(await sql(`SELECT 1 FROM tenants WHERE id = $1::uuid`, r.t)).toEqual([]);
      });
    });

    describe("production writers on passwd_app under withTenantRls", () => {
      it("departFromTenant over a residue user and a normal one", async () => {
        const r = await memberTeam();
        const normal = await member(r.t);
        const normalRow = await addRow(r.t, r.teamId, normal);
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);

        const departed = await withTenantRls(prisma, r.t, (tx) => departFromTenant(tx, r.t, [r.u, normal], { actor: ACTOR }));

        expect(departed.userIds).toEqual([normal]);
        expect((await memberRow(normalRow))?.deactivated_at).not.toBeNull();
        // The residue user is not transitioned, so nothing judges them.
        expect((await memberRow(r.rowId))?.deactivated_at).toBeNull();
      });

      it("departCreatedMembership of a guest member", async () => {
        const t = await tenant();
        const teamId = await team(t);
        const g = await guest(t);
        const rowId = await addRow(t, teamId, g);

        await withTenantRls(prisma, t, async (tx) => {
          await lockTenantMemberCreation(tx, t, g);
          await tx.$executeRaw`
            INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
            VALUES (${randomUUID()}::uuid, ${t}::uuid, ${g}::uuid, 'MEMBER', ${new Date()}::timestamptz, now(), now())`;
          await departCreatedMembership(tx, t, [g], { actor: ACTOR });
        });

        expect((await memberRow(rowId))?.deactivated_at).not.toBeNull();
        expect((await tenantRow(t, g))?.deactivated_at).not.toBeNull();
      });

      it("deactivateScimUser of a user with residue", async () => {
        const r = await memberTeam();
        await addKey(r.t, r.teamId, r.u);
        await residue(r.t, r.u, r.admitted + 30 * MINUTE);

        await withTenantRls(prisma, r.t, () => deactivateScimUser(r.t, r.u), { timeout: 15_000 });

        expect(await memberRow(r.rowId)).toBeNull();
        expect(await tenantRow(r.t, r.u)).toBeNull();
        expect(await sql(`SELECT 1 FROM tenant_member_departures WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, r.t, r.u)).toHaveLength(1);
      });

      it("returnToTenant", async () => {
        const r = await memberTeam();
        await withTenantRls(prisma, r.t, (tx) => departFromTenant(tx, r.t, [r.u], { actor: ACTOR }));
        expect((await memberRow(r.rowId))?.deactivated_at).not.toBeNull();

        const returned = await withTenantRls(prisma, r.t, (tx) => returnToTenant(tx, r.t, [r.u], { actor: ACTOR }));

        expect(returned.userIds).toEqual([r.u]);
        expect(await tenantRow(r.t, r.u)).toEqual({ deactivated_at: null });
        expect((await memberRow(r.rowId))?.deactivated_at).toBeNull();
      });
    });

    it("catalog: team_members_tenant_id_user_id_idx exists on (tenant_id, user_id)", async () => {
      const rows = await sql<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE c.relname = 'team_members_tenant_id_user_id_idx' AND i.indrelid = 'team_members'::regclass
          GROUP BY c.oid`,
      );
      expect(rows).toEqual([{ columns: ["tenant_id", "user_id"] }]);
    });
  });

  // ── T5: races ─────────────────────────────────────────────────

  describe("T5: races", () => {
    /** A passwd_app transaction under tenant context with a bounded lock wait. */
    async function openRaceClient(t: string): Promise<{ client: pg.PoolClient; pid: number }> {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '10s'");
        await tenantGucs(client, t);
        const { rows: [iso] } = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
        expect(iso.transaction_isolation).toBe("read committed");
        const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return { client, pid };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        client.release(true);
        throw e;
      }
    }

    /** Let the client's in-flight statement settle, then roll back and release it. */
    async function closeRaceClient(client: pg.PoolClient, pending?: Promise<unknown>): Promise<void> {
      await pending?.catch(() => {});
      let broken: Error | undefined;
      await client.query("ROLLBACK").catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      client.release(broken);
    }

    /**
     * The held side, through the application's own lock helper with UPPER-CASE
     * ids: the key the TypeScript takes must be the one the trigger takes.
     */
    async function holdWithAppLock(
      t: string,
      lock: "lockTenantRows" | "lockTenantMemberCreation",
      u: string,
      write: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ): Promise<HeldWriter> {
      let isolation = "";
      const held = await holdPrismaWriter(ctx.app.prisma, async (tx) => {
        await setTenantGucs(tx, t);
        [{ transaction_isolation: isolation }] = await tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
        if (lock === "lockTenantRows") await lockTenantRows(tx, t.toUpperCase(), [u.toUpperCase()], "update");
        else await lockTenantMemberCreation(tx, t.toUpperCase(), u.toUpperCase());
        await write(tx);
      }, HOLD_MS);
      expect(isolation).toBe("read committed");
      return held;
    }

    /** The three-way witness: blocked by the held pid, on an advisory lock, in `statement`. */
    async function expectAdvisoryWait(heldPid: number, waiterPid: number, statement: RegExp): Promise<void> {
      expect(await race.waitForBackendBlockedBy(heldPid)).toBe(waiterPid);
      const { rows } = await ctx.su.pool.query<{ locktype: string }>(
        `SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted`, [waiterPid],
      );
      expect(rows).toEqual([{ locktype: "advisory" }]);
      expect(await race.waitingQueryOf(waiterPid)).toMatch(statement);
    }

    /** A team, a MEMBER, and (optionally) their row. */
    async function raceFixture(o: { row?: "active" | "ended" | "none" } = {}) {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const now = await clock();
      const rowId = o.row === "none" ? null : await addRow(t, teamId, u, {
        createdAt: now - HOUR,
        deactivatedAt: o.row === "ended" ? now - 30 * MINUTE : undefined,
      });
      // Pre-state: the tenant row active, no departure record.
      expect(await tenantRow(t, u)).toEqual({ deactivated_at: null });
      expect(await sql(`SELECT 1 FROM tenant_member_departures WHERE tenant_id = $1::uuid`, t)).toEqual([]);
      return { t, teamId, u, rowId };
    }

    describe("R1: a re-activation against a raw stamp", () => {
      it("the re-activation holds the key: the stamp's COMMIT waits, then is refused", async () => {
        const f = await raceFixture({ row: "ended" });
        const held = await holdWithAppLock(f.t, "lockTenantMemberCreation", f.u, (tx) =>
          tx.$executeRaw`UPDATE team_members SET deactivated_at = NULL WHERE id = ${f.rowId}::uuid`);
        const { client, pid } = await openRaceClient(f.t);
        let commit: Promise<unknown> | undefined;
        try {
          await client.query(STAMP_NOW, [f.t, f.u]);
          commit = client.query("COMMIT");
          commit.catch(() => {});
          await expectAdvisoryWait(held.pid, pid, /^COMMIT$/);

          await held.release();
          expectGuardError(await commit.then(() => null, (e: unknown) => e), ARM.DEPARTURE_ACTIVE);
        } finally {
          await held.abort();
          await closeRaceClient(client, commit);
        }
        expect(await tenantRow(f.t, f.u)).toEqual({ deactivated_at: null });
        expect((await memberRow(f.rowId!))?.deactivated_at).toBeNull();
      });

      it("the stamp holds the key: the re-activation waits, then is refused", async () => {
        const f = await raceFixture({ row: "ended" });
        const held = await holdWithAppLock(f.t, "lockTenantRows", f.u, (tx) =>
          tx.$executeRaw`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = ${f.t}::uuid AND user_id = ${f.u}::uuid`);
        const { client, pid } = await openRaceClient(f.t);
        let reactivate: Promise<unknown> | undefined;
        try {
          reactivate = client.query(`UPDATE team_members SET deactivated_at = NULL WHERE id = $1::uuid`, [f.rowId]);
          reactivate.catch(() => {});
          await expectAdvisoryWait(held.pid, pid, /UPDATE team_members SET deactivated_at = NULL/);

          await held.release();
          expectGuardError(await reactivate.then(() => null, (e: unknown) => e), ARM.ACTIVATION_DEPARTED);
        } finally {
          await held.abort();
          await closeRaceClient(client, reactivate);
        }
        expect((await tenantRow(f.t, f.u))?.deactivated_at).not.toBeNull();
        expect((await memberRow(f.rowId!))?.deactivated_at).not.toBeNull();
      });
    });

    describe("R2: an INSERT against a departure", () => {
      it("the departure holds the key: the INSERT waits, then is refused", async () => {
        const f = await raceFixture({ row: "none" });
        const held = await holdWithAppLock(f.t, "lockTenantRows", f.u, (tx) =>
          tx.$executeRaw`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = ${f.t}::uuid AND user_id = ${f.u}::uuid`);
        const { client, pid } = await openRaceClient(f.t);
        let insert: Promise<unknown> | undefined;
        try {
          insert = client.query(insertRow({ tenantId: f.t }), [f.teamId, f.u]);
          insert.catch(() => {});
          await expectAdvisoryWait(held.pid, pid, /INSERT INTO team_members/);

          await held.release();
          expectGuardError(await insert.then(() => null, (e: unknown) => e), ARM.ACTIVATION_DEPARTED);
        } finally {
          await held.abort();
          await closeRaceClient(client, insert);
        }
        expect((await tenantRow(f.t, f.u))?.deactivated_at).not.toBeNull();
        expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, f.teamId)).toEqual([]);
      });

      it("the INSERT holds the key: the stamp's COMMIT waits, then is refused", async () => {
        const f = await raceFixture({ row: "none" });
        const held = await holdWithAppLock(f.t, "lockTenantMemberCreation", f.u, (tx) =>
          tx.$executeRawUnsafe(insertRow({ tenantId: f.t }), f.teamId, f.u));
        const { client, pid } = await openRaceClient(f.t);
        let commit: Promise<unknown> | undefined;
        try {
          await client.query(STAMP_NOW, [f.t, f.u]);
          commit = client.query("COMMIT");
          commit.catch(() => {});
          await expectAdvisoryWait(held.pid, pid, /^COMMIT$/);

          await held.release();
          expectGuardError(await commit.then(() => null, (e: unknown) => e), ARM.DEPARTURE_ACTIVE);
        } finally {
          await held.abort();
          await closeRaceClient(client, commit);
        }
        expect(await tenantRow(f.t, f.u)).toEqual({ deactivated_at: null });
        expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid AND deactivated_at IS NULL`, f.teamId)).toHaveLength(1);
      });
    });

    it("R3: a grant runs through a held departure (no lock); the departure is then refused at commit", async () => {
      const f = await raceFixture({ row: "active" });
      const held = await holdWithAppLock(f.t, "lockTenantRows", f.u, (tx) =>
        tx.$executeRaw`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = ${f.t}::uuid AND user_id = ${f.u}::uuid`);
      const { client } = await openRaceClient(f.t);
      try {
        // A grant that took the key would wait on the held departure and hit this.
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query(`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [f.rowId]);
        await client.query("COMMIT");
        expect(await race.backendsBlockedBy(held.pid)).toEqual([]);

        const error = await held.release().then(() => null, (e: unknown) => e);
        expectGuardError(error, ARM.DEPARTURE_ACTIVE);
      } finally {
        await held.abort();
        await closeRaceClient(client);
      }
      expect(await memberRow(f.rowId!)).toMatchObject({ role: "ADMIN", deactivated_at: null });
      expect(await tenantRow(f.t, f.u)).toEqual({ deactivated_at: null });
    });

    it("scenario 5: rotate-key's transaction against deactivateScimUser of a key holder — both commit, no 40P01", async () => {
      const t = await tenant();
      const owner = await ctx.createUser(t);
      const holder = await member(t);
      // The departure locks the holder's teams in id order: it parks on the lower
      // one (held by the blocker) before touching the rotated one.
      const [parkedTeam, rotatedTeam] = [randomUUID(), randomUUID()].sort();
      await team(t, parkedTeam);
      await team(t, rotatedTeam);
      const now = await clock();
      await addRow(t, rotatedTeam, owner, { role: "OWNER", createdAt: now - 2 * HOUR });
      await addKey(t, rotatedTeam, owner);
      for (const teamId of [parkedTeam, rotatedTeam]) {
        await addRow(t, teamId, holder, { createdAt: now - HOUR });
        await addKey(t, teamId, holder);
      }

      const blocker = await ctx.su.pool.connect();
      let blockerOpen = false;
      let departure: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        blockerOpen = true;
        await blocker.query(`SELECT 1 FROM teams WHERE id = $1::uuid FOR UPDATE`, [parkedTeam]);
        const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

        departure = withTenantRls(prisma, t, () => deactivateScimUser(t, holder), { timeout: 15_000 });
        departure.catch(() => {});
        // Parked holding the holder's key and tenant row, its record written.
        const departurePid = await race.waitForBackendBlockedBy(blockerPid);
        expect(await race.waitingQueryOf(departurePid)).toMatch(/FROM teams .*FOR SHARE/s);

        mockAuth.mockResolvedValue({ user: { id: owner } });
        const rotation = rotateKeyRoute(
          new NextRequest(`http://localhost/api/teams/${rotatedTeam}/rotate-key`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              newTeamKeyVersion: 2,
              entries: [],
              memberKeys: [owner, holder].map((userId) => ({
                userId,
                encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
                ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion: 2, wrapVersion: 1,
              })),
            }),
          }),
          { params: Promise.resolve({ teamId: rotatedTeam }) },
        );
        // The rotation (key rows for the holder) never waits on the parked departure.
        expect(await race.settledOrBlocked(rotation, departurePid, blockerPid)).toBe("settled");
        expect((await rotation).status).toBe(200);

        await blocker.query("COMMIT");
        blockerOpen = false;
        await departure;
      } finally {
        if (blockerOpen) await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (departure) await departure.catch(() => {});
      }

      const [version] = await sql<{ team_key_version: number }>(`SELECT team_key_version FROM teams WHERE id = $1::uuid`, rotatedTeam);
      expect(version.team_key_version).toBe(2);
      expect(await sql(`SELECT 1 FROM team_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, holder)).toEqual([]);
      expect(await sql(`SELECT 1 FROM team_member_keys WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, holder)).toEqual([]);
      expect(await tenantRow(t, holder)).toBeNull();
    });
  });

  // ── T6: bypass and seeds ──────────────────────────────────────

  describe("T6: bypass and seeds", () => {
    const PRIOR = (tables: string, tenantId: string): GucState => ({
      rls: "on", tables, purpose: BYPASS_PURPOSE.SYSTEM_MAINTENANCE, tenant: tenantId,
    });

    async function withAppClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await appPool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        return await fn(client);
      } finally {
        await client.query("ROLLBACK").catch((e: unknown) => {
          broken = e instanceof Error ? e : new Error(String(e));
        });
        client.release(broken);
      }
    }

    async function setPrior(client: pg.PoolClient, prior: GucState): Promise<void> {
      await client.query(
        `SELECT set_config('app.bypass_rls', $1, true), set_config('app.bypass_tables', $2, true),
                set_config('app.bypass_purpose', $3, true), set_config('app.tenant_id', $4, true)`,
        [prior.rls, prior.tables, prior.purpose, prior.tenant],
      );
    }

    /** The read must be the transaction's last statement: the refusal aborts it. */
    async function expectRefusedRead(client: pg.PoolClient, table: string): Promise<void> {
      const { table: refused } = await expectBypassRefusal(() => client.query(`SELECT count(*) FROM ${table}`));
      expect(refused).toBe(table);
    }

    it("under a team_members-only bypass, a passing guarded write restores the settings; tenant_members is still refused", async () => {
      const r = await memberTeam();
      await withAppClient(async (client) => {
        const prior = PRIOR("team_members", r.t);
        await setPrior(client, prior);
        await client.query(`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [r.rowId]);
        expect(await readGucs(client)).toEqual(prior);
        await expectRefusedRead(client, "tenant_members");
      });
    });

    it("under a team_members-only bypass, a refused guarded write leaves the settings; tenant_members is still refused", async () => {
      const r = await memberTeam();
      await residue(r.t, r.u, r.admitted + 30 * MINUTE);
      await withAppClient(async (client) => {
        const prior = PRIOR("team_members", r.t);
        await setPrior(client, prior);
        await client.query("SAVEPOINT s");
        expectGuardError(
          await client.query(`UPDATE team_members SET role = 'ADMIN' WHERE id = $1::uuid`, [r.rowId]).then(() => null, (e: unknown) => e),
          ARM.GRANT_LEFTOVER,
        );
        await client.query("ROLLBACK TO SAVEPOINT s");
        expect(await readGucs(client)).toEqual(prior);
        await expectRefusedRead(client, "tenant_members");
      });
    });

    it("the deferred check, passing, restores the settings; tenant_member_departures is still refused", async () => {
      const r = await memberTeam();
      await withAppClient(async (client) => {
        const prior = PRIOR("tenant_members,team_members", r.t);
        await setPrior(client, prior);
        await client.query(`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]);
        await client.query(`UPDATE team_members SET deactivated_at = clock_timestamp() WHERE id = $1::uuid`, [r.rowId]);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(await readGucs(client)).toEqual(prior);
        await expectRefusedRead(client, "tenant_member_departures");
      });
    });

    it("the deferred check, refusing, leaves the settings; tenant_member_departures is still refused", async () => {
      const r = await memberTeam();
      await withAppClient(async (client) => {
        const prior = PRIOR("tenant_members,team_members", r.t);
        await setPrior(client, prior);
        await client.query("SAVEPOINT s");
        await client.query(`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]);
        expectGuardError(await client.query("SET CONSTRAINTS ALL IMMEDIATE").then(() => null, (e: unknown) => e), ARM.DEPARTURE_ACTIVE);
        await client.query("ROLLBACK TO SAVEPOINT s");
        expect(await readGucs(client)).toEqual(prior);
        await expectRefusedRead(client, "tenant_member_departures");
      });
    });

    it("passwd_app cannot SET session_replication_role", async () => {
      const error = await withAppClient((client) =>
        client.query("SET LOCAL session_replication_role = replica").then(() => null, (e: unknown) => e));
      expect(sqlStateOf(error)).toBe("42501");
    });

    describe("writeRefusedState leaves its connection as it found it", () => {
      let su1: PrismaWithPool;

      beforeAll(() => {
        // One connection, so "the same client" is the same backend.
        su1 = createPrismaForRole("superuser", { max: 1 });
      });

      afterAll(async () => {
        await su1.prisma.$disconnect();
        await su1.pool.end();
      });

      async function backend(): Promise<{ pid: number; role: string }> {
        const { rows: [row] } = await su1.pool.query<{ pid: number; role: string }>(
          `SELECT pg_backend_pid() AS pid, current_setting('session_replication_role') AS role`,
        );
        return row;
      }

      /** A violating write on that connection: a stamp leaving an active row, refused at commit. */
      async function expectGuardOn(r: { t: string; u: string }): Promise<void> {
        const client = await su1.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, [r.t, r.u]);
          expectGuardError(await client.query("COMMIT").then(() => null, (e: unknown) => e), ARM.DEPARTURE_ACTIVE);
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      }

      it.each([
        ["a successful call", false],
        ["a refused call (the statement fails)", true],
      ] as const)("after %s: session_replication_role = origin, and the guard refuses a violating write", async (_label, fails) => {
        const r = await memberTeam();
        const victim = await memberTeam();
        const before = await backend();
        expect(before.role).toBe("origin");

        const call = writeRefusedState(
          su1,
          fails
            ? `UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND 1 / 0 = 1`
            : `UPDATE tenant_members SET deactivated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND user_id = $2::uuid RETURNING 1`,
          [r.t, r.u],
        );
        if (fails) expect(sqlStateOf(await call.then(() => null, (e: unknown) => e))).toBe("22012");
        else expect(await call).toHaveLength(1);

        expect(await backend()).toEqual({ pid: before.pid, role: "origin" });
        await expectGuardOn(victim);
        expect(await tenantRow(victim.t, victim.u)).toEqual({ deactivated_at: null });
        // The refused state was written by the successful call only.
        expect((await tenantRow(r.t, r.u))?.deactivated_at === null).toBe(fails);
      });

      it("refuses more than one statement", async () => {
        const error = await writeRefusedState(su1, `SELECT 1; SELECT 2`).then(() => null, (e: unknown) => e);
        // 42601: the extended protocol refuses a multi-command string.
        expect(sqlStateOf(error)).toBe("42601");
        expect((await backend()).role).toBe("origin");
      });
    });
  });
});
