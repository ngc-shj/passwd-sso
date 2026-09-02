/**
 * Real-DB coverage for the unattributable-tenant encoding.
 *
 * `resolveTenantId` used to return null when an event could not be attributed,
 * and both callers then returned WITHOUT enqueuing — no `audit_outbox` row, no
 * `audit_logs` row, one dead-letter log line the shipped forwarder excludes.
 * It now returns `SYSTEM_TENANT_ID`, so the event reaches the outbox.
 *
 * Mocked suites (src/lib/audit/audit.test.ts and its twin) pin the branch. What
 * they cannot show is that the row is ACCEPTED by the database: `audit_outbox`
 * carries an FK to `tenants` with `onDelete: Restrict`, so the encoding only
 * works because the sentinel row actually exists. This file shows it by
 * WRITING through `logAuditAsync` — the production path — and reading the row
 * back, which is the only observation the FK participates in.
 *
 * Reclaim, and why it is marker-scoped. `logAuditAsync` returns void and
 * `audit_outbox` carries no caller-supplied key, so each emit here sets its own
 * discriminator: `targetId` is a per-run `randomUUID()`, and teardown selects
 * ids by that marker. It must never be `tenant_id = <sentinel>` alone — the dev
 * database is shared between working copies, and the sentinel legitimately
 * holds another copy's in-flight rows as well as the retention-GC worker's
 * heartbeats. For the same reason nothing here asserts a bare sentinel row
 * count.
 *
 * The suite must run with the compose workers stopped (VC2 in CLAUDE.md). A
 * running outbox worker drains what these cases write, and the sentinel's rows
 * are the one case teardown cannot repair: `ctx.deleteTestData` is tenant-
 * scoped and the sentinel is never handed to it. `afterEach` therefore reads
 * `audit_logs` back under each marker and fails the suite naming VC2 if a
 * drain happened.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SYSTEM_TENANT_ID, ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { logAuditAsync, type AuditLogParams } from "@/lib/audit/audit";
import { createTestContext, setBypassRlsGucs, sqlStateOf, type TestContext } from "./helpers";

const MARKER_TARGET_TYPE = "IntegrationTestMarker";

describe("unattributable audit events", () => {
  let ctx: TestContext;

  /** Emits this run made, with the tenant each one is expected to land under. */
  const emitted: { marker: string; tenantId: string }[] = [];
  /** Tenants this file created, cleaned in afterEach rather than at the end. */
  const createdTenants: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    // Last chance for anything `reclaimEmitted` could not remove. Every marker
    // it reclaims leaves the registry; one whose DELETE threw is still in it,
    // and without this the file's final case would strand it. Failures are
    // reported, not thrown — an afterAll throw buries the real failure.
    try {
      const stranded = await reclaimEmitted();
      if (stranded.length > 0) {
        console.warn(`[audit-unattributable] ${stranded.length} marker(s) unreclaimed:\n  ${stranded.join("\n  ")}`);
      }
    } catch (e) {
      console.warn(`[audit-unattributable] final reclaim failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await ctx.cleanup();
  });

  /**
   * Reclaim every registered marker, returning the problems found.
   *
   * A marker leaves `emitted` only once its own DELETE has committed. Emptying
   * the registry up front instead — `emitted.splice(0)` — reads the same until
   * a query in the loop throws, at which point every marker after it is gone
   * from the registry with its rows still on the database. Those rows sit under
   * the sentinel, which is the one tenant `ctx.deleteTestData` is never handed
   * and `trackTenant` now refuses, on a database shared between working copies:
   * there is no second sweep that would find them.
   */
  async function reclaimEmitted(): Promise<string[]> {
    const problems: string[] = [];

    for (const entry of [...emitted]) {
      const { marker, tenantId } = entry;
      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM audit_outbox
           WHERE tenant_id = $1::uuid AND payload->>'targetId' = $2`,
          tenantId,
          marker,
        );
      });

      // Read BEFORE the reclaim below removes the outbox row: this is the
      // detector for a run that shared the database with a live worker. It is
      // read-only on purpose — an `audit_logs` row carries a chain_seq, and
      // deleting one renumbers nothing, so a later chain verify would report a
      // false TAMPER at the first retained row.
      const drained = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT COUNT(*)::bigint AS n FROM audit_logs
           WHERE tenant_id = $1::uuid AND target_id = $2`,
          tenantId,
          marker,
        );
      });
      if (Number(drained[0]!.n) > 0) {
        problems.push(
          `VC2 violation: an audit-outbox worker drained marker ${marker} under tenant ` +
            `${tenantId} while this suite ran. Stop audit-outbox-worker and ` +
            `retention-gc-worker (see CLAUDE.md) and re-run. The audit_logs row is left ` +
            `in place deliberately — deleting it would break the tenant's hash chain.`,
        );
      }

      if (rows.length === 0) {
        // Distinct from "deleted nothing": the emit was issued, so the absence
        // of a row is the encoding failing, not the reclaim having no work.
        problems.push(
          `the emit for marker ${marker} landed no audit_outbox row under tenant ${tenantId}`,
        );
        emitted.splice(emitted.indexOf(entry), 1);
        continue;
      }

      const ids = rows.map((r) => r.id);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // FAILED first: the BEFORE DELETE trigger on audit_outbox refuses any
        // row still PENDING or PROCESSING.
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
           WHERE id = ANY($1::uuid[]) AND status IN ('PENDING', 'PROCESSING')`,
          ids,
        );
        await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE id = ANY($1::uuid[])`, ids);
      });
      // Only now: the rows this entry names are gone.
      emitted.splice(emitted.indexOf(entry), 1);
    }

    return problems;
  }

  afterEach(async () => {
    // In afterEach, not at the end of each case: a trailing statement does not
    // run once an assertion above it throws, and a failed case is exactly when
    // rows have been written and nothing has removed them.
    const problems = await reclaimEmitted();

    for (const tenantId of createdTenants.splice(0)) {
      await ctx.deleteTestData(tenantId);
    }

    if (problems.length > 0) throw new Error(problems.join("\n"));
  });

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    createdTenants.push(id);
    return id;
  }

  /**
   * Emit through the production path with a fresh marker, and register it for
   * reclaim. Registered AFTER the call returns, which is unconditional —
   * `logAuditAsync` never throws — so a registered marker always means "an emit
   * was issued", which is what makes the fail-loud clause in afterEach honest.
   */
  async function emitWithMarker(
    params: Omit<AuditLogParams, "targetType" | "targetId">,
    expectedTenantId: string,
  ): Promise<string> {
    const marker = randomUUID();
    await logAuditAsync({ ...params, targetType: MARKER_TARGET_TYPE, targetId: marker });
    emitted.push({ marker, tenantId: expectedTenantId });
    return marker;
  }

  async function outboxTenantsForMarker(marker: string): Promise<string[]> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id::text FROM audit_outbox WHERE payload->>'targetId' = $1`,
        marker,
      );
    });
    return rows.map((r) => r.tenant_id);
  }

  it("the sentinel tenant row exists, which is what makes the encoding writable", async () => {
    // The FK is the reason this is a real-DB case rather than a unit one:
    // audit_outbox.tenant_id references tenants(id) ON DELETE RESTRICT, so an
    // encoding that named a non-existent tenant would fail at insert time and
    // the entry would be lost exactly as before.
    const rows = await ctx.su.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenants WHERE id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it("an unattributable emit is accepted by the database under the sentinel tenant", async () => {
    // The write the docblock claims. ANONYMOUS_ACTOR_ID has no `users` row, so
    // resolveTenantId's lookup misses and returns SYSTEM_TENANT_ID; the insert
    // then has to satisfy audit_outbox_tenant_id_fkey, which only the sentinel
    // row above lets it do. Before the encoding landed this call enqueued
    // nothing at all, so the assertion below reads 1 where it used to read 0.
    const marker = await emitWithMarker(
      {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
        userId: ANONYMOUS_ACTOR_ID,
        actorType: ACTOR_TYPE.ANONYMOUS,
      },
      SYSTEM_TENANT_ID,
    );

    expect(await outboxTenantsForMarker(marker)).toEqual([SYSTEM_TENANT_ID]);
  });

  it("an attributable emit lands under the actor's own tenant, not the sentinel", async () => {
    // The differential. Without it the case above passes against a
    // resolveTenantId that answers SYSTEM_TENANT_ID unconditionally — which is
    // the one regression that would silently strip every event in the
    // deployment of its owner while leaving both cases' row counts intact.
    const tenantId = await newTenant();
    const userId = await ctx.createUser(tenantId);

    const marker = await emitWithMarker(
      {
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId,
        actorType: ACTOR_TYPE.HUMAN,
      },
      tenantId,
    );

    expect(await outboxTenantsForMarker(marker)).toEqual([tenantId]);
  });

  it("both roads to `DELETE FROM tenants` refuse the sentinel, and neither refuses an ordinary tenant", async () => {
    // The class is "a caller-supplied id reaching that DELETE", so both entry
    // points are arms here. trackTenant is the registration road (cleanup()
    // sweeps what it holds); deleteTestData is the direct one, and every file
    // in this suite calls it with an id of its own — guarding only the first
    // would leave the shorter road open.
    expect(() => ctx.trackTenant(SYSTEM_TENANT_ID)).toThrow(/sentinel tenant/);
    await expect(ctx.deleteTestData(SYSTEM_TENANT_ID)).rejects.toThrow(/sentinel tenant/);

    // The allow arms: the guard is keyed on the sentinel, not on the operation.
    const ordinary = await newTenant();
    expect(() => ctx.trackTenant(ordinary)).not.toThrow();
    await expect(ctx.deleteTestData(ordinary)).resolves.not.toThrow();
    // deleteTestData already removed it; afterEach must not run it twice.
    createdTenants.splice(createdTenants.indexOf(ordinary), 1);
  });

  it("no tenant membership grants access to the sentinel tenant", async () => {
    // The access boundary the encoding rests on. /api/tenant/audit-logs scopes
    // by membership, so zero members is what keeps these rows out of every
    // tenant's view — and it is what makes SYSTEM_TENANT_ID an encoding of "no
    // owning tenant" rather than a binding to somebody else's.
    const rows = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM tenant_members WHERE tenant_id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("the engine refuses a tenant_members row naming the sentinel, and accepts the same row elsewhere", async () => {
    // What makes the count above an invariant instead of an observation. The
    // two arms differ in exactly one bound parameter, and both use a real
    // `users` row so the deny arm cannot pass on a 23503 it never intended to
    // raise — the channel asserted is the CHECK by name.
    const homeTenantId = await newTenant();
    const otherTenantId = await newTenant();
    const userId = await ctx.createUser(homeTenantId);

    const insertMembership = (tenantId: string) =>
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
          randomUUID(),
          tenantId,
          userId,
        );
      });

    const denied = await insertMembership(SYSTEM_TENANT_ID).catch((e: unknown) => e);
    expect(sqlStateOf(denied)).toBe("23514");
    expect(String(denied)).toContain("tenant_members_not_system_tenant");
    // The mutation, not only the verdict: the row this user would have held is
    // the whole subject, so read it back rather than inferring it from the code.
    const sentinelMembers = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM tenant_members
      WHERE tenant_id = ${SYSTEM_TENANT_ID}::uuid AND user_id = ${userId}::uuid
    `;
    expect(Number(sentinelMembers[0]!.n)).toBe(0);

    await expect(insertMembership(otherTenantId)).resolves.not.toThrow();
  });

  it("the AFTER INSERT trigger still provisions a membership from a lone users insert", async () => {
    // The writer whose blast radius differs from every other: a 23514 raised
    // inside ensure_tenant_owner_membership_after_user_insert() aborts the
    // PARENT `users` INSERT, so the symptom is a failed account creation with no
    // visible link to tenant_members.
    //
    // Firing it takes work, which is why the case below it does not: the
    // predicate is `NEW.tenant_id = md5(NEW.id::text)::uuid`, and two
    // independent randomUUID()s never satisfy it. So the tenant id is DERIVED
    // from the user id here, and only the `users` row is inserted — the
    // membership that appears is the trigger's.
    const userId = randomUUID();
    const [{ tid }] = await ctx.su.prisma.$queryRaw<{ tid: string }[]>`
      SELECT md5(${userId}::text)::uuid::text AS tid
    `;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, now(), now())`,
        tid,
        `trigger-tenant-${tid.slice(0, 8)}`,
        `trigger-${tid.replace(/-/g, "").slice(0, 16)}`,
      );
    });
    ctx.trackTenant(tid);
    createdTenants.push(tid);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
        userId,
        tid,
        `trigger-${userId.slice(0, 8)}@example.com`,
        `Trigger User ${userId.slice(0, 8)}`,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM tenant_members WHERE user_id = $1::uuid`,
        userId,
      );
    });
    // The membership exists and nothing but the trigger wrote it.
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("the sign-up writer still completes: a users row and its membership in one transaction", async () => {
    // The highest-traffic shape — an explicit `tenant_members` INSERT in the
    // same transaction as the `users` row, which is what ctx.createUser does and
    // what the sign-in paths do. NOT the trigger: see the case above for that
    // one, and for why this fixture cannot fire it.
    const tenantId = await newTenant();
    const userId = await ctx.createUser(tenantId);

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ users: bigint; members: bigint }[]>(
        `SELECT
           (SELECT COUNT(*)::bigint FROM users WHERE id = $1::uuid) AS users,
           (SELECT COUNT(*)::bigint FROM tenant_members WHERE user_id = $1::uuid) AS members`,
        userId,
      );
    });
    expect(Number(rows[0]!.users)).toBe(1);
    expect(Number(rows[0]!.members)).toBe(1);
  });

  it("reads back the retention each tenant actually stores, rather than a constant", async () => {
    // Calibration for the case below, and nothing more: it says the projection
    // this file reads discriminates between tenants, so "the sentinel reads
    // NULL" is a fact about the sentinel and not about the query. Two distinct
    // values, because a projection hard-coded to either one still passes with
    // a single tenant. The retention-GC clamps to a configured minimum at sweep
    // time, so this is the STORED value, not the effective one.
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_log_retention_days = 90 WHERE id = $1::uuid`,
        tenantA,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_log_retention_days = 365 WHERE id = $1::uuid`,
        tenantB,
      );
    });

    const rows = await ctx.su.prisma.$queryRaw<{ id: string; days: number | null }[]>`
      SELECT id::text AS id, audit_log_retention_days AS days FROM tenants
      WHERE id IN (${tenantA}::uuid, ${tenantB}::uuid)
    `;
    // Fail loud rather than vacuously: a zero-row read must not pass the loop.
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r.days]));
    expect(byId.get(tenantA)).toBe(90);
    expect(byId.get(tenantB)).toBe(365);
  });

  it("the sentinel tenant has no audit-log retention, and that is a recorded decision", async () => {
    // Pins the option (a) decision so a later migration cannot adopt (b)
    // silently. If this assertion is ever changed, the change is that decision
    // being revisited, not a test being updated.
    //
    // The decision's recorded rationale was HALF WRONG and is corrected here.
    // It said a retention would incur the chain-verify interaction —
    // audit_log_purge does not renumber chain_seq, so a default fromSeq=1
    // verify reports a false TAMPER at the first retained row
    // (docs/security/audit-chain-threat-model.md #retention-purge-interaction).
    // That interaction is real, and it does NOT apply to this tenant: the
    // sentinel's audit_chain_enabled is false (the schema default), so it has no
    // chain to falsify. Measured, not assumed.
    //
    // What the NULL actually costs, stated plainly because the rationale above
    // used to obscure it: sweepAuditLogs enumerates only tenants with
    // auditLogRetentionDays IS NOT NULL, so these rows are never purged — and
    // pre-auth paths can produce them. That is unbounded growth this branch
    // accepts rather than solves; see CF18 in the plan for the derivation and
    // for what setting a retention would need first.
    //
    // Detection only, and deliberately so: the mutation that would redden it
    // for the reason it claims is writing a retention onto the sentinel row of
    // this shared live database, which is not a mutation this suite may make.
    // The case above is what shows the instrument can read a value at all.
    const rows = await ctx.su.prisma.$queryRaw<{ days: number | null }[]>`
      SELECT audit_log_retention_days AS days FROM tenants WHERE id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.days).toBeNull();
  });
});
