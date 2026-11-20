/**
 * Integration test (real DB): a wrapped team key is written for a recipient
 * only while the fingerprint the client claims is that of the recipient's
 * current ECDH public key, and that key cannot be retired while a key row or a
 * distributed flag for them survives
 * (docs/archive/review/team-key-recipient-binding-plan.md C2, C3, C9).
 *
 * - C2: team_key_recipient_guard() on team_member_keys (four arms, the judged
 *   column list, its scoped bypass and pinned search_path).
 * - C3: users_ecdh_key_guard() on users (no overwrite, no retirement with keys,
 *   the FOR UPDATE upgrade that serialises a retirement behind a writer).
 * - C9: the migration's one-time residue repair, run as the application role.
 * - The writer routes' 409 mapping and the serving endpoints' round trip.
 *
 * Raw writes run on passwd_app under tenant context. Every refusal asserts
 * SQLSTATE 23514 with its `TEAM_KEY_RECIPIENT_GUARD:<arm>` token and that
 * nothing was written; every guard has a paired allow cell. States the guards
 * refuse (a key changed under a key row, legacy NULL-fingerprint rows, residue)
 * are seeded through writeRefusedState. One tenant per cell (two where the
 * subject spans tenants), deleted after the cell and swept by ctx.cleanup().
 *
 * Run: npm run test:integration -- team-key-recipient-binding
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import type pg from "pg";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  appConnectionString,
  assertRlsApplies,
  collectNotices,
  createTestContext,
  gucSentinels,
  guardArmOf,
  parseNoticeCounts,
  readBackfillBlock,
  readGucs,
  recipientKey,
  seedVaultUser,
  setBypassRlsGucs,
  setGucs,
  setTestBypass,
  sqlStateOf,
  TEAM_KEY_RECIPIENT_BINDING_DIR,
  writeRefusedState,
  type GucState,
  type TestContext,
} from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { FINGERPRINT_VECTOR_HEX, FINGERPRINT_VECTOR_JWK } from "../fixtures/team-key-fingerprint-vector";

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

import { POST as confirmKeyRoute } from "@/app/api/teams/[teamId]/members/[memberId]/confirm-key/route";
import { POST as rotateKeyRoute } from "@/app/api/teams/[teamId]/rotate-key/route";
import { GET as rotateKeyDataRoute } from "@/app/api/teams/[teamId]/rotate-key/data/route";
import { GET as pendingKeyDistributionsRoute } from "@/app/api/teams/pending-key-distributions/route";
import { POST as createTeamRoute } from "@/app/api/teams/route";
import { POST as vaultSetupRoute } from "@/app/api/vault/setup/route";
import { GET as unlockDataRoute } from "@/app/api/vault/unlock/data/route";
import { createPool } from "@/lib/db/pool-factory";
import { prisma } from "@/lib/prisma";
import { SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";
import { recipientKeyFingerprint } from "@/lib/crypto/crypto-team";
import { executeVaultReset } from "@/lib/vault/vault-reset";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

const hex = (n: number) => randomBytes(n).toString("hex");
const RESIDUE_BLOCK = "team-key-residue";
const RECIPIENT_GUARD = "TEAM_KEY_RECIPIENT_GUARD";
const DEPARTED_GUARD = "DEPARTED_MEMBER_GUARD";

const ARM = {
  FINGERPRINT_MISSING: "fingerprint_missing",
  FINGERPRINT_REBIND: "fingerprint_rebind",
  RECIPIENT_NO_KEY: "recipient_no_key",
  RECIPIENT_KEY_CHANGED: "recipient_key_changed",
  ECDH_KEY_OVERWRITE: "ecdh_key_overwrite",
  ECDH_KEY_CHANGE_WITH_KEYS: "ecdh_key_change_with_keys",
} as const;
type Arm = (typeof ARM)[keyof typeof ARM];

/** What a write ended as: the refusing guard's arm, else its SQLSTATE. */
function outcomeOf(error: unknown): string {
  return guardArmOf(error, RECIPIENT_GUARD) ?? guardArmOf(error, DEPARTED_GUARD) ?? sqlStateOf(error) ?? "none";
}

// Failures name the actual outcome (`actual=`), so a red-proof can tell a
// refusal that went away from one that changed arms or guards.
function expectGuardError(error: unknown, arm: string, prefix: string = RECIPIENT_GUARD): void {
  const actual = error === null ? "committed" : outcomeOf(error);
  expect({ code: sqlStateOf(error), arm: guardArmOf(error, prefix) }, `actual=${actual}`)
    .toEqual({ code: SQLSTATE_CHECK_VIOLATION, arm });
}

