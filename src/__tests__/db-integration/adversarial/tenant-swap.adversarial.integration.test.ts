// Adversarial: tenant-swap injection (issue #435 Category 2).
//
// Per Contract 1: tests use the SAME context helper as production
// (withTenantRls) — no nested $transaction on raw clients.
// Per Contract 4: passwordEntry vs teamPasswordEntry are distinct models.
// Per T5/F4 (Round 1): no route-handler invocation. Direct Prisma calls
// against ctx.app.prisma (passwd_app — NOSUPERUSER, NOBYPASSRLS) prove
// the actual RLS boundary.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { withTenantRls } from "@/lib/tenant-rls";
import { createTestContext, setBypassRlsGucs, type TestContext } from "../helpers";

describe("tenant-swap adversarial: cross-tenant resource access blocked by RLS", () => {
  let ctx: TestContext;
  let tenantA_id: string;
  let tenantB_id: string;
  let userB_id: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantA_id = await ctx.createTenant();
    tenantB_id = await ctx.createTenant();
    // userA is created so tenant A has a member (defense-in-depth: prevents
    // a "tenant has no users → empty result is meaningless" interpretation
    // of the negative assertion). Result not bound — the seed itself is the
    // contribution.
    await ctx.createUser(tenantA_id);
    userB_id = await ctx.createUser(tenantB_id);
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantA_id);
    await ctx.deleteTestData(tenantB_id);
  });

  describe("personal vault (passwordEntry)", () => {
    let tenantB_personalEntryId: string;

    beforeEach(async () => {
      // Seed a personal-vault entry in tenant B via the superuser client.
      tenantB_personalEntryId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO password_entries
           (id, encrypted_blob, blob_iv, blob_auth_tag,
            encrypted_overview, overview_iv, overview_auth_tag,
            key_version, user_id, tenant_id, created_at, updated_at)
           VALUES ($1::uuid, 'ct-blob', '000000000000000000000000', '00000000000000000000000000000000',
                   'ct-overview', '111111111111111111111111', '11111111111111111111111111111111',
                   1, $2::uuid, $3::uuid, now(), now())`,
          tenantB_personalEntryId,
          userB_id,
          tenantB_id,
        );
      });
    });

    it("attack: tenant A cannot read tenant B's personal vault entry under RLS", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantA_id, async (tx) => {
        return tx.passwordEntry.findUnique({
          where: { id: tenantB_personalEntryId },
          select: { id: true, tenantId: true, userId: true, encryptedBlob: true },
        });
      });
      expect(found).toBeNull();
    });

    it("positive control: tenant B context returns the seeded entry (proves RLS, not absence)", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantB_id, async (tx) => {
        return tx.passwordEntry.findUnique({
          where: { id: tenantB_personalEntryId },
          select: { id: true, tenantId: true, userId: true },
        });
      });
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tenantB_personalEntryId);
      expect(found?.tenantId).toBe(tenantB_id);
      expect(found?.userId).toBe(userB_id);
    });

    it("defense-in-depth: explicit tenantId mismatch returns null even with permissive RLS context", async () => {
      // Same query but explicit `tenantId: tenantA_id` filter — must not match
      // even when RLS context is tenantB (where the row IS visible).
      const found = await withTenantRls(ctx.app.prisma, tenantB_id, async (tx) => {
        return tx.passwordEntry.findFirst({
          where: { id: tenantB_personalEntryId, tenantId: tenantA_id },
        });
      });
      expect(found).toBeNull();
    });
  });

  describe("team vault (teamPasswordEntry)", () => {
    let tenantB_teamId: string;
    let tenantB_teamEntryId: string;

    beforeEach(async () => {
      // Seed a team in tenant B + a team-vault entry via the superuser client.
      tenantB_teamId = randomUUID();
      tenantB_teamEntryId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
          tenantB_teamId,
          tenantB_id,
          `team-${tenantB_teamId.slice(0, 8)}`,
          `team-slug-${tenantB_teamId.slice(0, 8)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO team_members
           (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER', true, now(), now())`,
          randomUUID(),
          tenantB_teamId,
          userB_id,
          tenantB_id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO team_password_entries
           (id, encrypted_blob, blob_iv, blob_auth_tag,
            encrypted_overview, overview_iv, overview_auth_tag,
            team_id, tenant_id, created_by_id, updated_by_id, created_at, updated_at)
           VALUES ($1::uuid, 'ct-team-blob', '222222222222222222222222', '22222222222222222222222222222222',
                   'ct-team-overview', '333333333333333333333333', '33333333333333333333333333333333',
                   $2::uuid, $3::uuid, $4::uuid, $4::uuid, now(), now())`,
          tenantB_teamEntryId,
          tenantB_teamId,
          tenantB_id,
          userB_id,
        );
      });
    });

    it("attack: tenant A cannot read tenant B's team vault entry under RLS", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantA_id, async (tx) => {
        return tx.teamPasswordEntry.findUnique({
          where: { id: tenantB_teamEntryId },
          select: { id: true, tenantId: true, teamId: true, encryptedBlob: true },
        });
      });
      expect(found).toBeNull();
    });

    it("positive control: tenant B context returns the seeded team entry", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantB_id, async (tx) => {
        return tx.teamPasswordEntry.findUnique({
          where: { id: tenantB_teamEntryId },
          select: { id: true, tenantId: true, teamId: true },
        });
      });
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tenantB_teamEntryId);
      expect(found?.tenantId).toBe(tenantB_id);
      expect(found?.teamId).toBe(tenantB_teamId);
    });

    it("defense-in-depth: explicit tenantId mismatch returns null even with permissive RLS context", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantB_id, async (tx) => {
        return tx.teamPasswordEntry.findFirst({
          where: { id: tenantB_teamEntryId, tenantId: tenantA_id },
        });
      });
      expect(found).toBeNull();
    });
  });

  // T3: machine-identity tables share the same tenant-scoped RLS regime as the
  // vault tables but had no cross-tenant probe. service_accounts is the
  // representative table for the mcp_* / service_account* / *_token family — a
  // dropped or mis-scoped RLS policy on any of them would surface the same way.
  describe("machine identity (serviceAccount)", () => {
    let tenantB_saId: string;

    beforeEach(async () => {
      tenantB_saId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.serviceAccount.create({
          data: {
            id: tenantB_saId,
            tenantId: tenantB_id,
            name: `sa-${tenantB_saId.slice(0, 8)}`,
            createdById: userB_id,
          },
        });
      });
    });

    it("attack: tenant A cannot read tenant B's service account under RLS", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantA_id, async (tx) => {
        return tx.serviceAccount.findUnique({
          where: { id: tenantB_saId },
          select: { id: true, tenantId: true },
        });
      });
      expect(found).toBeNull();
    });

    it("positive control: tenant B context returns the seeded service account", async () => {
      const found = await withTenantRls(ctx.app.prisma, tenantB_id, async (tx) => {
        return tx.serviceAccount.findUnique({
          where: { id: tenantB_saId },
          select: { id: true, tenantId: true },
        });
      });
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tenantB_saId);
      expect(found?.tenantId).toBe(tenantB_id);
    });
  });
});
