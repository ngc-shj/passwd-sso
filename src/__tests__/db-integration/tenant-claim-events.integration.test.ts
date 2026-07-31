/**
 * Real-DB integration tests for C1 (the `tenant_claim_events` table, its
 * triggers, grants and purge routine) and C3 (the operation-CHECK drift
 * guard), from `docs/archive/review/sso-tenant-claim-event-history-plan.md`
 * (SC11 / issue #743).
 *
 * Every assertion whose adjudicator is Postgres — privilege denial, trigger
 * enforcement, transactional GUC scoping, the CHECK — runs against the real
 * database (Testing strategy, C1 row). A mocked `$executeRaw` would prove the
 * call was made, not that the trigger fired.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import {
  createTestContext,
  setBypassRlsGucs,
  sqlStateOf,
  type TestContext,
} from "./helpers";
import {
  runToken,
  ALIAS_CLAIM,
  PRIMARY_CLAIM,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import { TENANT_CLAIM_EVENT_OPERATION } from "@/lib/tenant/tenant-claim-event";
import { cmdHistory } from "../../../scripts/tenant-domain";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const MIGRATION_SQL_PATH = resolve(
  REPO_ROOT,
  "prisma/migrations/20260731100000_add_tenant_claim_events/migration.sql",
);

const SKIP = !process.env.DATABASE_URL;

type EventRow = {
  id: string;
  claim: string;
  operation: string;
  old_tenant_id: string | null;
  new_tenant_id: string | null;
  old_revoked_at: Date | null;
  new_revoked_at: Date | null;
  actor_label: string;
  db_user: string;
  session_db_user: string;
  client_addr: string | null;
  created_at: Date;
};

/**
 * Inserts a row directly (not through `recordTenantClaimEvent`, which
 * requires a transaction client and issues no `RETURNING`) — these tests are
 * exercising the table's own constraints and triggers, not the producer.
 * `db_user`/`session_db_user`/`client_addr`/`created_at` are deliberately
 * absent: the `BEFORE INSERT` trigger assigns them unconditionally (I2), and
 * naming them here would just prove the same thing the I2 test proves more
 * directly by naming them AND expecting the supplied value to be discarded.
 */