/** A write that must have committed: names what refused it otherwise. */
function expectAllowed(error: unknown): void {
  if (error === null) return;
  throw new Error(
    `expected the write to commit (actual=${outcomeOf(error)}): ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A wrap body (confirm-key, a rotate-key member key, teams POST's teamMemberKey). */
function wrapBody(keyVersion: number, recipientKeyFingerprint: string) {
  return {
    encryptedTeamKey: hex(32), teamKeyIv: hex(12), teamKeyAuthTag: hex(16),
    ephemeralPublicKey: hex(32), hkdfSalt: hex(32), keyVersion, wrapVersion: 1,
    recipientKeyFingerprint,
  };
}

/** A fingerprint of a key nobody holds. */
async function strangerFingerprint(): Promise<string> {
  return recipientKeyFingerprint(JSON.stringify({ kty: "EC", crv: "P-256", x: randomUUID(), y: "stranger" }));
}

/** A JWK-shaped key with non-ASCII characters, so a round trip exercises the UTF-8 hashing on both sides. */
const nonAsciiKey = (userId: string) => JSON.stringify({ kty: "EC", crv: "P-256", x: `café-${userId}`, y: "ÿ-coord" });

describe("team-key recipient binding — real-DB integration", () => {
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

  async function tenantGucs(client: pg.PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', 'off', true),
              set_config('app.bypass_tables', '', true)`,
      [tenantId],
    );
  }

  /** `fn` in a passwd_app transaction under `t`'s context, always rolled back. */
  async function withAppTx<T>(t: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await appPool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      await tenantGucs(client, t);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      client.release(broken);
    }
  }

  /** One statement as passwd_app under `t`'s context, committed when it succeeds; the error, or null. */
  async function asApp(t: string, text: string, params: readonly unknown[] = []): Promise<unknown> {
    const client = await appPool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      await tenantGucs(client, t);
      try {
        await client.query(text, [...params]);
      } catch (error) {
        await client.query("ROLLBACK").catch((e: unknown) => {
          broken = e instanceof Error ? e : new Error(String(e));
        });
        return error;
      }
      await client.query("COMMIT");
      return null;
    } finally {
      client.release(broken);
    }
  }

  // ── Fixtures (superuser; every write goes through the guards) ────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  async function tenant(): Promise<string> {
    const id = await ctx.createTenant();
    cellTenants.push(id);
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

  /** A team_members row admitted an hour ago. */
  async function addRow(
    t: string,
    teamId: string,
    userId: string,
    o: { role?: string; keyDistributed?: boolean; ended?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, deactivated_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", $6,
               CASE WHEN $7 THEN now() - interval '30 minutes' END, now() - interval '1 hour', now())`,
      id, teamId, userId, t, o.role ?? "MEMBER", o.keyDistributed ?? true, o.ended ?? false,
    );
    return id;
  }

  /** A tenant MEMBER (createUser makes OWNERs). */
  async function member(t: string): Promise<string> {
    const id = await ctx.createUser(t);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, t, id);
    return id;
  }

  /** Give a user `key` while their key is NULL (NULL -> P, which the guard allows). */
  async function setKey(userId: string, key: string): Promise<void> {
    const rows = await sql(`UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid AND ecdh_public_key IS NULL RETURNING 1`, userId, key);
    expect(rows).toHaveLength(1);
  }

  /** Change a user's key under their key rows (refused since the guard: P -> P' or P -> NULL). */
  async function changeKey(userId: string, key: string | null): Promise<void> {
    const rows = await writeRefusedState(
      ctx.su,
      `UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid RETURNING 1`,
      [userId, key],
    );
    expect(rows).toHaveLength(1);
  }

  const KEY_COLUMNS = `id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
    ephemeral_public_key, hkdf_salt, key_version, wrap_version, recipient_key_fingerprint, created_at, updated_at`;

  /** INSERT of a key row: $1 id, $2 team, $3 tenant, $4 user, $5 key version, $6 fingerprint. */
  const INSERT_KEY = `INSERT INTO team_member_keys (${KEY_COLUMNS})
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '${hex(32)}', '${hex(12)}', '${hex(16)}',
            '${hex(32)}', '${hex(32)}', $5, 1, $6, now(), now())`;

  type KeyTarget = { t: string; teamId: string; u: string };

  const insertKeyParams = (f: KeyTarget, fingerprint: string | null, o: { id?: string; version?: number } = {}) =>
    [o.id ?? randomUUID(), f.teamId, f.t, f.u, o.version ?? 1, fingerprint] as const;

  /** A committed key row through both guards; returns its id. */
  async function addKey(f: KeyTarget, fingerprint: string, version = 1): Promise<string> {
    const id = randomUUID();
    await sql(INSERT_KEY, ...insertKeyParams(f, fingerprint, { id, version }));
    return id;
  }

  /** A legacy key row (written before the guard) carrying `fingerprint`, NULL by default. */
  async function addLegacyKey(f: KeyTarget, fingerprint: string | null = null, version = 1): Promise<string> {
    const id = randomUUID();
    const rows = await writeRefusedState(ctx.su, `${INSERT_KEY} RETURNING 1`, insertKeyParams(f, fingerprint, { id, version }));
    expect(rows).toHaveLength(1);
    return id;
  }

  /** The whole key row, to show a refused write changed nothing. */
  async function keyRow(id: string): Promise<Record<string, unknown> | null> {
    const [row] = await sql<{ row: Record<string, unknown> }>(`SELECT to_jsonb(k) AS row FROM team_member_keys k WHERE id = $1::uuid`, id);
    return row?.row ?? null;
  }

  async function keyRows(teamId: string, userId: string) {
    return sql<{ key_version: number; recipient_key_fingerprint: string | null }>(
      `SELECT key_version, recipient_key_fingerprint FROM team_member_keys
        WHERE team_id = $1::uuid AND user_id = $2::uuid ORDER BY key_version`,
      teamId, userId,
    );
  }

  async function ecdhKey(userId: string): Promise<string | null> {
    const [row] = await sql<{ ecdh_public_key: string | null }>(`SELECT ecdh_public_key FROM users WHERE id = $1::uuid`, userId);
    return row.ecdh_public_key;
  }

  /** The trigger's view of a user's key: the SQL expression it compares against. */
  async function dbFingerprint(userId: string): Promise<string | null> {
    const [row] = await sql<{ fp: string | null }>(
      `SELECT encode(sha256(convert_to(ecdh_public_key, 'UTF8')), 'hex') AS fp FROM users WHERE id = $1::uuid`,
      userId,
    );
    return row.fp;
  }

  async function distributed(rowId: string): Promise<boolean> {
    const [row] = await sql<{ key_distributed: boolean }>(`SELECT key_distributed FROM team_members WHERE id = $1::uuid`, rowId);
    return row.key_distributed;
  }

  /** A tenant, a team and a MEMBER with a key and an active, undistributed row. */
  async function recipientTeam(o: { keyed?: boolean } = {}) {
    const t = await tenant();
    const teamId = await team(t);
    const u = await member(t);
    const rowId = await addRow(t, teamId, u, { keyDistributed: false });
    const key = o.keyed === false ? null : await recipientKey(ctx.su, u);
    return { t, teamId, u, rowId, key };
  }

  // ── C2: the key-row guard ─────────────────────────────────────

  describe("C2: team_key_recipient_guard arms", () => {
    it("fingerprint_missing: an INSERT without a fingerprint is refused; no row", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      expectGuardError(await asApp(f.t, INSERT_KEY, insertKeyParams(f, null, { id })), ARM.FINGERPRINT_MISSING);
      expect(await keyRow(id)).toBeNull();
    });

    it("recipient_no_key: an INSERT for a recipient with no key is refused; no row", async () => {
      const f = await recipientTeam({ keyed: false });
      expect(await ecdhKey(f.u)).toBeNull();
      const id = randomUUID();
      expectGuardError(await asApp(f.t, INSERT_KEY, insertKeyParams(f, await strangerFingerprint(), { id })), ARM.RECIPIENT_NO_KEY);
      expect(await keyRow(id)).toBeNull();
    });

    it("recipient_no_key: an INSERT naming no users row is refused (before the foreign key); no row", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      const error = await asApp(f.t, INSERT_KEY, insertKeyParams({ ...f, u: randomUUID() }, f.key!.fingerprint, { id }));
      expectGuardError(error, ARM.RECIPIENT_NO_KEY);
      expect(await keyRow(id)).toBeNull();
    });

    it("recipient_key_changed: an INSERT whose fingerprint names another key is refused; no row", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      expectGuardError(await asApp(f.t, INSERT_KEY, insertKeyParams(f, await strangerFingerprint(), { id })), ARM.RECIPIENT_KEY_CHANGED);
      expect(await keyRow(id)).toBeNull();
    });

    it("fingerprint_rebind: attaching a fingerprint to a legacy row whose wrap is unchanged is refused; it keeps NULL", async () => {
      const f = await recipientTeam();
      const id = await addLegacyKey(f);
      const before = await keyRow(id);
      expect(before).toMatchObject({ recipient_key_fingerprint: null });
      // The fingerprint even matches the recipient's key: the binding was never checked.
      const error = await asApp(f.t, `UPDATE team_member_keys SET recipient_key_fingerprint = $2 WHERE id = $1::uuid`, [id, f.key!.fingerprint]);
      expectGuardError(error, ARM.FINGERPRINT_REBIND);
      expect(await keyRow(id)).toEqual(before);
    });

    it("allows an INSERT whose fingerprint matches the recipient's key, and stores it", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      expectAllowed(await asApp(f.t, INSERT_KEY, insertKeyParams(f, f.key!.fingerprint, { id })));
      expect(await keyRow(id)).toMatchObject({ recipient_key_fingerprint: f.key!.fingerprint });
      expect(await dbFingerprint(f.u)).toBe(f.key!.fingerprint);
    });

    it("allows a matching INSERT for a cross-tenant guest, whose users row the writer's tenant cannot see", async () => {
      const t = await tenant();
      const home = await tenant();
      const teamId = await team(t);
      const guestId = await ctx.createUser(home);
      await addRow(t, teamId, guestId, { keyDistributed: false });
      const { fingerprint } = await recipientKey(ctx.su, guestId);
      const f = { t, teamId, u: guestId };
      // The precondition: under the team's tenant the guest's users row is hidden,
      // so only the guard's own scoped bypass can read their key.
      const visible = await withAppTx(t, async (client) =>
        (await client.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [guestId])).rowCount);
      expect(visible).toBe(0);

      const id = randomUUID();
      expectAllowed(await asApp(t, INSERT_KEY, insertKeyParams(f, fingerprint, { id })));
      expect(await keyRow(id)).toMatchObject({ user_id: guestId, recipient_key_fingerprint: fingerprint });
    });

    it("allows a DELETE of a key row", async () => {
      const f = await recipientTeam();
      const id = await addKey(f, f.key!.fingerprint);
      expectAllowed(await asApp(f.t, `DELETE FROM team_member_keys WHERE id = $1::uuid`, [id]));
      expect(await keyRow(id)).toBeNull();
    });

    it("allows a wrap-untouched UPDATE of a legacy NULL-fingerprint row", async () => {
      const f = await recipientTeam();
      const id = await addLegacyKey(f);
      const before = await keyRow(id);
      expectAllowed(await asApp(f.t, `UPDATE team_member_keys SET updated_at = now() + interval '1 minute' WHERE id = $1::uuid`, [id]));
      const after = await keyRow(id);
      expect(after?.updated_at).not.toEqual(before?.updated_at);
      expect({ ...after, updated_at: null }).toEqual({ ...before, updated_at: null });
    });
  });

  describe("C2: the judged column list, on a row whose recipient's key no longer matches", () => {
    /** A key row bound to the recipient's key, then the key changed under it; and another keyed user. */
    async function mismatchedRow() {
      const f = await recipientTeam();
      const id = await addKey(f, f.key!.fingerprint);
      const replacement = JSON.stringify({ kty: "EC", crv: "P-256", x: f.u, y: "replacement" });
      await changeKey(f.u, replacement);
      const other = await member(f.t);
      await addRow(f.t, f.teamId, other, { keyDistributed: false });
      await recipientKey(ctx.su, other);
      return { ...f, id, replacementFingerprint: await recipientKeyFingerprint(replacement), other };
    }

    type Fixture = Awaited<ReturnType<typeof mismatchedRow>>;
    const JUDGED: readonly (readonly [string, (r: Fixture) => unknown, Arm])[] = [
      // Re-pointed to a user whose key the row's fingerprint does not name.
      ["user_id", (r) => r.other, ARM.RECIPIENT_KEY_CHANGED],
      ["encrypted_team_key", () => hex(32), ARM.RECIPIENT_KEY_CHANGED],
      ["team_key_iv", () => hex(12), ARM.RECIPIENT_KEY_CHANGED],
      ["team_key_auth_tag", () => hex(16), ARM.RECIPIENT_KEY_CHANGED],
      ["ephemeral_public_key", () => hex(32), ARM.RECIPIENT_KEY_CHANGED],
      ["hkdf_salt", () => hex(32), ARM.RECIPIENT_KEY_CHANGED],
      ["wrap_version", () => 2, ARM.RECIPIENT_KEY_CHANGED],
      ["key_version", () => 2, ARM.RECIPIENT_KEY_CHANGED],
      // Alone, and even naming the current key: an unchecked binding.
      ["recipient_key_fingerprint", (r) => r.replacementFingerprint, ARM.FINGERPRINT_REBIND],
    ];

    it.each(JUDGED)("an UPDATE of %s is judged and refused; the row is unchanged", async (column, value, arm) => {
      const r = await mismatchedRow();
      const before = await keyRow(r.id);
      const cast = column === "user_id" ? "::uuid" : "";
      const error = await asApp(r.t, `UPDATE team_member_keys SET ${column} = $2${cast} WHERE id = $1::uuid`, [r.id, value(r)]);
      expectGuardError(error, arm);
      expect(await keyRow(r.id)).toEqual(before);
    });

    it("an UPDATE of a column outside the list (updated_at) is not judged", async () => {
      const r = await mismatchedRow();
      const before = await keyRow(r.id);
      expectAllowed(await asApp(r.t, `UPDATE team_member_keys SET updated_at = now() + interval '1 minute' WHERE id = $1::uuid`, [r.id]));
      const after = await keyRow(r.id);
      expect(after?.updated_at).not.toEqual(before?.updated_at);
    });
  });

  describe("C2: the judged column list, on a row bound to the recipient's current key", () => {
    /** A key row bound to the recipient's current key; and another member holding the same key string. */
    async function boundRow() {
      const f = await recipientTeam();
      const id = await addKey(f, f.key!.fingerprint);
      const twin = await member(f.t);
      await addRow(f.t, f.teamId, twin, { keyDistributed: false });
      await setKey(twin, f.key!.publicKey);
      return { ...f, id, twin };
    }

    type Fixture = Awaited<ReturnType<typeof boundRow>>;
    const REWRITES: readonly (readonly [string, (r: Fixture) => unknown])[] = [
      // Re-pointed to a user whose key the row's fingerprint also names.
      ["user_id", (r) => r.twin],
      ["encrypted_team_key", () => hex(32)],
      ["team_key_iv", () => hex(12)],
      ["team_key_auth_tag", () => hex(16)],
      ["ephemeral_public_key", () => hex(32)],
      ["hkdf_salt", () => hex(32)],
      ["wrap_version", () => 2],
      ["key_version", () => 2],
    ];

    it.each(REWRITES)("an UPDATE of %s keeping the matching fingerprint is judged and allowed; the column is rewritten", async (column, value) => {
      const r = await boundRow();
      const next = value(r);
      const cast = column === "user_id" ? "::uuid" : "";
      expectAllowed(await asApp(r.t, `UPDATE team_member_keys SET ${column} = $2${cast} WHERE id = $1::uuid`, [r.id, next]));
      expect(await keyRow(r.id)).toMatchObject({ [column]: next, recipient_key_fingerprint: r.key!.fingerprint });
    });
  });

  describe("C2/C3: the scoped bypass and the pinned search_path", () => {
    /** The caller's settings, as a block's sentinels, under `t` so the write passes RLS. */
    const prior = (t: string): GucState => ({ ...gucSentinels(), tenant: t });

    /** Users visible to the transaction among `ids`: RLS filters to the caller's tenant. */
    async function visibleUsers(client: pg.PoolClient, ids: string[]): Promise<string[]> {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
      return rows.map((r) => r.id);
    }

    it("after a guarded INSERT the bypass settings are the caller's again, and users is still RLS-filtered", async () => {
      const f = await recipientTeam();
      const foreign = await ctx.createUser(await tenant());
      await withAppTx(f.t, async (client) => {
        const settings = prior(f.t);
        await setGucs(client, settings);
        await client.query(INSERT_KEY, [...insertKeyParams(f, f.key!.fingerprint)]);
        expect(await readGucs(client)).toEqual(settings);
        expect(await visibleUsers(client, [f.u, foreign])).toEqual([f.u]);
      });
    });

    it("after a checked P -> NULL of a user with no keys the bypass settings are the caller's again, and users is still RLS-filtered", async () => {
      const f = await recipientTeam();
      const foreign = await ctx.createUser(await tenant());
      await withAppTx(f.t, async (client) => {
        const settings = prior(f.t);
        await setGucs(client, settings);
        const { rowCount } = await client.query(`UPDATE users SET ecdh_public_key = NULL WHERE id = $1::uuid`, [f.u]);
        expect(rowCount).toBe(1);
        expect(await readGucs(client)).toEqual(settings);
        expect(await visibleUsers(client, [f.u, foreign])).toEqual([f.u]);
      });
    });

    it("a guarded INSERT whose users read fails inside the bypass, rolled back to a savepoint, leaves the caller's settings", async () => {
      const f = await recipientTeam();
      const foreign = await ctx.createUser(await tenant());
      const held = await race.holdRowLock(`SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE`, [f.u]);
      try {
        await withAppTx(f.t, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '200ms'`);
          const settings = prior(f.t);
          await setGucs(client, settings);
          await client.query("SAVEPOINT guarded");
          const error = await client.query(INSERT_KEY, [...insertKeyParams(f, f.key!.fingerprint)]).then(() => null, (e: unknown) => e);
          // The precondition: the lock wait timed out in the guard's own read, with its bypass set.
          expect(sqlStateOf(error)).toBe("55P03");
          expect((error as { where?: string }).where).toMatch(/team_key_recipient_guard\(\)/);
          await client.query("ROLLBACK TO SAVEPOINT guarded");
          expect(await readGucs(client)).toEqual(settings);
          expect(await visibleUsers(client, [f.u, foreign])).toEqual([f.u]);
        });
      } finally {
        await held.release();
      }
    });

    it("a TEMP TABLE users holding a matching key does not shadow the guard's read: the write is still refused", async () => {
      const f = await recipientTeam();
      const shadowKey = JSON.stringify({ kty: "EC", crv: "P-256", x: f.u, y: "shadow" });
      const shadowFingerprint = await recipientKeyFingerprint(shadowKey);
      const id = randomUUID();
      const error = await withAppTx(f.t, async (client) => {
        await client.query(`CREATE TEMP TABLE users (id uuid, ecdh_public_key text) ON COMMIT DROP`);
        await client.query(`INSERT INTO pg_temp.users VALUES ($1::uuid, $2)`, [f.u, shadowKey]);
        // The precondition: an unqualified `users` in this session is the shadow.
        const { rows } = await client.query<{ ecdh_public_key: string }>(`SELECT ecdh_public_key FROM users WHERE id = $1::uuid`, [f.u]);
        expect(rows).toEqual([{ ecdh_public_key: shadowKey }]);
        return client.query(INSERT_KEY, [...insertKeyParams(f, shadowFingerprint, { id })]).then(() => null, (e: unknown) => e);
      });
      expectGuardError(error, ARM.RECIPIENT_KEY_CHANGED);
      expect(await keyRow(id)).toBeNull();
    });
  });

  // ── C3: the users key guard ───────────────────────────────────

  describe("C3: users_ecdh_key_guard", () => {
    const RETIRE = `UPDATE users SET ecdh_public_key = NULL WHERE id = $1::uuid`;

    it("ecdh_key_overwrite: P -> P' is refused; the key is unchanged", async () => {
      const f = await recipientTeam();
      const error = await asApp(f.t, `UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, [f.u, nonAsciiKey(f.u)]);
      expectGuardError(error, ARM.ECDH_KEY_OVERWRITE);
      expect(await ecdhKey(f.u)).toBe(f.key!.publicKey);
    });

    it("ecdh_key_change_with_keys: P -> NULL with a key row is refused; key and row unchanged", async () => {
      const f = await recipientTeam();
      const id = await addKey(f, f.key!.fingerprint);
      expectGuardError(await asApp(f.t, RETIRE, [f.u]), ARM.ECDH_KEY_CHANGE_WITH_KEYS);
      expect(await ecdhKey(f.u)).toBe(f.key!.publicKey);
      expect(await keyRow(id)).not.toBeNull();
    });

    it("ecdh_key_change_with_keys: P -> NULL with only a key_distributed = true membership is refused", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      const rowId = await addRow(t, teamId, u, { keyDistributed: true });
      const { publicKey } = await recipientKey(ctx.su, u);
      expect(await keyRows(teamId, u)).toEqual([]);
      expectGuardError(await asApp(t, RETIRE, [u]), ARM.ECDH_KEY_CHANGE_WITH_KEYS);
      expect(await ecdhKey(u)).toBe(publicKey);
      expect(await distributed(rowId)).toBe(true);
    });

    it("ecdh_key_change_with_keys: P -> NULL with a key row only in another tenant's team is refused", async () => {
      const home = await tenant();
      const other = await tenant();
      const teamId = await team(other);
      const u = await ctx.createUser(home);
      await addRow(other, teamId, u, { keyDistributed: false });
      const { publicKey, fingerprint } = await recipientKey(ctx.su, u);
      await addKey({ t: other, teamId, u }, fingerprint);
      expectGuardError(await asApp(home, RETIRE, [u]), ARM.ECDH_KEY_CHANGE_WITH_KEYS);
      expect(await ecdhKey(u)).toBe(publicKey);
    });

    it("allows P -> NULL for a user with no key row and no distributed flag", async () => {
      const f = await recipientTeam();
      expectAllowed(await asApp(f.t, RETIRE, [f.u]));
      expect(await ecdhKey(f.u)).toBeNull();
    });

    it("allows NULL -> P, also for a user holding a key_distributed = true membership", async () => {
      const t = await tenant();
      const teamId = await team(t);
      const u = await member(t);
      await addRow(t, teamId, u, { keyDistributed: true });
      expect(await ecdhKey(u)).toBeNull();
      const key = nonAsciiKey(u);
      expectAllowed(await asApp(t, `UPDATE users SET ecdh_public_key = $2 WHERE id = $1::uuid`, [u, key]));
      expect(await ecdhKey(u)).toBe(key);
    });

    it("executeVaultReset of a user holding keys in two tenants' teams passes: keys, flags and the key are gone", async () => {
      const home = await tenant();
      const other = await tenant();
      const u = await ctx.createUser(home);
      const { fingerprint } = await recipientKey(ctx.su, u);
      const rows: string[] = [];
      for (const t of [home, other]) {
        const teamId = await team(t);
        rows.push(await addRow(t, teamId, u, { keyDistributed: true }));
        await addKey({ t, teamId, u }, fingerprint);
      }

      await executeVaultReset(u);

      expect(await ecdhKey(u)).toBeNull();
      expect(await sql(`SELECT 1 FROM team_member_keys WHERE user_id = $1::uuid`, u)).toEqual([]);
      expect(await Promise.all(rows.map(distributed))).toEqual([false, false]);
    });
  });

  // ── Trigger order, twin vector ────────────────────────────────

  it("trigger order: a key row for an ended member with a mismatching fingerprint gets the departed guard's key_inactive", async () => {
    const t = await tenant();
    const teamId = await team(t);
    const u = await member(t);
    await addRow(t, teamId, u, { ended: true });
    await recipientKey(ctx.su, u);
    const id = randomUUID();
    const error = await asApp(t, INSERT_KEY, insertKeyParams({ t, teamId, u }, await strangerFingerprint(), { id }));
    expectGuardError(error, "key_inactive", DEPARTED_GUARD);
    expect(await keyRow(id)).toBeNull();
  });

  it("twin vector: the production fingerprint of a non-ASCII key is the trigger's; one flipped nibble is refused", async () => {
    const f = await recipientTeam({ keyed: false });
    await setKey(f.u, FINGERPRINT_VECTOR_JWK);
    const fingerprint = await recipientKeyFingerprint(FINGERPRINT_VECTOR_JWK);
    expect(fingerprint).toBe(FINGERPRINT_VECTOR_HEX);
    expect(await dbFingerprint(f.u)).toBe(FINGERPRINT_VECTOR_HEX);

    expectAllowed(await asApp(f.t, INSERT_KEY, insertKeyParams(f, fingerprint, { version: 1 })));
    const flipped = (parseInt(fingerprint[0], 16) ^ 1).toString(16) + fingerprint.slice(1);
    expectGuardError(await asApp(f.t, INSERT_KEY, insertKeyParams(f, flipped, { version: 2 })), ARM.RECIPIENT_KEY_CHANGED);
    expect(await keyRows(f.teamId, f.u)).toEqual([{ key_version: 1, recipient_key_fingerprint: FINGERPRINT_VECTOR_HEX }]);
  });

  // ── C9: the residue repair ────────────────────────────────────

  describe("C9: the migration's team-key residue repair", () => {
    /** Run `work` as the application role inside a transaction that is rolled back. */
    async function inRolledBackAppTransaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
      const pool = createPool({ connectionString: appConnectionString(), max: 1 });
      try {
        const client = await pool.connect();
        try {
          const [principal] = (
            await client.query<{ bypass: boolean; superuser: boolean }>(
              `SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
            )
          ).rows;
          expect(principal).toEqual({ bypass: false, superuser: false });
          await client.query("BEGIN");
          try {
            await work(client);
          } finally {
            await client.query("ROLLBACK");
          }
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    }

    const TABLES = ["users", "team_members", "team_member_keys"];

    /** Per user: key rows held, and their membership's flag. */
    async function states(client: pg.PoolClient, rows: Record<string, { u: string; rowId: string }>) {
      await setTestBypass(client, TABLES);
      const out: Record<string, { keyRows: number; distributed: boolean }> = {};
      for (const [name, { u, rowId }] of Object.entries(rows)) {
        const { rows: [k] } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM team_member_keys WHERE user_id = $1::uuid`, [u]);
        const { rows: [m] } = await client.query<{ key_distributed: boolean }>(`SELECT key_distributed FROM team_members WHERE id = $1::uuid`, [rowId]);
        out[name] = { keyRows: k.n, distributed: m.key_distributed };
      }
      return out;
    }

    it("repairs a residue user (active and ended membership), leaves a keyed user untouched, restores the settings", async () => {
      const t = await tenant();
      const teamId = await team(t);
      /** A key holder: a distributed row and a key row bound to their key. */
      async function holder(o: { ended?: boolean } = {}) {
        const u = await member(t);
        const rowId = await addRow(t, teamId, u, { keyDistributed: true });
        await addKey({ t, teamId, u }, (await recipientKey(ctx.su, u)).fingerprint);
        if (o.ended) await sql(`UPDATE team_members SET deactivated_at = now() WHERE id = $1::uuid`, rowId);
        return { u, rowId };
      }
      const activeResidue = await holder();
      const endedResidue = await holder({ ended: true });
      const keyed = await holder();
      // Residue: the key retired under the rows (the pre-fix race), refused since the guard.
      await changeKey(activeResidue.u, null);
      await changeKey(endedResidue.u, null);
      const seeded = { activeResidue, endedResidue, keyed };
      const held = { keyRows: 1, distributed: true };

      await inRolledBackAppTransaction(async (client) => {
        expect(await states(client, seeded)).toEqual({ activeResidue: held, endedResidue: held, keyed: held });
        const sentinels = gucSentinels();
        await setGucs(client, sentinels);

        const notices = collectNotices(client);
        try {
          await client.query(readBackfillBlock(TEAM_KEY_RECIPIENT_BINDING_DIR, RESIDUE_BLOCK));
        } finally {
          notices.stop();
        }

        expect(await readGucs(client)).toEqual(sentinels);
        const repaired = { keyRows: 0, distributed: false };
        // One labelled assertion per user, so a red proof names which half failed.
        const after = await states(client, seeded);
        expect(after.activeResidue, "active residue repaired").toEqual(repaired);
        expect(after.endedResidue, "ended residue repaired").toEqual(repaired);
        expect(after.keyed, "keyed user untouched").toEqual(held);
        // Lower bounds: the block reaches every tenant.
        const reports = notices.messages.filter((m) => m.startsWith(`${RESIDUE_BLOCK}:`));
        expect(reports).toHaveLength(1);
        const counts = parseNoticeCounts(reports[0]);
        expect(counts.key_rows).toBeGreaterThanOrEqual(2);
        expect(counts.flags).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ── No added lock, races ──────────────────────────────────────

  /** A passwd_app transaction under tenant context with a bounded lock wait. */
  async function openRaceClient(t: string, lockTimeout = "10s"): Promise<{ client: pg.PoolClient; pid: number }> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
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

  /** The three-way witness: blocked by the held pid, on a row lock, in `statement`. */
  async function expectRowLockWait(heldPid: number, waiterPid: number, statement: RegExp): Promise<void> {
    expect(await race.waitForBackendBlockedBy(heldPid)).toBe(waiterPid);
    const { rows } = await ctx.su.pool.query<{ locktype: string }>(
      `SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted`, [waiterPid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].locktype).toMatch(/^(tuple|transactionid)$/);
    expect(await race.waitingQueryOf(waiterPid)).toMatch(statement);
  }

  it("no added lock: under a FOR KEY SHARE holder, unrelated and unchanged-key updates complete; only a retirement waits", async () => {
    const f = await recipientTeam();
    const held = await race.holdRowLock(`SELECT 1 FROM users WHERE id = $1::uuid FOR KEY SHARE`, [f.u]);
    try {
      async function underTimeout(text: string, params: unknown[]): Promise<unknown> {
        const { client } = await openRaceClient(f.t, "2s");
        try {
          const { rowCount } = await client.query(text, params);
          expect(rowCount).toBe(1);
          return null;
        } catch (e) {
          return e;
        } finally {
          await closeRaceClient(client);
        }
      }
      expect(await underTimeout(`UPDATE users SET name = $2 WHERE id = $1::uuid`, [f.u, `renamed-${hex(4)}`])).toBeNull();
      expect(await underTimeout(`UPDATE users SET ecdh_public_key = ecdh_public_key WHERE id = $1::uuid`, [f.u])).toBeNull();
      // Positive control: the guard's FOR UPDATE upgrade conflicts with the holder.
      expect(sqlStateOf(await underTimeout(`UPDATE users SET ecdh_public_key = NULL WHERE id = $1::uuid`, [f.u]))).toBe("55P03");
    } finally {
      await held.release();
    }
    expect(await ecdhKey(f.u)).toBe(f.key!.publicKey);
  });

  describe("races", () => {
    it("writer first: a raw retirement waits for the guarded insert, then is refused ecdh_key_change_with_keys", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      const a = await openRaceClient(f.t);
      let b: Awaited<ReturnType<typeof openRaceClient>> | undefined;
      let retire: Promise<unknown> | undefined;
      try {
        await a.client.query(INSERT_KEY, [...insertKeyParams(f, f.key!.fingerprint, { id })]);
        b = await openRaceClient(f.t);
        retire = b.client.query(`UPDATE users SET ecdh_public_key = NULL WHERE id = $1::uuid`, [f.u]);
        retire.catch(() => {});
        await expectRowLockWait(a.pid, b.pid, /UPDATE users SET ecdh_public_key = NULL/);

        await a.client.query("COMMIT");
        expectGuardError(await retire.then(() => null, (e: unknown) => e), ARM.ECDH_KEY_CHANGE_WITH_KEYS);
      } finally {
        await closeRaceClient(a.client);
        if (b) await closeRaceClient(b.client, retire);
      }
      expect(await ecdhKey(f.u)).toBe(f.key!.publicKey);
      expect(await keyRow(id)).toMatchObject({ recipient_key_fingerprint: f.key!.fingerprint });
    });

    it("key change first: the guarded insert waits for the retirement, then is refused recipient_no_key", async () => {
      const f = await recipientTeam();
      const id = randomUUID();
      const b = await openRaceClient(f.t);
      let a: Awaited<ReturnType<typeof openRaceClient>> | undefined;
      let insert: Promise<unknown> | undefined;
      try {
        await b.client.query(`UPDATE users SET ecdh_public_key = NULL WHERE id = $1::uuid`, [f.u]);
        a = await openRaceClient(f.t);
        insert = a.client.query(INSERT_KEY, [...insertKeyParams(f, f.key!.fingerprint, { id })]);
        insert.catch(() => {});
        await expectRowLockWait(b.pid, a.pid, /INSERT INTO team_member_keys/);

        await b.client.query("COMMIT");
        expectGuardError(await insert.then(() => null, (e: unknown) => e), ARM.RECIPIENT_NO_KEY);
      } finally {
        await closeRaceClient(b.client);
        if (a) await closeRaceClient(a.client, insert);
      }
      expect(await ecdhKey(f.u)).toBeNull();
      expect(await keyRow(id)).toBeNull();
    });
  });

  // ── Routes ────────────────────────────────────────────────────

  describe("writer routes and serving endpoints", () => {
    /** A tenant, a team, its keyed OWNER (tenant OWNER too) holding the v1 key, and a keyed MEMBER. */
    async function routeTeam(o: { memberDistributed: boolean }) {
      const t = await tenant();
      const teamId = await team(t);
      const owner = await ctx.createUser(t);
      await addRow(t, teamId, owner, { role: "OWNER", keyDistributed: true });
      const ownerKey = await recipientKey(ctx.su, owner);
      await addKey({ t, teamId, u: owner }, ownerKey.fingerprint);
      const m = await member(t);
      const memberRowId = await addRow(t, teamId, m, { keyDistributed: o.memberDistributed });
      await setKey(m, nonAsciiKey(m));
      const memberKey = await recipientKey(ctx.su, m);
      if (o.memberDistributed) await addKey({ t, teamId, u: m }, memberKey.fingerprint);
      return { t, teamId, owner, ownerKey, m, memberRowId, memberKey };
    }

    function confirmKey(teamId: string, memberRowId: string, body: unknown) {
      return confirmKeyRoute(
        jsonRequest(`http://localhost/api/teams/${teamId}/members/${memberRowId}/confirm-key`, "POST", body),
        { params: Promise.resolve({ teamId, memberId: memberRowId }) },
      );
    }

    function rotateKey(teamId: string, body: unknown) {
      return rotateKeyRoute(
        jsonRequest(`http://localhost/api/teams/${teamId}/rotate-key`, "POST", body),
        { params: Promise.resolve({ teamId }) },
      );
    }

    async function rotateKeyData(teamId: string) {
      const res = await rotateKeyDataRoute(
        new NextRequest(`http://localhost/api/teams/${teamId}/rotate-key/data`),
        { params: Promise.resolve({ teamId }) },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        teamKeyVersion: number;
        entries: { id: string; blobIv: string; overviewIv: string }[];
        members: { userId: string; ecdhPublicKey: string }[];
      };
    }

    async function auditRows(t: string, action: string, teamId: string): Promise<unknown[]> {
      return sql(
        `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2 AND payload->>'teamId' = $3`,
        t, action, teamId,
      );
    }

    async function teamKeyVersion(teamId: string): Promise<number> {
      const [row] = await sql<{ team_key_version: number }>(`SELECT team_key_version FROM teams WHERE id = $1::uuid`, teamId);
      return row.team_key_version;
    }

    it("confirm-key round trip: the key from pending-key-distributions, fingerprinted by the client function, is accepted", async () => {
      const r = await routeTeam({ memberDistributed: false });
      mockAuth.mockResolvedValue({ user: { id: r.owner } });
      const res = await (pendingKeyDistributionsRoute as unknown as (req: NextRequest) => Promise<Response>)(
        new NextRequest("http://localhost/api/teams/pending-key-distributions"),
      );
      expect(res.status).toBe(200);
      const pending = (await res.json()) as { memberId: string; ecdhPublicKey: string; teamKeyVersion: number }[];
      const entry = pending.find((p) => p.memberId === r.memberRowId);
      expect(entry?.ecdhPublicKey).toBe(nonAsciiKey(r.m));
      const fingerprint = await recipientKeyFingerprint(entry!.ecdhPublicKey);

      const posted = await confirmKey(r.teamId, r.memberRowId, wrapBody(entry!.teamKeyVersion, fingerprint));
      expect(posted.status).toBe(200);
      expect(await keyRows(r.teamId, r.m)).toEqual([{ key_version: 1, recipient_key_fingerprint: fingerprint }]);
      expect(await dbFingerprint(r.m)).toBe(fingerprint);
      expect(await distributed(r.memberRowId)).toBe(true);
      // Positive control for the refusal cells' "no audit" assertion.
      expect(await auditRows(r.t, AUDIT_ACTION.TEAM_MEMBER_KEY_DISTRIBUTE, r.teamId)).toHaveLength(1);
    });

    it("rotation round trip: the keys from rotate-key/data, fingerprinted by the client function, are accepted", async () => {
      const r = await routeTeam({ memberDistributed: true });
      mockAuth.mockResolvedValue({ user: { id: r.owner } });
      const data = await rotateKeyData(r.teamId);
      expect(data.members.map((x) => x.userId).sort()).toEqual([r.owner, r.m].sort());
      const memberKeys = await Promise.all(data.members.map(async (x) => ({
        userId: x.userId,
        ...wrapBody(data.teamKeyVersion + 1, await recipientKeyFingerprint(x.ecdhPublicKey)),
      })));

      const res = await rotateKey(r.teamId, { newTeamKeyVersion: data.teamKeyVersion + 1, entries: [], memberKeys });
      expect(res.status).toBe(200);
      for (const userId of [r.owner, r.m]) {
        const [, v2] = await keyRows(r.teamId, userId);
        expect(v2).toEqual({ key_version: 2, recipient_key_fingerprint: await dbFingerprint(userId) });
      }
      expect(await teamKeyVersion(r.teamId)).toBe(2);
      // Positive control for the refusal cell's "no audit" assertion.
      expect(await auditRows(r.t, AUDIT_ACTION.TEAM_KEY_ROTATION, r.teamId)).toHaveLength(1);
    });

    it("confirm-key with a mismatching fingerprint: 409 TEAM_KEY_RECIPIENT_CHANGED, no key row, still pending, no audit", async () => {
      const r = await routeTeam({ memberDistributed: false });
      mockAuth.mockResolvedValue({ user: { id: r.owner } });
      const res = await confirmKey(r.teamId, r.memberRowId, wrapBody(1, await strangerFingerprint()));
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: "TEAM_KEY_RECIPIENT_CHANGED" } });
      expect(await keyRows(r.teamId, r.m)).toEqual([]);
      expect(await distributed(r.memberRowId)).toBe(false);
      expect(await auditRows(r.t, AUDIT_ACTION.TEAM_MEMBER_KEY_DISTRIBUTE, r.teamId)).toEqual([]);
    });

    it.each([
      ["a legacy NULL-fingerprint row", null],
      ["a row bound to an old key", "old"],
    ] as const)("confirm-key's upsert update branch over %s, with the current fingerprint: allowed and rebound", async (_label, kind) => {
      const r = await routeTeam({ memberDistributed: false });
      const old = kind === "old" ? await strangerFingerprint() : null;
      const id = await addLegacyKey({ t: r.t, teamId: r.teamId, u: r.m }, old);
      const before = await keyRow(id);
      mockAuth.mockResolvedValue({ user: { id: r.owner } });

      const body = wrapBody(1, r.memberKey.fingerprint);
      const res = await confirmKey(r.teamId, r.memberRowId, body);
      expect(res.status).toBe(200);
      // The same row, rewritten by the update branch.
      expect(await keyRow(id)).toMatchObject({
        id: before?.id,
        encrypted_team_key: body.encryptedTeamKey,
        recipient_key_fingerprint: r.memberKey.fingerprint,
      });
      expect(await keyRows(r.teamId, r.m)).toHaveLength(1);
      expect(await distributed(r.memberRowId)).toBe(true);
    });

    it("confirm-key's upsert update branch over a row already bound to the current key: allowed, the wrap rewritten", async () => {
      const r = await routeTeam({ memberDistributed: false });
      const id = await addKey({ t: r.t, teamId: r.teamId, u: r.m }, r.memberKey.fingerprint);
      mockAuth.mockResolvedValue({ user: { id: r.owner } });

      const body = wrapBody(1, r.memberKey.fingerprint);
      const res = await confirmKey(r.teamId, r.memberRowId, body);
      expect(res.status).toBe(200);
      expect(await keyRow(id)).toMatchObject({
        id,
        encrypted_team_key: body.encryptedTeamKey,
        recipient_key_fingerprint: r.memberKey.fingerprint,
      });
      expect(await keyRows(r.teamId, r.m)).toHaveLength(1);
      expect(await distributed(r.memberRowId)).toBe(true);
    });

    it("rotate-key after reset -> set up -> redistribute between data and POST: 409 for the whole rotation, nothing written", async () => {
      const r = await routeTeam({ memberDistributed: true });
      const entryId = randomUUID();
      const blobIv = hex(12);
      const overviewIv = hex(12);
      await sql(
        `INSERT INTO team_password_entries (
           id, team_id, tenant_id, created_by_id, updated_by_id,
           encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
           aad_version, team_key_version, item_key_version, entry_type, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, $5, $6, $7, $5, $8, $7, 1, 1, 0, 'LOGIN', now(), now())`,
        entryId, r.teamId, r.t, r.owner, hex(32), blobIv, hex(16), overviewIv,
      );
      const entryBefore = (await sql(`SELECT to_jsonb(e) AS row FROM team_password_entries e WHERE id = $1::uuid`, entryId))[0];

      // The owner's client reads the member set, with the member's current key.
      mockAuth.mockResolvedValue({ user: { id: r.owner } });
      const data = await rotateKeyData(r.teamId);
      const memberKeys = await Promise.all(
        [r.owner, r.m].map(async (userId) => ({
          userId,
          ...wrapBody(2, await recipientKeyFingerprint(data.members.find((x) => x.userId === userId)!.ecdhPublicKey)),
        })),
      );

      // Meanwhile the member resets, sets up again (a new key) and is redistributed.
      await executeVaultReset(r.m);
      const newKey = JSON.stringify({ kty: "EC", crv: "P-256", x: r.m, y: "after-reset" });
      mockAuth.mockResolvedValue({ user: { id: r.m } });
      const setup = await vaultSetupRoute(jsonRequest("http://localhost/api/vault/setup", "POST", {
        encryptedSecretKey: hex(32), secretKeyIv: hex(12), secretKeyAuthTag: hex(16), accountSalt: hex(32),
        authHash: hex(32), verifierHash: hex(32),
        verificationArtifact: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
        ecdhPublicKey: newKey, encryptedEcdhPrivateKey: hex(32), ecdhPrivateKeyIv: hex(12), ecdhPrivateKeyAuthTag: hex(16),
      }));
      expect(setup.status).toBe(201);
      mockAuth.mockResolvedValue({ user: { id: r.owner } });
      const newFingerprint = await recipientKeyFingerprint(newKey);
      expect((await confirmKey(r.teamId, r.memberRowId, wrapBody(1, newFingerprint))).status).toBe(200);
      const memberRowsBefore = await keyRows(r.teamId, r.m);
      expect(memberRowsBefore).toEqual([{ key_version: 1, recipient_key_fingerprint: newFingerprint }]);

      // The rotation posts the member's key wrapped to the retired key, second in the list.
      expect(memberKeys.map((k) => k.userId)).toEqual([r.owner, r.m]);
      const res = await rotateKey(r.teamId, {
        newTeamKeyVersion: 2,
        entries: [{
          id: entryId, itemKeyVersion: 0, snapshotIv: blobIv, snapshotOverviewIv: overviewIv,
          encryptedBlob: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
          encryptedOverview: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
          aadVersion: 1,
        }],
        memberKeys,
      });
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: "TEAM_KEY_RECIPIENT_CHANGED" } });

      expect(await teamKeyVersion(r.teamId)).toBe(1);
      expect(await keyRows(r.teamId, r.owner)).toEqual([{ key_version: 1, recipient_key_fingerprint: r.ownerKey.fingerprint }]);
      expect(await keyRows(r.teamId, r.m)).toEqual(memberRowsBefore);
      expect((await sql(`SELECT to_jsonb(e) AS row FROM team_password_entries e WHERE id = $1::uuid`, entryId))[0]).toEqual(entryBefore);
      expect(await auditRows(r.t, AUDIT_ACTION.TEAM_KEY_ROTATION, r.teamId)).toEqual([]);
    });

    /** teams POST by a creator with a set-up vault and a non-ASCII key, signed in; `fingerprint` runs as them. */
    async function createTeam(fingerprint: () => Promise<string>) {
      const t = await tenant();
      const { userId: creator } = await seedVaultUser(ctx, t);
      await setKey(creator, nonAsciiKey(creator));
      const teamId = randomUUID();
      mockAuth.mockResolvedValue({ user: { id: creator } });
      const res = await createTeamRoute(jsonRequest("http://localhost/api/teams", "POST", {
        id: teamId, name: "Bound", slug: `bound-${teamId.slice(0, 8)}`,
        teamMemberKey: wrapBody(1, await fingerprint()),
      }));
      return { t, creator, teamId, res };
    }

    it("teams POST with a mismatching creator fingerprint: 409 TEAM_KEY_RECIPIENT_CHANGED, no team, membership or key row", async () => {
      const c = await createTeam(() => strangerFingerprint());
      expect({ status: c.res.status, body: await c.res.json() }).toEqual({ status: 409, body: { error: "TEAM_KEY_RECIPIENT_CHANGED" } });
      expect(await sql(`SELECT 1 FROM teams WHERE id = $1::uuid`, c.teamId)).toEqual([]);
      expect(await sql(`SELECT 1 FROM team_members WHERE team_id = $1::uuid`, c.teamId)).toEqual([]);
      expect(await sql(`SELECT 1 FROM team_member_keys WHERE team_id = $1::uuid`, c.teamId)).toEqual([]);
    });

    it("teams POST with the creator's key from vault/unlock/data, fingerprinted by the client function: created, the stored fingerprint is the trigger's view", async () => {
      const c = await createTeam(async () => {
        const res = await (unlockDataRoute as unknown as (req: NextRequest) => Promise<Response>)(
          new NextRequest("http://localhost/api/vault/unlock/data"),
        );
        expect(res.status).toBe(200);
        const { ecdhPublicKey } = (await res.json()) as { ecdhPublicKey: string };
        return recipientKeyFingerprint(ecdhPublicKey);
      });
      expect(c.res.status).toBe(201);
      expect(await keyRows(c.teamId, c.creator)).toEqual([{ key_version: 1, recipient_key_fingerprint: await dbFingerprint(c.creator) }]);
    });

    it("vault setup racing a committed setup (key set, vault_setup_at NULL): 409 VAULT_ALREADY_SETUP, no users column changed", async () => {
      const t = await tenant();
      const u = await ctx.createUser(t);
      await recipientKey(ctx.su, u);
      const userRow = async () => (await sql<{ row: unknown }>(`SELECT to_jsonb(u) AS row FROM users u WHERE id = $1::uuid`, u))[0].row;
      const before = await userRow();
      expect(before).toMatchObject({ vault_setup_at: null });
      mockAuth.mockResolvedValue({ user: { id: u } });

      const setup = (userId: string) => vaultSetupRoute(jsonRequest("http://localhost/api/vault/setup", "POST", {
        encryptedSecretKey: hex(32), secretKeyIv: hex(12), secretKeyAuthTag: hex(16), accountSalt: hex(32),
        authHash: hex(32), verifierHash: hex(32),
        verificationArtifact: { ciphertext: hex(32), iv: hex(12), authTag: hex(16) },
        ecdhPublicKey: nonAsciiKey(userId), encryptedEcdhPrivateKey: hex(32), ecdhPrivateKeyIv: hex(12), ecdhPrivateKeyAuthTag: hex(16),
      }));
      const setupAudits = (userId: string) => sql(
        `SELECT 1 FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2 AND payload->>'userId' = $3`,
        t, AUDIT_ACTION.VAULT_SETUP, userId,
      );

      const res = await setup(u);
      expect(res.status, "setup over a committed key refused").toBe(409);
      expect(await res.json()).toEqual({ error: "VAULT_ALREADY_SETUP" });
      expect(await userRow()).toEqual(before);
      expect(await sql(`SELECT 1 FROM vault_keys WHERE user_id = $1::uuid`, u)).toEqual([]);
      expect(await setupAudits(u)).toEqual([]);

      // Positive control for the "no audit" assertion: a first setup in the same tenant is audited.
      const fresh = await ctx.createUser(t);
      mockAuth.mockResolvedValue({ user: { id: fresh } });
      expect((await setup(fresh)).status).toBe(201);
      expect(await setupAudits(fresh)).toHaveLength(1);
    });
  });
});
