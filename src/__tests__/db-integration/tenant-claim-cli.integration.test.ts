/**
 * Real-DB integration tests for C7 — the offline operator CLI
 * (scripts/tenant-domain.ts).
 *
 * Placed here (not scripts/__tests__/*.test.mjs — round-2 T6) so it runs
 * under vitest.integration.config.ts, not the unit suite: the unit suite's
 * `app-ci` job has a redis service and a dummy DATABASE_URL, which would
 * either redden the job or self-skip a test that actually needs a live DB.
 *
 * F15 — the dev database is shared between working copies and
 * UNIQUE(tenant_claims.claim) is deployment-global, so every claim literal
 * this file inserts is derived from the shared fixtures with a random
 * per-run suffix, following src/__tests__/db-integration/tenant-claim.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { AuditScope, AuditAction, ActorType, AuditOutboxStatus } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  PRIMARY_CLAIM,
  ALIAS_CLAIM,
  NON_DOMAIN_CLAIM,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import {
  cmdList,
  cmdUnmapped,
  cmdPreflight,
  cmdAdd,
  cmdRemove,
  formatUnmappedMessage,
} from "../../../scripts/tenant-domain";

const SKIP = !process.env.DATABASE_URL;
// The CLI reads MIGRATION_DATABASE_URL directly; the integration harness's
// superuser role connects through the same variable (see helpers.ts
// getConnectionString("superuser")), so setting it here — when the runner
// only exported DATABASE_URL — makes the CLI functions usable exactly the
// way an operator would invoke them.
if (!process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.MIGRATION_DATABASE_URL = process.env.DATABASE_URL;
}

function runToken(): string {
  return randomBytes(4).toString("hex");
}

const alwaysYes = async () => true;
const alwaysNo = async () => false;

describe("tenant-domain CLI (C7)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  describe("add", () => {
    it.skipIf(SKIP)("registers a new domain claim for the named tenant", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(true);
      expect(result.code).toBe(0);

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row).not.toBeNull();
      expect(row?.tenantId).toBe(tenantId);
      expect(row?.revokedAt).toBeNull();
      expect(row?.createdBy).toBe("test-op");

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("is idempotent: re-adding the same tenant+domain succeeds and leaves exactly one row", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const first = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op", yes: true });
      expect(first.ok).toBe(true);

      const second = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op-2", yes: true });
      expect(second.ok).toBe(true);
      expect(second.code).toBe(0);

      const rows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(tenantId);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("refuses a domain already owned by a different tenant, leaving tenantId unchanged", async () => {
      const ownerTenant = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: ownerTenant, claim, createdBy: "seed" } });

      const result = await cmdAdd({ tenant: otherTenant, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(ownerTenant);

      await ctx.deleteTestData(ownerTenant);
      await ctx.deleteTestData(otherTenant);
    });

    it.skipIf(SKIP)("D2: add after remove for the same tenant un-revokes the row (recovery, not a lie)", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const added = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op", yes: true });
      expect(added.ok).toBe(true);

      const removed = await cmdRemove({ tenant: tenantId, domain: claim, yes: true });
      expect(removed.ok).toBe(true);
      const afterRemove = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(afterRemove?.revokedAt).not.toBeNull();

      const readded = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op-recover", yes: true });
      expect(readded.ok).toBe(true);
      expect(readded.code).toBe(0);

      const afterReadd = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(afterReadd?.revokedAt).toBeNull();
      expect(afterReadd?.tenantId).toBe(tenantId);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("refuses a revoked claim owned by a different tenant, leaving revokedAt and tenantId untouched", async () => {
      const ownerTenant = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const revokedAt = new Date();
      const created = await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: ownerTenant, claim, createdBy: "seed", revokedAt },
      });

      const result = await cmdAdd({ tenant: otherTenant, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { id: created.id } });
      expect(row?.tenantId).toBe(ownerTenant);
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedAt?.getTime()).toBe(revokedAt.getTime());

      await ctx.deleteTestData(ownerTenant);
      await ctx.deleteTestData(otherTenant);
    });

    it.skipIf(SKIP)("normalises mixed-case input and rejects a non-domain value before any query", async () => {
      const tenantId = await ctx.createTenant();
      const token = runToken();
      const mixedCase = `${token}-Alias.Example`;
      const normalized = `${token}-alias.example`;

      const added = await cmdAdd({ tenant: tenantId, domain: mixedCase, by: "test-op", yes: true });
      expect(added.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: normalized } });
      expect(row).not.toBeNull();
      expect(row?.claim).toBe(normalized);

      const rejected = await cmdAdd({
        tenant: tenantId,
        domain: `https://${token}-alias.example`,
        by: "test-op",
        yes: true,
      });
      expect(rejected.ok).toBe(false);
      // Rejected before any DB row for this scheme-prefixed spelling exists.
      const noRow = await ctx.su.prisma.tenantClaim.findMany({
        where: { claim: { contains: `https://${token}` } },
      });
      expect(noRow).toHaveLength(0);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("an unresolvable --tenant is refused with no row changed", async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const result = await cmdAdd({ tenant: randomUUID(), domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row).toBeNull();
    });

    it.skipIf(SKIP)("aborts without writing when confirmation is declined", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op", confirm: alwaysNo });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row).toBeNull();

      await ctx.deleteTestData(tenantId);
    });
  });

  describe("remove", () => {
    it.skipIf(SKIP)("soft-deletes: revokedAt is set, and total row count is unchanged", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });
      const countBefore = await ctx.su.prisma.tenantClaim.count();

      const result = await cmdRemove({ tenant: tenantId, domain: claim, yes: true });

      expect(result.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).not.toBeNull();
      const countAfter = await ctx.su.prisma.tenantClaim.count();
      expect(countAfter).toBe(countBefore);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("refuses when --tenant does not own the domain, row intact", async () => {
      const ownerTenant = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: ownerTenant, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: otherTenant, domain: claim, yes: true });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(ownerTenant);
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(ownerTenant);
      await ctx.deleteTestData(otherTenant);
    });

    it.skipIf(SKIP)("removing an unknown domain is a non-zero exit", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdRemove({ tenant: tenantId, domain: claim, yes: true });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("an unresolvable --tenant is refused with no row changed", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: randomUUID(), domain: claim, yes: true });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("does not delete or invalidate any sessions row", async () => {
      const tenantId = await ctx.createTenant();
      const userId = await ctx.createUser(tenantId);
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

      const sessionToken = randomBytes(32).toString("hex");
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
          randomUUID(),
          sessionToken,
          userId,
          tenantId,
        );
      });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, yes: true });
      expect(result.ok).toBe(true);

      const session = await ctx.su.prisma.session.findUnique({ where: { sessionToken } });
      expect(session).not.toBeNull();
      expect(session?.tenantId).toBe(tenantId);

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE session_token = $1`, sessionToken);
      });
      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("aborts without mutating when confirmation is declined", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, confirm: alwaysNo });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(tenantId);
    });
  });

  describe("list", () => {
    it.skipIf(SKIP)("scoped to --tenant returns only that tenant's claims", async () => {
      const tenantA = await ctx.createTenant();
      const tenantB = await ctx.createTenant();
      const claimA = `${runToken()}.${PRIMARY_CLAIM}`;
      const claimB = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantA, claim: claimA, createdBy: "seed" } });
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantB, claim: claimB, createdBy: "seed" } });

      const result = await cmdList({ tenant: tenantA });

      expect(result.ok).toBe(true);
      const rows = (result.rows ?? []) as { claim: string; tenantId: string }[];
      expect(rows.some((r) => r.claim === claimA)).toBe(true);
      expect(rows.some((r) => r.claim === claimB)).toBe(false);

      await ctx.deleteTestData(tenantA);
      await ctx.deleteTestData(tenantB);
    });
  });

  describe("unmapped", () => {
    it.skipIf(SKIP)(
      "finds a denial present only in audit_outbox (worker stopped) and one present in audit_logs, and reports empty as a message when there are none",
      async () => {
        const tenantId = await ctx.createTenant();
        const outboxOnlyClaim = `${runToken()}.${ALIAS_CLAIM}`;
        const auditLogClaim = `${runToken()}.${ALIAS_CLAIM}`;

        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          // Present ONLY in audit_outbox — models a stopped outbox worker
          // (round-2 N14): the row never made it into audit_logs.
          await tx.auditOutbox.create({
            data: {
              tenantId,
              status: AuditOutboxStatus.PENDING,
              payload: {
                scope: AuditScope.PERSONAL,
                action: AuditAction.AUTH_LOGIN_FAILURE,
                userId: randomUUID(),
                actorType: ActorType.SYSTEM,
                serviceAccountId: null,
                teamId: null,
                targetType: null,
                targetId: null,
                metadata: { reason: "tenant_claim_unmapped", claim: outboxOnlyClaim, provider: "google" },
                ip: null,
                userAgent: null,
              },
            },
          });
          // Present in audit_logs — the normal (worker running) path,
          // exercising the OTHER JSON shape in the same UNION.
          await tx.auditLog.create({
            data: {
              tenantId,
              scope: AuditScope.PERSONAL,
              action: AuditAction.AUTH_LOGIN_FAILURE,
              userId: randomUUID(),
              actorType: ActorType.SYSTEM,
              metadata: { reason: "tenant_claim_unmapped", claim: auditLogClaim, provider: "google" },
            },
          });
        });

        const result = await cmdUnmapped();

        expect(result.ok).toBe(true);
        const rows = (result.rows ?? []) as { tenant_id: string; claim: string }[];
        expect(rows.some((r) => r.tenant_id === tenantId && r.claim === outboxOnlyClaim)).toBe(true);
        expect(rows.some((r) => r.tenant_id === tenantId && r.claim === auditLogClaim)).toBe(true);
        expect(result.message).toBeTruthy();

        await ctx.deleteTestData(tenantId);
      },
    );

    it("formatUnmappedMessage names the retained window when there are no rows (S12 — pure, no DB dependency)", () => {
      const message = formatUnmappedMessage([]);
      expect(message).toContain("retained window");
      expect(message).not.toBe("");
    });

    it("formatUnmappedMessage summarises a non-empty result", () => {
      const message = formatUnmappedMessage([
        { tenant_id: randomUUID(), claim: "alias.example", cnt: 3, last_seen: new Date() },
      ]);
      expect(message).toContain("1");
    });
  });

  describe("preflight", () => {
    it.skipIf(SKIP)("runs without error and reports counts", async () => {
      const result = await cmdPreflight();
      expect(result.ok).toBe(true);
      expect(result.code).toBe(0);
      expect(typeof result.message).toBe("string");
    });
  });

  describe("missing MIGRATION_DATABASE_URL", () => {
    it("every command fails closed with an actionable message and makes no connection", async () => {
      const saved = process.env.MIGRATION_DATABASE_URL;
      delete process.env.MIGRATION_DATABASE_URL;
      try {
        const results = await Promise.all([
          cmdList({}),
          cmdUnmapped(),
          cmdPreflight(),
          cmdAdd({ tenant: "acmecorp", domain: `${runToken()}.example`, by: "test-op", yes: true }),
          cmdRemove({ tenant: "acmecorp", domain: `${runToken()}.example`, yes: true }),
        ]);
        for (const result of results) {
          expect(result.ok).toBe(false);
          expect(result.code).not.toBe(0);
          expect(result.message).toMatch(/MIGRATION_DATABASE_URL/);
        }
      } finally {
        if (saved !== undefined) process.env.MIGRATION_DATABASE_URL = saved;
      }
    });
  });

  describe("non-domain claim (NON_DOMAIN_CLAIM fixture is exercised elsewhere)", () => {
    it.skipIf(SKIP)("remove accepts a non-domain claim that operatorDomainSchema would reject (S3-13 asymmetry)", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}-${NON_DOMAIN_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "backfill" } });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, yes: true });

      expect(result.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).not.toBeNull();

      await ctx.deleteTestData(tenantId);
    });
  });
});