async function insertEventRow(
  prisma: PrismaClient,
  row: {
    id?: string;
    claim: string;
    operation: string;
    oldTenantId: string | null;
    newTenantId: string | null;
    oldRevokedAt?: Date | null;
    newRevokedAt?: Date | null;
    actorLabel?: string;
  },
): Promise<string> {
  const id = row.id ?? randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenant_claim_events
       (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz, $8)`,
    id,
    row.claim,
    row.operation,
    row.oldTenantId,
    row.newTenantId,
    row.oldRevokedAt ?? null,
    row.newRevokedAt ?? null,
    row.actorLabel ?? "test",
  );
  return id;
}

/** Purges a stray row this file inserted directly, bypassing ctx.deleteTestData. */
async function purgeForTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `SELECT tenant_claim_events_purge_for_tenant($1::uuid)`,
    tenantId,
  );
}

describe("tenant_claim_events (C1)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  describe("append-only against the owner (I1)", () => {
    it.skipIf(SKIP)(
      "a refused UPDATE leaves every column unchanged, and the row still present",
      async () => {
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const fakeTenant = randomUUID(); // no FK — a real tenants row is not needed here
        const id = await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: fakeTenant,
          actorLabel: "owner-update-test",
        });

        try {
          const before = await ctx.su.prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT * FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          expect(before).toHaveLength(1);

          let caught: unknown;
          try {
            await ctx.su.prisma.$executeRawUnsafe(
              `UPDATE tenant_claim_events SET actor_label = 'tampered' WHERE id = $1::uuid`,
              id,
            );
          } catch (e) {
            caught = e;
          }
          // restrict_violation — the SQLSTATE the append-only raise function
          // names explicitly (migration.sql). "It raised" alone would also
          // be true of an UPDATE targeting the wrong row, which is why the
          // row is re-read below.
          expect(sqlStateOf(caught)).toBe("23001");

          const after = await ctx.su.prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT * FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          expect(after).toHaveLength(1);
          expect(after[0]).toEqual(before[0]);
        } finally {
          await purgeForTenant(ctx.su.prisma, fakeTenant);
        }
      },
    );

    it.skipIf(SKIP)(
      "a refused DELETE leaves the row present, unchanged",
      async () => {
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const fakeTenant = randomUUID();
        const id = await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: fakeTenant,
          actorLabel: "owner-delete-test",
        });

        try {
          const before = await ctx.su.prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT * FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          expect(before).toHaveLength(1);

          let caught: unknown;
          try {
            await ctx.su.prisma.$executeRawUnsafe(
              `DELETE FROM tenant_claim_events WHERE id = $1::uuid`,
              id,
            );
          } catch (e) {
            caught = e;
          }
          expect(sqlStateOf(caught)).toBe("23001");

          const after = await ctx.su.prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT * FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          expect(after).toHaveLength(1);
          expect(after[0]).toEqual(before[0]);
        } finally {
          await purgeForTenant(ctx.su.prisma, fakeTenant);
        }
      },
    );

    it.skipIf(SKIP)("TRUNCATE raises, on the real table, as the owner", async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const fakeTenant = randomUUID();
      const id = await insertEventRow(ctx.su.prisma, {
        claim,
        operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
        oldTenantId: null,
        newTenantId: fakeTenant,
        actorLabel: "owner-truncate-test",
      });

      try {
        // Inside BEGIN … ROLLBACK on one physical connection, NOT autocommit.
        // The assertion is correct only while the no-truncate trigger works —
        // and the moment it does not, which is the ONLY state this test exists
        // to detect, an autocommit TRUNCATE wipes every row of the routing
        // history on the SHARED dev database (VE1), irreversibly, for every
        // other working copy. NF3's "never by mutating the shared dev database"
        // applies to the statement a red-proof fires, not only to the setup
        // around it. TRUNCATE is transactional in PostgreSQL, so wrapping it
        // changes nothing about what is asserted and takes the blast radius to
        // zero.
        const client = await ctx.su.pool.connect();
        let caught: { code?: string } | undefined;
        try {
          await client.query("BEGIN");
          try {
            await client.query(`TRUNCATE tenant_claim_events`);
          } catch (e) {
            caught = e as { code?: string };
          }
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
        expect(caught?.code).toBe("23001");

        const remaining = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM tenant_claim_events WHERE id = $1::uuid`,
          id,
        );
        expect(remaining).toHaveLength(1);
      } finally {
        await purgeForTenant(ctx.su.prisma, fakeTenant);
      }
    });

    it.skipIf(SKIP)(
      "the escape GUC set by the purge routine does not leak to a later statement in the same transaction",
      async () => {
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const rowTenant = randomUUID();
        const unrelatedTenant = randomUUID(); // argument to the purge call; matches no row
        const id = await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: rowTenant,
          actorLabel: "guc-leak-test",
        });

        // Manual BEGIN/DELETE/ROLLBACK on one physical connection: the
        // property under test is the function-level SET's scope WITHIN one
        // transaction, which Prisma's own $transaction wrapper cannot
        // exercise cleanly once the DELETE aborts the underlying Postgres
        // transaction (round precedent: key-version-guard.integration.test.ts
        // uses the same pool.connect() pattern for manual tx control).
        const client = await ctx.su.pool.connect();
        let caught: { code?: string } | undefined;
        try {
          await client.query("BEGIN");
          // Calling the routine at all is what would arm the escape GUC if
          // the function-level SET leaked past the call returning — the
          // argument need not match this row. A leaking implementation
          // passes a NEXT-transaction form of this case; this is why the
          // whole probe runs inside one transaction.
          await client.query(
            "SELECT tenant_claim_events_purge_for_tenant($1::uuid)",
            [unrelatedTenant],
          );
          try {
            await client.query(
              "DELETE FROM tenant_claim_events WHERE id = $1::uuid",
              [id],
            );
          } catch (e) {
            caught = e as { code?: string };
          }
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }

        try {
          expect(caught?.code).toBe("23001");
          const remaining = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          expect(remaining).toHaveLength(1);
        } finally {
          await purgeForTenant(ctx.su.prisma, rowTenant);
        }
      },
    );
  });

  describe("all three triggers are ENABLE ALWAYS", () => {
    it.skipIf(SKIP)(
      "tgenabled = 'A' for the set-principal, append-only and no-truncate triggers",
      async () => {
        // tgenabled is Postgres "char", which Prisma cannot deserialize
        // directly ("Unsupported" column type) — cast to text.
        const rows = await ctx.su.prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>`
          SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger
           WHERE tgrelid = 'public.tenant_claim_events'::regclass AND NOT tgisinternal
        `;
        const byName = new Map(rows.map((r) => [r.tgname, r.tgenabled]));
        // Anti-vacuity: all three must exist, not merely a subset — a
        // dropped trigger and a disabled one must not read the same.
        expect(byName.size).toBe(3);
        for (const name of [
          "trg_tenant_claim_events_set_principal",
          "trg_tenant_claim_events_append_only",
          "trg_tenant_claim_events_no_truncate",
        ]) {
          expect(byName.get(name), `${name} is ENABLE ALWAYS ('A')`).toBe("A");
        }
      },
    );
  });

  describe("purge routine scope (RT4 lower bound)", () => {
    // cmdHistory reads MIGRATION_DATABASE_URL directly (it builds its own
    // client via migrationClientFactory, not through this file's `ctx.su`),
    // same as tenant-claim-cli.integration.test.ts's own beforeEach/afterEach
    // — re-stubbed per test, never assigned with `process.env.X =`
    // (check-test-hygiene gate (c)), and unstubbed after so it cannot leak
    // into a test declared later in this file.
    beforeEach(() => {
      if (SKIP) return;
      if (!process.env.MIGRATION_DATABASE_URL) {
        vi.stubEnv("MIGRATION_DATABASE_URL", process.env.DATABASE_URL as string);
      }
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.skipIf(SKIP)(
      "purging one side of a reassign row removes it for both named tenants, and leaves an unrelated row untouched",
      async () => {
        const tenantA = await ctx.createTenant();
        const tenantB = await ctx.createTenant();
        const tenantC = await ctx.createTenant();
        const reassignClaim = `${runToken()}.${ALIAS_CLAIM}`;
        const unrelatedClaim = `${runToken()}.${PRIMARY_CLAIM}`;

        const reassignId = await insertEventRow(ctx.su.prisma, {
          claim: reassignClaim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REASSIGN,
          oldTenantId: tenantA,
          newTenantId: tenantB,
          actorLabel: "purge-scope-test",
        });
        const unrelatedId = await insertEventRow(ctx.su.prisma, {
          claim: unrelatedClaim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: tenantC,
          actorLabel: "purge-scope-test",
        });

        try {
          // QA-1: routed through cmdHistory — the PRODUCTION selector — for
          // both named sides, rather than a test-local hand-written twin of
          // its `OR: [{ oldTenantId }, { newTenantId }]` predicate. This is
          // the shape the plan places this case in (C6's "history" cases).
          const historyIdsFor = async (tenantId: string): Promise<string[]> => {
            const result = await cmdHistory({ tenant: tenantId });
            expect(result.ok).toBe(true);
            return ((result.rows ?? []) as { id: string }[]).map((r) => r.id);
          };

          // Pre-purge lower bound (RT4): without this, the post-purge
          // negatives below would be equally satisfied by a routine that
          // deleted nothing and a selector that matched nothing.
          expect(await historyIdsFor(tenantA)).toContain(reassignId);
          expect(await historyIdsFor(tenantB)).toContain(reassignId);

          await purgeForTenant(ctx.su.prisma, tenantA);

          // Both negatives: F2's "one row names two tenants" means any
          // deletion path deletes it for both — the documented blast radius.
          expect(await historyIdsFor(tenantA)).not.toContain(reassignId);
          expect(await historyIdsFor(tenantB)).not.toContain(reassignId);

          const unrelatedStill = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM tenant_claim_events WHERE id = $1::uuid`,
            unrelatedId,
          );
          expect(unrelatedStill).toHaveLength(1);
        } finally {
          await ctx.deleteTestData(tenantA);
          await ctx.deleteTestData(tenantB);
          await ctx.deleteTestData(tenantC);
        }
      },
    );
  });

  describe("privilege layer — passwd_app (I3)", () => {
    it.skipIf(SKIP)("INSERT succeeds", async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const tenantId = await ctx.createTenant();
      const id = randomUUID();

      try {
        // QA-8: `.resolves.not.toThrow()` is a no-op matcher in Vitest — a
        // resolved value is not a function, so `.not.toThrow()` never
        // inspects it. `.resolves.toBeDefined()` is the assertion this line
        // was meant to make: the call resolved (did not reject) at all.
        await expect(
          ctx.app.prisma.$executeRawUnsafe(
            `INSERT INTO tenant_claim_events
               (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
             VALUES ($1::uuid, $2, 'register', NULL, $3::uuid, NULL, NULL, $4)`,
            id,
            claim,
            tenantId,
            "app-insert-test",
          ),
        ).resolves.toBeDefined();

        const stored = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM tenant_claim_events WHERE id = $1::uuid`,
          id,
        );
        expect(stored).toHaveLength(1);
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });

    it.skipIf(SKIP)("SELECT is refused with 42501", async () => {
      const [{ granted }] = await ctx.su.prisma.$queryRaw<{ granted: boolean }[]>`
        SELECT has_table_privilege('passwd_app', 'public.tenant_claim_events', 'SELECT') AS granted
      `;
      // VE4: grant order differs dev vs CI — assert the precondition rather
      // than assuming it, or this case is green for the wrong reason in one
      // of the two environments.
      expect(granted, "precondition: passwd_app must not hold SELECT").toBe(false);

      let caught: unknown;
      try {
        await ctx.app.prisma.$queryRawUnsafe(`SELECT id FROM tenant_claim_events LIMIT 1`);
      } catch (e) {
        caught = e;
      }
      // 42501 specifically — a loose throw assertion also greens on 42P01
      // (the table not existing at all), which is the one state where the
      // control genuinely does not exist.
      expect(sqlStateOf(caught)).toBe("42501");
    });

    it.skipIf(SKIP)("UPDATE is refused with 42501", async () => {
      const [{ granted }] = await ctx.su.prisma.$queryRaw<{ granted: boolean }[]>`
        SELECT has_table_privilege('passwd_app', 'public.tenant_claim_events', 'UPDATE') AS granted
      `;
      expect(granted, "precondition: passwd_app must not hold UPDATE").toBe(false);

      let caught: unknown;
      try {
        await ctx.app.prisma.$executeRawUnsafe(
          `UPDATE tenant_claim_events SET actor_label = 'x' WHERE id = $1::uuid`,
          randomUUID(),
        );
      } catch (e) {
        caught = e;
      }
      expect(sqlStateOf(caught)).toBe("42501");
    });

    it.skipIf(SKIP)("DELETE is refused with 42501", async () => {
      const [{ granted }] = await ctx.su.prisma.$queryRaw<{ granted: boolean }[]>`
        SELECT has_table_privilege('passwd_app', 'public.tenant_claim_events', 'DELETE') AS granted
      `;
      expect(granted, "precondition: passwd_app must not hold DELETE").toBe(false);

      let caught: unknown;
      try {
        await ctx.app.prisma.$executeRawUnsafe(
          `DELETE FROM tenant_claim_events WHERE id = $1::uuid`,
          randomUUID(),
        );
      } catch (e) {
        caught = e;
      }
      expect(sqlStateOf(caught)).toBe("42501");
    });
  });

  describe("I2 — principal columns are assigned by the engine, not the caller", () => {
    it.skipIf(SKIP)(
      "an INSERT naming db_user/session_db_user/created_at/client_addr explicitly is overwritten with the engine's own values, read on the same connection",
      async () => {
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const tenantId = await ctx.createTenant();
        const id = randomUUID();
        // VE5: MIGRATION_DATABASE_URL names a different role per environment
        // (passwd_user locally, postgres in CI) — the forged value must not
        // collide with whatever that role actually is, and the assertion
        // below never compares against a literal role name either.
        const forgedDbUser = `not-a-real-role-${runToken()}`;
        const forgedSessionDbUser = `also-not-a-real-role-${runToken()}`;
        // QA-6 / D-2: created_at moved out of a column DEFAULT into the
        // trigger precisely because a DEFAULT is overridable by an INSERT
        // that names the column — the same forgeability closed for db_user.
        // A distant-past value, not an edge case that could coincidentally
        // land close to "now".
        const forgedCreatedAt = new Date("2000-01-01T00:00:00.000Z");
        // TEST-NET-3 (RFC 5737) — guaranteed not to be this connection's real
        // client address.
        const forgedClientAddr = "203.0.113.99";

        let storedDbUser: string | undefined;
        let storedSessionDbUser: string | undefined;
        let storedCreatedAt: Date | undefined;
        let storedClientAddr: string | null | undefined;
        let liveCurrentUser: string | undefined;
        let liveSessionUser: string | undefined;
        let liveClockTimestamp: Date | undefined;
        let liveClientAddr: string | null | undefined;

        await ctx.su.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_claim_events
               (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label, db_user, session_db_user, created_at, client_addr)
             VALUES ($1::uuid, $2, 'register', NULL, $3::uuid, NULL, NULL, $4, $5, $6, $7::timestamptz, $8::inet)`,
            id,
            claim,
            tenantId,
            "i2-forgery-test",
            forgedDbUser,
            forgedSessionDbUser,
            forgedCreatedAt,
            forgedClientAddr,
          );
          const [row] = await tx.$queryRawUnsafe<
            {
              db_user: string;
              session_db_user: string;
              created_at: Date;
              client_addr: string | null;
            }[]
          >(
            `SELECT db_user, session_db_user, created_at, client_addr::text AS client_addr
               FROM tenant_claim_events WHERE id = $1::uuid`,
            id,
          );
          storedDbUser = row.db_user;
          storedSessionDbUser = row.session_db_user;
          storedCreatedAt = row.created_at;
          storedClientAddr = row.client_addr;
          // Read on the SAME connection/transaction — never a literal
          // (VE5's rule extends to the timestamp and the address too).
          const [principal] = await tx.$queryRawUnsafe<
            { current_user: string; session_user: string; now: Date; client_addr: string | null }[]
          >(
            `SELECT current_user, session_user, clock_timestamp() AS now, inet_client_addr()::text AS client_addr`,
          );
          liveCurrentUser = principal.current_user;
          liveSessionUser = principal.session_user;
          liveClockTimestamp = principal.now;
          liveClientAddr = principal.client_addr;
        });

        try {
          expect(storedDbUser).not.toBe(forgedDbUser);
          expect(storedSessionDbUser).not.toBe(forgedSessionDbUser);
          expect(storedDbUser).toBe(liveCurrentUser);
          expect(storedSessionDbUser).toBe(liveSessionUser);

          // created_at: replaced, and within a few seconds of a
          // clock_timestamp() read on the same connection — never asserted
          // against a literal.
          expect(storedCreatedAt).toBeDefined();
          expect(liveClockTimestamp).toBeDefined();
          expect((storedCreatedAt as Date).getTime()).not.toBe(forgedCreatedAt.getTime());
          const deltaMs = Math.abs(
            (storedCreatedAt as Date).getTime() - (liveClockTimestamp as Date).getTime(),
          );
          expect(deltaMs).toBeLessThan(5000);

          // client_addr: replaced with inet_client_addr(), read the same
          // way. May legitimately be NULL on both sides (a Unix-domain
          // socket connection) — that is a correct equality, not a vacuous
          // pass: a forged value that survived the trigger would make this
          // assertion a strict inequality instead.
          expect(storedClientAddr).not.toBe(forgedClientAddr);
          expect(storedClientAddr).toBe(liveClientAddr);
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );
  });

  describe("F3 — history survives deletion of what it names", () => {
    it.skipIf(SKIP)(
      "a history row survives DELETE FROM tenant_claims of the claim row it names",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const claimRowId = randomUUID();
        await ctx.su.prisma.tenantClaim.create({
          data: { id: claimRowId, tenantId, claim },
        });
        const eventId = await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: tenantId,
          actorLabel: "f3-claim-test",
        });

        try {
          // Direct — never through ctx.deleteTestData, which now purges
          // tenant_claim_events FIRST (Task 1 / VE2). Routing F3's red-proof
          // through the helper would assert the negation of F3.
          await ctx.su.prisma.$executeRawUnsafe(
            `DELETE FROM tenant_claims WHERE id = $1::uuid`,
            claimRowId,
          );

          const claimRows = await ctx.su.prisma.tenantClaim.findMany({
            where: { id: claimRowId },
          });
          expect(claimRows).toHaveLength(0);

          const eventRows = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM tenant_claim_events WHERE id = $1::uuid`,
            eventId,
          );
          expect(eventRows).toHaveLength(1);
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    it.skipIf(SKIP)(
      "a reassign row survives DELETE FROM tenants of one of its two named tenants, still naming the other",
      async () => {
        const tenantA = await ctx.createTenant();
        const tenantB = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const eventId = await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REASSIGN,
          oldTenantId: tenantA,
          newTenantId: tenantB,
          actorLabel: "f3-reassign-test",
        });

        try {
          await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            await tx.$executeRawUnsafe(
              `DELETE FROM tenants WHERE id = $1::uuid`,
              tenantA,
            );
          });

          const row = await ctx.su.prisma.$queryRawUnsafe<
            { id: string; old_tenant_id: string | null; new_tenant_id: string | null }[]
          >(
            `SELECT id, old_tenant_id, new_tenant_id FROM tenant_claim_events WHERE id = $1::uuid`,
            eventId,
          );
          expect(row).toHaveLength(1);
          expect(row[0].old_tenant_id).toBe(tenantA); // dangling — no FK, still named
          expect(row[0].new_tenant_id).toBe(tenantB);
        } finally {
          // tenantA's tenants row is already gone — deleteTestData on it is
          // a safe no-op sweep that still purges any tenant_claim_events row
          // naming it (round-1 precedent: tenant-claim.integration.test.ts's
          // cascade case leaves a direct-deleted tenant to the same sweep).
          await ctx.deleteTestData(tenantA);
          await ctx.deleteTestData(tenantB);
        }
      },
    );
  });

  /**
   * NF3 — the append-only trigger must be provably able to fail, demonstrated
   * rather than merely asserted. This is NEVER proved by dropping or
   * disabling the trigger on the REAL table: under VE1 (the dev database is
   * shared) that would be a durable disarm invisible to every other working
   * copy. Instead the shipped DDL is extracted from the migration file,
   * applied to a throwaway table under per-run object names, and exercised
   * directly.
   *
   * Valid ONLY paired with the tgenabled='A' and refusal assertions
   * elsewhere in this file: on its own this proves the DDL CAN raise, and
   * says nothing about whether it is actually attached, enabled and unbroken
   * on the shipped `tenant_claim_events` table.
   */
  describe("NF3 — the append-only trigger can fail (throwaway-table red-proof)", () => {
    const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf8");
    const FUNCTION_BLOCK_RE = /CREATE FUNCTION tenant_claim_events_append_only\(\)[\s\S]*?\$\$;/;
    const ROW_TRIGGER_BLOCK_RE = /CREATE TRIGGER trg_tenant_claim_events_append_only[\s\S]*?;/;
    const TRUNCATE_TRIGGER_BLOCK_RE = /CREATE TRIGGER trg_tenant_claim_events_no_truncate[\s\S]*?;/;

    it.skipIf(SKIP)(
      "the append-only trigger DDL, extracted from the migration and applied to a throwaway table, raises on UPDATE, DELETE and TRUNCATE",
      async () => {
        const functionBlock = migrationSql.match(FUNCTION_BLOCK_RE)?.[0];
        const rowTriggerBlock = migrationSql.match(ROW_TRIGGER_BLOCK_RE)?.[0];
        const truncateTriggerBlock = migrationSql.match(TRUNCATE_TRIGGER_BLOCK_RE)?.[0];
        // Guarded extraction: a hand-written trigger body would prove a
        // TEST-AUTHORED trigger raises, not the shipped one, so each
        // extraction is confirmed non-empty before anything is built from it.
        expect(functionBlock, "append-only function DDL extraction").toBeDefined();
        expect(rowTriggerBlock, "row-level trigger DDL extraction").toBeDefined();
        expect(truncateTriggerBlock, "truncate trigger DDL extraction").toBeDefined();

        const token = runToken();
        const probeTable = `tenant_claim_events_nf3_probe_${token}`;
        const probeFn = `tenant_claim_events_append_only_nf3_probe_${token}`;
        const probeRowTrigger = `trg_append_only_nf3_probe_${token}`;
        const probeTruncateTrigger = `trg_no_truncate_nf3_probe_${token}`;

        // Order matters: the row-trigger's full name CONTAINS the bare
        // function name as a substring ("trg_" + the function name), so the
        // longer identifier is substituted first — otherwise the second
        // replacement would also rewrite the tail of the first.
        const substitute = (sql: string): string =>
          sql
            .replaceAll("trg_tenant_claim_events_no_truncate", probeTruncateTrigger)
            .replaceAll("trg_tenant_claim_events_append_only", probeRowTrigger)
            .replaceAll("tenant_claim_events_append_only", probeFn)
            .replaceAll('"tenant_claim_events"', `"${probeTable}"`);

        try {
          await ctx.su.prisma.$executeRawUnsafe(
            `CREATE TABLE "${probeTable}" (id uuid PRIMARY KEY)`,
          );
          await ctx.su.prisma.$executeRawUnsafe(substitute(functionBlock as string));
          await ctx.su.prisma.$executeRawUnsafe(substitute(rowTriggerBlock as string));
          await ctx.su.prisma.$executeRawUnsafe(substitute(truncateTriggerBlock as string));

          const rowId = randomUUID();
          await ctx.su.prisma.$executeRawUnsafe(
            `INSERT INTO "${probeTable}" (id) VALUES ($1::uuid)`,
            rowId,
          );

          let updateCaught: unknown;
          try {
            await ctx.su.prisma.$executeRawUnsafe(
              `UPDATE "${probeTable}" SET id = id WHERE id = $1::uuid`,
              rowId,
            );
          } catch (e) {
            updateCaught = e;
          }
          expect(sqlStateOf(updateCaught)).toBe("23001");

          let deleteCaught: unknown;
          try {
            await ctx.su.prisma.$executeRawUnsafe(
              `DELETE FROM "${probeTable}" WHERE id = $1::uuid`,
              rowId,
            );
          } catch (e) {
            deleteCaught = e;
          }
          expect(sqlStateOf(deleteCaught)).toBe("23001");

          let truncateCaught: unknown;
          try {
            await ctx.su.prisma.$executeRawUnsafe(`TRUNCATE "${probeTable}"`);
          } catch (e) {
            truncateCaught = e;
          }
          expect(sqlStateOf(truncateCaught)).toBe("23001");

          const remaining = await ctx.su.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "${probeTable}" WHERE id = $1::uuid`,
            rowId,
          );
          expect(remaining).toHaveLength(1);
        } finally {
          // Per-run names, dropped in a finally — a Prisma $transaction
          // commits on success, so "in the test's own transaction" is not by
          // itself a lifetime bound (this uses no transaction at all).
          await ctx.su.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probeTable}"`);
          await ctx.su.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${probeFn}()`);
        }
      },
    );
  });
});

/**
 * C3 — the CHECK ↔ const-object drift guard, adjudicated against the LIVE
 * catalogue (R48). The migration file is immutable once applied and says
 * nothing about what the database currently enforces; only pg_get_constraintdef
 * does.
 */
describe("tenant_claim_events_operation_check ↔ TENANT_CLAIM_EVENT_OPERATION (C3)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  it.skipIf(SKIP)(
    "the live CHECK enumerates exactly the const-object's values, in both directions",
    async () => {
      const [row] = await ctx.su.prisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'public.tenant_claim_events'::regclass
           AND conname = 'tenant_claim_events_operation_check'
      `;
      expect(row, "the CHECK constraint exists in the live catalogue").toBeDefined();

      // Postgres deparses `x IN (a, b, c)` as `x = ANY (ARRAY[a, b, c])`, not
      // the IN-list form the migration wrote — this reads the deparsed shape,
      // not a guess at what was typed.
      const arrayMatch = /ARRAY\[([^\]]*)\]/.exec(row.definition);
      expect(arrayMatch, `unparseable CHECK definition: ${row.definition}`).toBeTruthy();
      const liveValues = new Set(
        Array.from(arrayMatch?.[1].matchAll(/'([^']*)'/g) ?? [], (m) => m[1]),
      );
      // A failed parse must not silently green as "sets equal, both empty".
      expect(liveValues.size).toBeGreaterThan(0);

      const constValues = new Set<string>(Object.values(TENANT_CLAIM_EVENT_OPERATION));
      expect(constValues.size).toBeGreaterThan(0);

      const missingFromLive = [...constValues].filter((v) => !liveValues.has(v));
      const extraInLive = [...liveValues].filter((v) => !constValues.has(v));
      expect(missingFromLive, "const-object members absent from the live CHECK").toEqual([]);
      expect(extraInLive, "live CHECK members absent from the const-object").toEqual([]);
    },
  );
});

