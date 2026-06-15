/**
 * Real-DB integration test for the tenant-boundary composite foreign keys added
 * in migrations 20260615000001 / 20260615000002:
 *
 *   service_account_tokens (service_account_id, tenant_id)
 *     → service_accounts (id, tenant_id)
 *   access_requests        (service_account_id, tenant_id)
 *     → service_accounts (id, tenant_id)
 *
 * These make it impossible to persist a token / access-request whose tenant_id
 * diverges from its parent service account's tenant_id. The application-layer
 * checks (validateServiceAccountToken, the access-request create path) are the
 * primary guard; this test asserts the DB is the backstop, so a future schema
 * edit that drops the composite FK fails CI rather than silently regressing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

// Gracefully skip the entire suite if DATABASE_URL is not configured.
const SKIP = !process.env.DATABASE_URL;

describe("composite FK: service-account tenant boundary", () => {
  let ctx: TestContext;
  let tenantA: string; // owns the service account
  let tenantB: string; // the "other" tenant a corrupted row would claim
  let saCreatorId: string;
  let saId: string;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    saCreatorId = await ctx.createUser(tenantA);
    saId = randomUUID();

    // Service account belongs to tenantA.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), now())`,
        saId,
        tenantA,
        `fk-test-sa-${saId.slice(0, 8)}`,
        saCreatorId,
      );
    });
  });

  afterAll(async () => {
    if (SKIP) return;
    // Deleting the SA cascades its tokens + access requests; then drop tenants.
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
    await ctx.cleanup();
  });

  async function insertSaToken(tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO service_account_tokens
           (id, service_account_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, now() + interval '1 hour', now())`,
        randomUUID(),
        saId,
        tenantId,
        randomUUID().replace(/-/g, ""), // unique token_hash
        "sa_test",
        "fk-test-token",
        "passwords:read",
      );
    });
  }

  async function insertAccessRequest(tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO access_requests
           (id, tenant_id, service_account_id, requested_scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 hour', now())`,
        randomUUID(),
        tenantId,
        saId,
        "passwords:read",
      );
    });
  }

  it.skipIf(SKIP)("rejects a service-account token whose tenant_id differs from its SA's tenant_id", async () => {
    await expect(insertSaToken(tenantB)).rejects.toThrow(
      /service_account_id_tenant_id_fkey/,
    );
  });

  it.skipIf(SKIP)("accepts a service-account token whose tenant_id matches its SA's tenant_id", async () => {
    await expect(insertSaToken(tenantA)).resolves.not.toThrow();
  });

  it.skipIf(SKIP)("rejects an access request whose tenant_id differs from its SA's tenant_id", async () => {
    await expect(insertAccessRequest(tenantB)).rejects.toThrow(
      /service_account_id_tenant_id_fkey/,
    );
  });

  it.skipIf(SKIP)("accepts an access request whose tenant_id matches its SA's tenant_id", async () => {
    await expect(insertAccessRequest(tenantA)).resolves.not.toThrow();
  });
});
