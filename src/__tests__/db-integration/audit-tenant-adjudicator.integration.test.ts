/**
 * `resolveTenantId` decides an audit row's tenant with the same primitive its
 * readers use.
 *
 * The defect this pins: every reader of these rows scopes by the user's ACTIVE
 * MEMBERSHIP — personal reads open `withUserTenantRls` -> `resolveUserTenantId`,
 * tenant-admin reads open `requireTenantPermission` -> `getTenantMembership` —
 * while the writer read `User.tenantId`, a denormalized copy of the same fact
 * with nothing invalidating it. SCIM provisioning into another tenant
 * (`api/scim/v2/Users/route.ts`, which rejects only an ACTIVE membership
 * elsewhere) leaves the copy pointing at the old tenant. A row filed under the
 * stale copy is invisible to every reader, under RLS, permanently.
 *
 * Why this is an integration cell and not a mocked one. The divergence is a
 * relationship between two tables; a mocked `user.findUnique` returns whatever
 * the test says it returns, so it can assert the new query was ISSUED but not
 * that the two stores can disagree, which is the entire claim. The reader half
 * (`resolveUserTenantId`) is real code against the same rows here.
 *
 * The suite must run with the compose workers stopped (VC2 in CLAUDE.md): a
 * live outbox worker drains the rows these cases read back. Unlike the sibling
 * `audit-unattributable-tenant` file, every row here lands under a tenant this
 * file created, so `ctx.deleteTestData` reclaims them and the marker discipline
 * is only needed to tell this run's rows apart, not to repair the sentinel.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { logAuditAsync } from "@/lib/audit/audit";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const SKIP = !process.env.DATABASE_URL;
const MARKER_TARGET_TYPE = "IntegrationTestMarker";

describe("the audit writer and its readers agree on the tenant", () => {
  let ctx: TestContext;
  /** Cleaned newest-first: the membership tenant must go before the user's own. */
  const createdTenants: string[] = [];

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });
  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });
  afterEach(async () => {
    if (SKIP) return;
    // Reverse order: `deleteTestData` removes `tenant_members` for the tenant it
    // is handed and `users` by `users.tenant_id`, so a membership parked in a
    // second tenant has to be dropped before the user row it points at.
    for (const tenantId of createdTenants.splice(0).reverse()) {
      await ctx.deleteTestData(tenantId);
    }
  });

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    createdTenants.push(id);
    return id;
  }

  /** Deactivate every membership this user holds, then activate one in `tenantId`. */
  async function repointActiveMembership(userId: string, tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`,
        userId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
        randomUUID(),
        tenantId,
        userId,
      );
    });
  }

  async function deactivateAllMemberships(userId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`,
        userId,
      );
    });
  }

  /**
   * The tenant the emit actually landed under, found WITHOUT scoping the query
   * by tenant — the whole question is which one it chose, and a tenant-scoped
   * read would answer it by assumption.
   */
  async function emitAndReadTenant(userId: string): Promise<string | null> {
    const marker = randomUUID();
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId,
      actorType: ACTOR_TYPE.HUMAN,
      targetType: MARKER_TARGET_TYPE,
      targetId: marker,
    });
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id::text FROM audit_outbox WHERE payload->>'targetId' = $1`,
        marker,
      );
    });
    // One row or none — a marker is per-emit, so two would mean the read matched
    // something this cell did not write.
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.tenant_id ?? null;
  }

  // ─── [D] the divergent user ───────────────────────────────────────────────

  it.skipIf(SKIP)(
    "[D] files the row under the active membership, not the stale User.tenantId",
    async () => {
      const homeTenant = await newTenant();
      const userId = await ctx.createUser(homeTenant);
      const scimTenant = await newTenant();
      await repointActiveMembership(userId, scimTenant);

      // The fixture is the defect's precondition, asserted rather than assumed:
      // the two stores really do disagree here.
      expect(await userTenantColumn(userId)).toBe(homeTenant);
      expect(await resolveUserTenantId(userId)).toBe(scimTenant);

      expect(await emitAndReadTenant(userId)).toBe(scimTenant);
    },
  );

  it.skipIf(SKIP)(
    "[D] the row lands in the tenant the personal reader opens",
    async () => {
      // The property that actually matters. The cell above names `scimTenant`
      // literally, which a writer hard-coding "the newest membership" would also
      // satisfy; this one asserts the two adjudicators AGREE, which is the
      // contract, and would still hold if either primitive changed.
      const homeTenant = await newTenant();
      const userId = await ctx.createUser(homeTenant);
      await repointActiveMembership(userId, await newTenant());

      expect(await emitAndReadTenant(userId)).toBe(await resolveUserTenantId(userId));
    },
  );

  // ─── [R] the cases that must not move ─────────────────────────────────────

  it.skipIf(SKIP)("[R] an ordinary user still lands in their own tenant", async () => {
    // The allow companion. Without it, a writer that filed everything under some
    // other tenant would satisfy both cells above.
    const tenantId = await newTenant();
    const userId = await ctx.createUser(tenantId);

    expect(await emitAndReadTenant(userId)).toBe(tenantId);
  });

  it.skipIf(SKIP)("[R] a memberless actor falls back to User.tenantId", async () => {
    // This is the sentinel actors' path, exercised WITHOUT touching the sentinel
    // tenant — it is memberless by invariant, so it resolves no membership and
    // reaches the same fallback. The sibling file documents why writing under
    // the real sentinel is not reclaimable on a shared database.
    const tenantId = await newTenant();
    const userId = await ctx.createUser(tenantId);
    await deactivateAllMemberships(userId);

    expect(await resolveUserTenantId(userId)).toBeNull();
    expect(await emitAndReadTenant(userId)).toBe(tenantId);
  });

  async function userTenantColumn(userId: string): Promise<string> {
    const r = await ctx.su.pool.query(`SELECT tenant_id::text FROM users WHERE id = $1::uuid`, [
      userId,
    ]);
    return r.rows[0].tenant_id;
  }
});