/**
 * R48 — `tenant_claim_events_claim_normalized` is a second adjudicator of the
 * same question `tenant_claims_claim_normalized` already answers (plan C1:
 * "pinned to storableClaimSchema's predicate, never stricter — a CHECK the
 * sign-in writer's value fails would deny the sign-in, so a divergence is an
 * outage"). Nothing pinned the two CHECKs to each other; this reads both from
 * the LIVE catalogue, never the migration file, which is immutable once
 * applied and says nothing about what the database currently enforces.
 */
describe("tenant_claim_events_claim_normalized ↔ tenant_claims_claim_normalized (R48)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  it.skipIf(SKIP)(
    "the two claim-normalisation CHECKs are equivalent predicates in the live catalogue",
    async () => {
      const [eventsRow] = await ctx.su.prisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'public.tenant_claim_events'::regclass
           AND conname = 'tenant_claim_events_claim_normalized'
      `;
      const [claimsRow] = await ctx.su.prisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'public.tenant_claims'::regclass
           AND conname = 'tenant_claims_claim_normalized'
      `;
      expect(eventsRow, "tenant_claim_events_claim_normalized exists in the live catalogue").toBeDefined();
      expect(claimsRow, "tenant_claims_claim_normalized exists in the live catalogue").toBeDefined();

      const normalise = (def: string) => def.replace(/\s+/g, " ").trim();
      const eventsDef = normalise(eventsRow.definition);
      const claimsDef = normalise(claimsRow.definition);
      // A failed lookup must not silently green as "equal, both empty".
      expect(eventsDef.length).toBeGreaterThan(0);
      expect(claimsDef.length).toBeGreaterThan(0);

      expect(eventsDef, "the two CHECKs must be the same predicate").toBe(claimsDef);
    },
  );
});

