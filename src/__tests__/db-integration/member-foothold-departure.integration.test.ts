/**
 * Integration test (real DB): every writer that ends or reverses a tenant
 * membership revokes the footholds the member created — their live
 * service-account tokens and the admin vault resets they initiated that no
 * other admin has approved — in the same transaction, with an audit row per
 * item (docs/archive/review/member-foothold-containment-plan.md C4). Another
 * admin's token, an approved reset and an expired token stay.
 *
 * Production services run under the tenant's RLS context on passwd_app.
 *
 * The departure-race and containment-fence cells are in
 * foothold-write-gate.integration.test.ts.
 *
 * Run: npm run test:integration -- member-foothold-departure
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { departCreatedMembership, departFromTenant, returnToTenant } from "@/lib/team/team-departure";
import { deactivateScimUser } from "@/lib/services/scim-user-service";

const hex = (n: number) => randomBytes(n).toString("hex");
const ACTOR = { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM };

type Writer = (tenantId: string, userId: string) => Promise<unknown>;

const WRITERS: [string, Writer, "active" | "deactivated"][] = [
  [
    "departFromTenant",
    (tenantId, userId) => withTenantRls(prisma, tenantId, (tx) => departFromTenant(tx, tenantId, [userId], { actor: ACTOR })),
    "active",
  ],
  [
    "deactivateScimUser",
    (tenantId, userId) => withTenantRls(prisma, tenantId, () => deactivateScimUser(tenantId, userId, ACTOR)),
    "active",
  ],
  [
    "departCreatedMembership",
    (tenantId, userId) =>
      withTenantRls(prisma, tenantId, (tx) => departCreatedMembership(tx, tenantId, [userId], { actor: ACTOR })),
    "deactivated",
  ],
  [
    "returnToTenant",
    (tenantId, userId) => withTenantRls(prisma, tenantId, (tx) => returnToTenant(tx, tenantId, [userId], { actor: ACTOR })),
    "deactivated",
  ],
];

describe("a membership end revokes the member's creator footholds — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });

  afterEach(async () => {
    // admin_vault_resets FKs the tenant with RESTRICT.
    await sql(`DELETE FROM admin_vault_resets WHERE tenant_id = $1::uuid`, tenantId);
    await ctx.deleteTestData(tenantId);
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  async function member(): Promise<string> {
    const id = await ctx.createUser(tenantId);
    // createUser makes OWNERs, whom a departure never touches.
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE user_id = $1::uuid`, id);
    return id;
  }

  async function serviceAccount(createdBy: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), now())`,
      id, tenantId, `sa-${id.slice(0, 8)}`, createdBy,
    );
    return id;
  }

  async function token(serviceAccountId: string, createdBy: string, expires: "future" | "past"): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO service_account_tokens (id, service_account_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_by_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'sa_test', 'token', 'credentials:list',
               now() + ${expires === "future" ? "interval '1 day'" : "interval '-1 day'"}, $5::uuid, now())`,
      id, serviceAccountId, tenantId, hex(32), createdBy,
    );
    return id;
  }

  async function reset(initiator: string, target: string, approvedBy: string | null = null): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, token_hash, encrypted_token,
         target_email_at_initiate, expires_at, approved_at, approved_by_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '24 hours',
               ${approvedBy ? "now()" : "NULL"}, $8::uuid, now())`,
      id, tenantId, target, initiator, hex(32), `enc-${hex(8)}`, `target-${id.slice(0, 8)}@example.com`, approvedBy,
    );
    return id;
  }

  async function tokenRevoked(id: string): Promise<boolean> {
    const [row] = await sql<{ revoked_at: Date | null }>(`SELECT revoked_at FROM service_account_tokens WHERE id = $1::uuid`, id);
    return row.revoked_at !== null;
  }

  async function resetState(id: string): Promise<{ revoked: boolean; hasToken: boolean }> {
    const [row] = await sql<{ revoked_at: Date | null; encrypted_token: string | null }>(
      `SELECT revoked_at, encrypted_token FROM admin_vault_resets WHERE id = $1::uuid`, id,
    );
    return { revoked: row.revoked_at !== null, hasToken: row.encrypted_token !== null };
  }

  async function auditRows(action: string): Promise<{ targetId: string; metadata: Record<string, unknown>; userId: string }[]> {
    const rows = await sql<{ payload: { targetId: string; metadata: Record<string, unknown>; userId: string } }>(
      `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->>'action' = $2`,
      tenantId, action,
    );
    return rows.map((r) => r.payload);
  }

  it.each(WRITERS)("%s revokes the member's live token and pending reset, and leaves the rest", async (_name, write, start) => {
    const leaver = await member();
    const admin = await member();
    const target = await member();
    const sa = await serviceAccount(admin);

    const liveToken = await token(sa, leaver, "future");
    const adminToken = await token(sa, admin, "future");
    const expiredToken = await token(sa, leaver, "past");
    const pendingReset = await reset(leaver, target);
    const approvedReset = await reset(leaver, target, admin);
    const adminReset = await reset(admin, target);
    if (start === "deactivated") {
      await sql(`UPDATE tenant_members SET deactivated_at = now() - interval '1 minute' WHERE user_id = $1::uuid`, leaver);
    }

    await write(tenantId, leaver);

    expect(await tokenRevoked(liveToken)).toBe(true);
    expect(await tokenRevoked(adminToken)).toBe(false);
    expect(await tokenRevoked(expiredToken)).toBe(false);
    expect(await resetState(pendingReset)).toEqual({ revoked: true, hasToken: false });
    expect(await resetState(approvedReset)).toEqual({ revoked: false, hasToken: true });
    expect(await resetState(adminReset)).toEqual({ revoked: false, hasToken: true });

    expect(await auditRows(AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE)).toEqual([
      expect.objectContaining({
        targetId: liveToken,
        userId: SYSTEM_ACTOR_ID,
        metadata: { serviceAccountId: sa, targetUserId: leaver, reason: "CREATOR_DEPARTED" },
      }),
    ]);
    expect(await auditRows(AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE)).toEqual([
      expect.objectContaining({
        targetId: target,
        userId: SYSTEM_ACTOR_ID,
        metadata: { resetId: pendingReset, initiatedById: leaver, reason: "INITIATOR_DEPARTED" },
      }),
    ]);
  });
});
