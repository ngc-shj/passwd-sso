/**
 * Real-DB coverage for C3 (CF13) — a `tenant_claims` row pointing at the
 * sentinel tenant denies sign-in reportably.
 * docs/archive/review/audit-sentinel-carried-forward-plan.md, "C3 — a
 * sentinel-pointing claim refuses sign-in reportably (CF13)".
 *
 * The state under test — a live `tenant_claims` row with `tenantId =
 * SYSTEM_TENANT_ID` — is reachable only out of band: `tenant-domain add`
 * refuses a sentinel target on the resolved id, so no operator command
 * creates it. Each case creates the row itself and removes it in a
 * `finally` (VC3): it is not a fixture ctx.deleteTestData can reach, because
 * the write target IS the sentinel, not a tenant this file created.
 *
 * Why this must be integration, not unit (see the two `auth-adapter.test.ts`
 * / `auth.test.ts` docblocks): both mock `@/lib/prisma` wholesale, so a unit
 * case can only assert that the code CALLS `tx.user.create` /
 * `tx.tenantMember.upsert` in some order — it cannot show that PostgreSQL's
 * CHECK actually fires, on the actual write ordering, or that the error it
 * raises actually parses back to the constraint name the comment claims.
 *
 * Fixture lifecycle (the plan's own "Fixture lifecycle" paragraph):
 * sentinel-scoped audit rows are the NORMAL steady state of a live
 * deployment (5 outbox / 5 logs on dev at the time this file was written),
 * so nothing here asserts an absolute-zero count against the sentinel. Every
 * assertion is scoped to a `claim` value this run generated
 * (`c3-<arm>-<runToken()>...`), which is the "equivalent marker"
 * `emitAuthLoginFailure` has in place of a `targetId` — it takes no
 * targetType/targetId, but every AUTH_LOGIN_FAILURE emit under test here
 * carries a claim, and that claim is unique to this run.
 *
 * VC2: the outbox worker must be stopped for these assertions to mean
 * anything — a drained row reaches `audit_logs` and disappears from
 * `audit_outbox`, so every assertion here reads `audit_outbox` (the
 * upstream state), not `audit_logs`. `setup.ts`'s `application_name` probe
 * already refuses to run this suite against a database a worker is
 * connected to; the reclaim helper below re-checks `audit_logs` in
 * teardown as a second line of defense and reports a VC2 violation by name
 * rather than passing vacuously.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Account } from "next-auth";

// `@/auth` (below) is imported for its two plain exported functions —
// `ensureTenantMembershipForSignIn` and `assertBootstrapSingleMember` — both
// defined, and usable standalone, before the module's bottom-of-file
// `NextAuth({...})` call. That call is what this mock replaces: the real
// `next-auth` package unconditionally imports `next/server` (for a
// `NextRequest` type guard `next-auth/lib/env.js` uses), which this suite's
// node-environment/forks pool cannot resolve natively — the installed `next`
// package has no package.json `exports` entry for `./server`, and Node's own
// ESM resolver, unlike Next's build-time bundler, does not append `.js` for
// a bare extensionless specifier. Mocking `next-auth` itself (rather than
// trying to stub `next/server`, which is next-auth's OWN internal import and
// not reliably interceptable from here) means the real `next-auth/index.js`
// — and therefore its `next/server` import — never loads at all. Everything
// this file actually exercises (`@/lib/prisma`, tenant resolution, the audit
// outbox) stays completely real; only the unused `NextAuth(...)` call result
// is a stub, exactly as src/auth.test.ts's UNIT config mocks it, but here for
// module-resolution reasons rather than to avoid a live DB.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { runToken } from "@/__tests__/helpers/tenant-claim-fixtures";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { pgConstraintName } from "@/lib/prisma/prisma-error";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { ensureTenantMembershipForSignIn } from "@/auth";

describe("C3: a sentinel-pointing tenant_claims row denies sign-in reportably", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /**
   * A fresh, storable claim scoped to this run. `runToken()` (not a bare
   * `randomUUID()`) matches this suite's own convention
   * (tenant-claim-fixtures.ts) for a claim literal that cannot collide with
   * another working copy on the shared dev database; the `.example` suffix
   * and lowercase-hex token are already normalized (storableClaimSchema:
   * printable ASCII, trim+lowercase idempotent).
   */
  function freshClaim(arm: string): string {
    return `c3-${arm}-${runToken()}.example`;
  }

  /** Rows AUTH_LOGIN_FAILURE wrote for `claim`, read from audit_outbox. */
  async function auditOutboxRowsForClaim(
    claim: string,
  ): Promise<{ id: string; tenant_id: string; reason: string; claim: string | null; claim_refusal: string | null }[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        { id: string; tenant_id: string; reason: string; claim: string | null; claim_refusal: string | null }[]
      >(
        `SELECT id::text, tenant_id::text,
                payload->'metadata'->>'reason' AS reason,
                payload->'metadata'->>'claim' AS claim,
                payload->'metadata'->>'claimRefusal' AS claim_refusal
           FROM audit_outbox
          WHERE payload->>'action' = 'AUTH_LOGIN_FAILURE'
            AND payload->'metadata'->>'claim' = $1`,
        claim,
      );
    });
  }

  /**
   * Teardown for a claim-scoped AUTH_LOGIN_FAILURE emit. Re-reads
   * `audit_outbox` fresh (not the `beforeEach`/case-time snapshot — the dev
   * database is shared between working copies) and fails loud, naming
   * docs/operations/sentinel-tenant-membership.md, if the row is missing
   * from `audit_outbox` but present in `audit_logs`: that shape means a
   * live worker drained it while this suite ran (VC2), and every assertion
   * the case made against `audit_outbox` passed vacuously.
   */
  async function reclaimAuditOutboxByClaim(claim: string, expectedTenantId: string): Promise<void> {
    const rows = await auditOutboxRowsForClaim(claim);
    const drained = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM audit_logs
          WHERE tenant_id = $1::uuid AND metadata->>'claim' = $2`,
        expectedTenantId,
        claim,
      );
    });
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
            WHERE id = ANY($1::uuid[]) AND status IN ('PENDING', 'PROCESSING')`,
          ids,
        );
        await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE id = ANY($1::uuid[])`, ids);
      });
    }
    if (Number(drained[0]!.n) > 0) {
      throw new Error(
        `VC2 violation: an audit-outbox worker drained the AUTH_LOGIN_FAILURE row for claim ` +
          `"${claim}" while this suite ran (see CLAUDE.md and ` +
          `docs/operations/sentinel-tenant-membership.md). Stop audit-outbox-worker and ` +
          "retention-gc-worker and re-run; the audit_logs row is left in place — deleting it " +
          "would break the tenant's hash chain.",
      );
    }
  }

  /**
   * Remove a `tenant_claims` row this case pointed at the sentinel, and the
   * append-only `tenant_claim_events` rows its create (register) and this
   * delete (deregister) produce.
   *
   * Mirrors `dropSentinelClaims` in the "sentinel tenant (C12)" block of
   * tenant-claim-cli.integration.test.ts, which this suite's first run
   * discovered the hard way: that block's own `beforeEach` precondition
   * refuses to run when the sentinel already holds any `tenant_claim_events`
   * row, and this file's fixtures (creating, then merely `.delete()`-ing, a
   * sentinel-pointing tenant_claims row) were leaving exactly that residue —
   * `tenant_claim_events_purge_for_tenant` is the only sanctioned way to
   * remove one, and it is scoped to the whole tenant, not to a claim, so a
   * bare `.delete()` here left both the register and deregister events
   * permanently attributed to the sentinel.
   *
   * Deliberately narrower than a copy of `dropSentinelClaims`: this file
   * only ever creates ONE sentinel-pointing claim per case, so the DELETE of
   * that specific row (by its own UNIQUE `claim`) is always precise and safe
   * regardless of what else exists on the shared sentinel — only the
   * TENANT-SCOPED purge call needs the "is everything here attributable to
   * this claim" guard, and only that call is skipped (with a warning, not a
   * throw — this runs in a `finally`) when it would not be.
   */
  async function dropSentinelClaim(claim: string): Promise<void> {
    const beforeState = await ctx.su.prisma.$queryRaw<{ claims: bigint; events: bigint }[]>`
      SELECT
        (SELECT COUNT(*)::bigint FROM tenant_claims
           WHERE tenant_id = ${SYSTEM_TENANT_ID}::uuid) AS claims,
        (SELECT COUNT(*)::bigint FROM tenant_claim_events
           WHERE old_tenant_id = ${SYSTEM_TENANT_ID}::uuid
              OR new_tenant_id = ${SYSTEM_TENANT_ID}::uuid) AS events
    `;
    const mine = await ctx.su.prisma.tenantClaim.count({
      where: { tenantId: SYSTEM_TENANT_ID, claim },
    });
    const attributable = await ctx.su.prisma.tenantClaimEvent.count({
      where: { claim, OR: [{ oldTenantId: SYSTEM_TENANT_ID }, { newTenantId: SYSTEM_TENANT_ID }] },
    });

    await ctx.su.prisma.tenantClaim.delete({ where: { claim } }).catch(() => {});

    const claims = Number(beforeState[0]!.claims);
    const events = Number(beforeState[0]!.events);
    if (claims > mine || events > attributable) {
      console.warn(
        `[C3] leaving sentinel tenant_claim_events in place: another working copy holds rows ` +
          `there too (claims=${claims}, mine=${mine}, events=${events}, attributable=${attributable}). ` +
          "See docs/operations/sentinel-tenant-membership.md.",
      );
      return;
    }
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(`SELECT tenant_claim_events_purge_for_tenant($1::uuid)`, SYSTEM_TENANT_ID);
    });
  }

  // ─── Criterion 1: first-ever sign-in ──────────────────────────────────

  it(
    "first-ever sign-in: users_not_system_tenant denies, rolls back, and emits exactly one AUTH_LOGIN_FAILURE",
    async () => {
      const claim = freshClaim("first");
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: SYSTEM_TENANT_ID, claim, createdBy: "c3-integration-test" },
      });
      const email = `c3-first-${randomUUID()}@example.invalid`;
      const adapter = createCustomAdapter();
      // Adapter#createUser is optional on the Adapter interface (Auth.js
      // allows omitting it); createCustomAdapter() always implements it, but
      // the type does not say so — guarded rather than asserted with `!`.
      const createUser = adapter.createUser;
      if (!createUser) {
        throw new Error("createCustomAdapter() did not implement createUser");
      }

      try {
        let caught: unknown;
        // createUser's `.catch` always ends in `throw error` (auth-adapter.ts)
        // regardless of which arm it classifies, so the call below MUST
        // reject; a resolved promise here means the fixture never reached the
        // write this case exists to exercise.
        await tenantClaimStorage.run({ tenantClaim: claim }, async () => {
          try {
            // `id` is discarded by the real implementation (it reads only
            // name/email/image/emailVerified and mints its own id via
            // tx.user.create) — supplied only to satisfy the public Adapter
            // type, which (unlike auth-adapter.ts's own internal signature)
            // requires the full AdapterUser shape.
            await createUser({ id: "unused-pre-gen-id", name: null, email, emailVerified: null, image: null });
          } catch (e) {
            caught = e;
          }
        });

        expect(caught).toBeDefined();
        // By value: `user.create` precedes `tenantMember.create` in
        // createUser's transaction (auth-adapter.ts), so this is the
        // constraint that fires on a first-ever sign-in specifically —
        // not "some sentinel CHECK".
        expect(pgConstraintName(caught)).toBe("users_not_system_tenant");

        // Rolled back: withBypassRls's transaction aborts on the CHECK
        // violation, so no `users` row survives under this email.
        const userRows = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM users WHERE email = ${email}
        `;
        expect(Number(userRows[0]!.n)).toBe(0);

        const rows = await auditOutboxRowsForClaim(claim);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe("tenant_claim_system_tenant");
        // Load-bearing per the plan: `tenant-domain unmapped` drops a row
        // carrying neither `claim` nor `claimRefusal`, and this arm's emit
        // has no `ClaimRefusalDiagnosis` to carry (a CHECK produces none).
        expect(rows[0]!.claim).toBe(claim);
        expect(rows[0]!.claim_refusal).toBeNull();
        // No user row exists yet at emit time, so resolveTenantId cannot
        // bind to one — the row lands under the sentinel itself.
        expect(rows[0]!.tenant_id).toBe(SYSTEM_TENANT_ID);
      } finally {
        await dropSentinelClaim(claim);
        await reclaimAuditOutboxByClaim(claim, SYSTEM_TENANT_ID);
      }
    },
  );

  // ─── Criterion 2: returning user, no membership anywhere ─────────────

  it(
    "returning user with no membership: tenant_members_not_system_tenant denies, asserted by value — a different constraint than criterion 1's",
    async () => {
      const homeTenantId = await ctx.createTenant();
      const userId = randomUUID();
      const email = `c3-returning-${userId}@example.invalid`;
      // Raw insert, deliberately WITHOUT a tenant_members row: ctx.createUser
      // would also create an OWNER membership, which is exactly the state
      // this case must NOT have — resolveUserTenantIdFromClient (auth.ts's
      // claimedTenantMembership) has to read zero rows so the fixture takes
      // the no-membership arm (rows 4/8), not rows 7/9b.
      //
      // homeTenantId and userId are two independent randomUUID()s, so
      // `NEW.tenant_id = md5(NEW.id::text)::uuid` never holds and the
      // ensure_tenant_owner_membership_after_user_insert trigger stays
      // silent — if it fired it would create exactly the membership row
      // this fixture needs absent.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO users (id, tenant_id, email, updated_at) VALUES ($1::uuid, $2::uuid, $3, now())`,
          userId,
          homeTenantId,
          email,
        );
      });

      const claim = freshClaim("returning");
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: SYSTEM_TENANT_ID, claim, createdBy: "c3-integration-test" },
      });

      // Observation-only spy on the REAL classifier: no .mockImplementation
      // is set, so behaviour is unchanged (vi.spyOn calls through by
      // default) and this only records what `ensureTenantMembershipForSignIn`
      // actually saw. `ensureTenantMembershipForSignIn`'s own return value
      // carries no constraint name (it is folded into `reason`), so this is
      // the only way to prove BY VALUE which constraint fired without
      // re-deriving one independently of the call under test.
      const sentinelModule = await import("@/lib/tenant/sentinel-tenant-constraint");
      const classifySpy = vi.spyOn(sentinelModule, "classifySentinelTenantConstraint");

      try {
        const result = await ensureTenantMembershipForSignIn(
          userId,
          { provider: "google" } as unknown as Account,
          { hd: claim },
        );

        expect(result).toEqual({
          ok: false,
          reason: "tenant_claim_system_tenant",
          tenantId: null,
          claim,
          claimRefusal: null,
        });

        expect(classifySpy).toHaveBeenCalledTimes(1);
        // The different name criterion 1 needs: users_not_system_tenant
        // cannot fire on this path at all (this arm never writes `users`),
        // and this is the value the real classifier — fed the real
        // PostgreSQL error from this call — actually decided.
        expect(classifySpy.mock.results[0]?.value).toEqual({
          kind: "sentinel",
          constraint: "tenant_members_not_system_tenant",
        });

        // The mutation, not only the verdict: no membership survives for
        // this user under ANY tenant.
        const memberRows = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM tenant_members WHERE user_id = ${userId}::uuid
        `;
        expect(Number(memberRows[0]!.n)).toBe(0);
      } finally {
        classifySpy.mockRestore();
        await dropSentinelClaim(claim);
        // Removes the raw-inserted `users` row along with everything else
        // scoped to homeTenantId.
        await ctx.deleteTestData(homeTenantId);
      }
    },
  );

  // Round-note: the tenant-migration arm (auth.ts:409, user.update) re-fires
  // users_not_system_tenant — the SAME constraint criterion 1 already proves
  // by value, through a different write shape. The plan states this arm "may
  // be left to a unit case or omitted"; it is omitted here. A unit case would
  // still only assert that `tx.user.update` was called with a sentinel
  // tenantId, which the mocked auth.test.ts dispatch-table suite already
  // covers structurally (row 6/9a), so it would add coverage of the write
  // SHAPE without adding coverage of the CHECK actually firing — the one
  // thing criterion 1 already establishes for this exact constraint name.

  // ─── Criterion 5: allow arm ───────────────────────────────────────────

  it(
    "allow arm: an ordinary sign-in to a tenant the user already belongs to emits zero AUTH_LOGIN_FAILURE rows",
    async () => {
      const tenantId = await ctx.createTenant();
      const userId = await ctx.createUser(tenantId);
      const claim = freshClaim("allow");
      // An ORDINARY claim — points at the user's own tenant, not the
      // sentinel — so this fixture is the positive control every deny arm
      // above needs: without it, a version of ensureTenantMembershipForSignIn
      // that denied unconditionally would satisfy every assertion above.
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId, claim, createdBy: "c3-integration-test" },
      });

      try {
        const result = await ensureTenantMembershipForSignIn(
          userId,
          { provider: "google" } as unknown as Account,
          { hd: claim },
        );
        expect(result).toEqual({ ok: true });

        // By count, scoped to this run's own marker (never a bare sentinel
        // or deployment-wide count — the fixture-lifecycle rule this plan
        // states): a global zero would be racy against concurrent working
        // copies on the shared dev database; a marker-scoped zero is not.
        const rows = await auditOutboxRowsForClaim(claim);
        expect(rows).toHaveLength(0);
      } finally {
        // Not dropSentinelClaim: this claim points at an ORDINARY tenant, not
        // the sentinel, so the append-only tenant_claim_events row it
        // produced is already reachable — ctx.deleteTestData(tenantId) below
        // purges tenant_claim_events for tenantId as part of its own FK-safe
        // teardown (helpers.ts), which is the tenant-scoped case that routine
        // was written for.
        await ctx.su.prisma.tenantClaim.delete({ where: { claim } }).catch(() => {});
        await ctx.deleteTestData(tenantId);
      }
    },
  );
});