/**
 * RT7 — none of the three new CHECK constraints had been red-proved: no test
 * attempted an insert any of them must reject. One case per constraint,
 * against the real table via insertEventRow (never a throwaway table — these
 * are ordinary CHECK constraints, not the append-only triggers NF3 exists
 * for).
 */
describe("tenant_claim_events CHECK constraints reject bad rows (RT7)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  it.skipIf(SKIP)(
    "tenant_claim_events_operation_check rejects an operation outside the four",
    async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const fakeTenant = randomUUID();

      let caught: unknown;
      try {
        try {
          await insertEventRow(ctx.su.prisma, {
            claim,
            // Must fit VARCHAR(16) so the CHECK is what rejects it, not a
            // separate "value too long" error (22001) for the column itself.
            operation: "bogus",
            oldTenantId: null,
            newTenantId: fakeTenant,
            actorLabel: "operation-check-test",
          });
        } catch (e) {
          caught = e;
        }
        expect(sqlStateOf(caught)).toBe("23514");
      } finally {
        // QA-7: in a finally — if the CHECK regressed and the insert
        // instead succeeded, the expect above would throw and this purge
        // would never run. fakeTenant is a random UUID no other cleanup
        // path can reach, so a row left behind here is permanently stuck on
        // the shared dev database.
        await purgeForTenant(ctx.su.prisma, fakeTenant);
      }
    },
  );

  it.skipIf(SKIP)(
    "tenant_claim_events_claim_normalized rejects a non-normalised (mixed-case) claim",
    async () => {
      const claim = `${runToken()}-${ALIAS_CLAIM.replace("alias", "Alias").replace("example", "Example")}`;
      expect(claim).not.toBe(claim.toLowerCase());
      const fakeTenant = randomUUID();

      let caught: unknown;
      try {
        try {
          await insertEventRow(ctx.su.prisma, {
            claim,
            operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
            oldTenantId: null,
            newTenantId: fakeTenant,
            actorLabel: "claim-normalized-check-test",
          });
        } catch (e) {
          caught = e;
        }
        expect(sqlStateOf(caught)).toBe("23514");
      } finally {
        // QA-7: same reasoning as the operation-check case above.
        await purgeForTenant(ctx.su.prisma, fakeTenant);
      }
    },
  );

  it.skipIf(SKIP)(
    "tenant_claim_events_names_a_tenant rejects a row naming neither tenant (I5 — what makes the VE2 purge predicate total)",
    async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      // No finally-purge here: a row rejected by this CHECK is never
      // inserted, so there is nothing to purge. If the CHECK were silently
      // not in force this row would be unreachable by
      // tenant_claim_events_purge_for_tenant and by `history --tenant` —
      // permanently undeletable on the shared dev database — which is
      // exactly the failure this case exists to catch before it happens.
      let caught: unknown;
      try {
        await insertEventRow(ctx.su.prisma, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldTenantId: null,
          newTenantId: null,
          actorLabel: "names-a-tenant-check-test",
        });
      } catch (e) {
        caught = e;
      }
      expect(sqlStateOf(caught)).toBe("23514");
    },
  );
});
