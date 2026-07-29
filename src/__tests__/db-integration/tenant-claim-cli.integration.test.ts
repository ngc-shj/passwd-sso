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
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
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
  migrationClientFactory,
  DEFAULT_UNMAPPED_WINDOW_DAYS,
} from "../../../scripts/tenant-domain";

const SKIP = !process.env.DATABASE_URL;

function runToken(): string {
  return randomBytes(4).toString("hex");
}

const alwaysYes = async () => true;
const alwaysNo = async () => false;

describe("tenant-domain CLI (C7)", () => {
  let ctx: TestContext;

  // The CLI reads MIGRATION_DATABASE_URL per call by design (C7), and the
  // integration harness's superuser role connects through the same variable
  // (helpers.ts getConnectionString("superuser")). When the runner exported
  // only DATABASE_URL, point the CLI at it so these tests invoke the commands
  // exactly the way an operator would. Re-stubbed per test rather than
  // assigned once at module scope: `process.env.X =` in a test file is
  // forbidden by scripts/checks/check-test-hygiene.sh gate (c), and the
  // missing-URL test below stubs this same variable to "" — without a
  // per-test unstub that stub would leak into every test declared after it.
  // The integration setup file wires no `vi.unstubAllEnvs()`, so this file
  // wires its own.
  beforeEach(() => {
    if (SKIP) return;
    if (!process.env.MIGRATION_DATABASE_URL) {
      vi.stubEnv("MIGRATION_DATABASE_URL", process.env.DATABASE_URL as string);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      // M5: the refusal must name the reassignment flag. The old message
      // instructed `remove` first, which loops — `remove` soft-deletes and
      // leaves tenant_id unchanged, so the next `add` lands here again.
      expect(result.message).toContain("--from");
      expect(result.message).not.toMatch(/run "remove" on the owning tenant first/);

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
      // M2 / SC8: the un-revoke must NOT overwrite createdBy with the new
      // --by. SC8 defers application-level audit on the premise that the row
      // itself carries who registered the claim; overwriting it on recovery
      // erased the only record that survived a remove→add cycle.
      expect(afterReadd?.createdBy).toBe("test-op");
      expect(afterReadd?.createdBy).not.toBe("test-op-recover");

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

  // M5 — the wrong-owner state is reachable with no operator action at all
  // (findOrCreateTenantForClaim auto-registers `createdBy: "signin"` rows),
  // and before --from the only exit was hand-written SQL. Every case here
  // asserts the ROW, not just the exit code: the whole point of the finding
  // was that a refusal and a loop are indistinguishable from the exit code.
  describe("add --from (reassignment)", () => {
    it.skipIf(SKIP)("moves the claim to the gaining tenant when --from names the current owner", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

      // Through the `confirm` seam rather than `--yes`, so this also pins
      // that the move is gated on a confirmation at all.
      const result = await cmdAdd({
        tenant: gainingTenant,
        domain: claim,
        by: "test-op",
        from: losingTenant,
        confirm: alwaysYes,
      });

      expect(result.ok).toBe(true);
      expect(result.code).toBe(0);

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(gainingTenant);
      expect(row?.revokedAt).toBeNull();
      // The original registrant survives the move (M2): a reassignment must
      // not erase who put the claim on the losing tenant in the first place.
      expect(row?.createdBy).toBe("signin");

      // Exactly one row — a reassignment moves, it does not duplicate.
      const rows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
      expect(rows).toHaveLength(1);

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
    });

    it.skipIf(SKIP)("refuses and does NOT move the row when --from is not the current owner", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const decoyTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

      const result = await cmdAdd({
        tenant: gainingTenant,
        domain: claim,
        by: "test-op",
        from: decoyTenant,
        yes: true,
      });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(losingTenant);
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
      await ctx.deleteTestData(decoyTenant);
    });

    it.skipIf(SKIP)("refuses a non-UUID --from before building a client, so a name-shaped --from never reaches a row", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

      // The owner-mismatch check further down would also refuse this, so the
      // exit code alone cannot distinguish the two. What the UUID guard adds
      // is that the refusal happens before any client is built — i.e. that
      // --from is never resolved through slugs, claims or external ids the
      // way --tenant is, which is what keeps a near-miss name from selecting
      // a losing tenant.
      const createSpy = vi.spyOn(migrationClientFactory, "create");
      try {
        const result = await cmdAdd({
          tenant: gainingTenant,
          domain: claim,
          by: "test-op",
          from: claim,
          yes: true,
        });

        expect(result.ok).toBe(false);
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
      }

      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(losingTenant);

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
    });

    it.skipIf(SKIP)("reassigns a REVOKED row too, leaving it active on the gaining tenant", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: losingTenant, claim, createdBy: "signin", revokedAt: new Date() },
      });

      const result = await cmdAdd({
        tenant: gainingTenant,
        domain: claim,
        by: "test-op",
        from: losingTenant,
        yes: true,
      });

      expect(result.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(gainingTenant);
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
    });

    it.skipIf(SKIP)("does not move the row when the confirmation is declined", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

      const result = await cmdAdd({
        tenant: gainingTenant,
        domain: claim,
        by: "test-op",
        from: losingTenant,
        confirm: alwaysNo,
      });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.tenantId).toBe(losingTenant);

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
    });

    it.skipIf(SKIP)("refuses --from when no claim row exists at all", async () => {
      const tenantId = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({
        tenant: tenantId,
        domain: claim,
        by: "test-op",
        from: otherTenant,
        yes: true,
      });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row).toBeNull();

      await ctx.deleteTestData(tenantId);
      await ctx.deleteTestData(otherTenant);
    });
  });

  // Func F8 — the tenant whose backfill row `preflight` reports as skipped
  // has no claim row, so a claim-only resolver leaves it nameable by UUID
  // alone at incident time.
  describe("--tenant resolution", () => {
    it.skipIf(SKIP)("resolves a tenant by slug and by external_id, not only by UUID or a claim", async () => {
      const tenantId = await ctx.createTenant();
      const externalId = `${runToken()}-ext.${ALIAS_CLAIM}`;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET external_id = $2 WHERE id = $1::uuid`,
          tenantId,
          externalId,
        );
      });
      const tenant = await ctx.su.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

      // finally, as in the preflight test: external_id is globally visible.
      try {
        const bySlug = `${runToken()}.${ALIAS_CLAIM}`;
        const slugResult = await cmdAdd({ tenant: tenant.slug, domain: bySlug, by: "test-op", yes: true });
        expect(slugResult.ok).toBe(true);
        const slugRow = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: bySlug } });
        expect(slugRow?.tenantId).toBe(tenantId);

        const byExternal = `${runToken()}.${ALIAS_CLAIM}`;
        const externalResult = await cmdAdd({ tenant: externalId, domain: byExternal, by: "test-op", yes: true });
        expect(externalResult.ok).toBe(true);
        const externalRow = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: byExternal } });
        expect(externalRow?.tenantId).toBe(tenantId);
      } finally {
        await ctx.deleteTestData(tenantId);
      }
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
        // F9: `toBeTruthy()` held for every branch. These two tokens hold
        // only for the non-empty branch, and only for the window queried.
        expect(result.message).toContain(`in the last ${DEFAULT_UNMAPPED_WINDOW_DAYS} days`);
        expect(result.message).toContain("denial group(s)");

        // M10: neutralise the drainable row HERE, before deleteTestData.
        // The live audit-outbox-worker claims status='PENDING' rows and
        // inserts into audit_logs; audit_logs_tenant_id_fkey is RESTRICT, so
        // a claim landing between deleteTestData's audit_logs delete and its
        // tenants delete reds the cleanup. Setting the row non-claimable and
        // then deleting it closes the window rather than narrowing it. Both
        // statements are scoped to this test's own tenant — the dev DB is
        // shared.
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
              WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
            tenantId,
          );
          await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`, tenantId);
        });

        await ctx.deleteTestData(tenantId);
      },
    );

    it("formatUnmappedMessage names the window it queried when there are no rows (S12 — pure, no DB dependency)", () => {
      const message = formatUnmappedMessage([], 30);
      expect(message).toContain("No unmapped-claim denials in the last 30 days");
      expect(message).toContain("does NOT by itself mean nothing was denied");
      // Func F4: the empty message must not claim to have covered retention.
      expect(message).not.toContain("retained window");
    });

    it("formatUnmappedMessage summarises a non-empty result and names the requested window", () => {
      const message = formatUnmappedMessage(
        [{ tenant_id: randomUUID(), claim: "alias.example", cnt: 3, last_seen: new Date() }],
        90,
      );
      expect(message).toContain("1 unmapped-claim denial group(s) in the last 90 days");
      expect(message).not.toContain("No unmapped-claim denials");
    });

    it.skipIf(SKIP)("--days widens the query window and is reported in the message", async () => {
      const result = await cmdUnmapped({ days: 90 });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("in the last 90 days");
    });

    it.skipIf(SKIP)("rejects a --days value outside the accepted range without querying", async () => {
      const createSpy = vi.spyOn(migrationClientFactory, "create");
      try {
        const result = await cmdUnmapped({ days: 0 });
        expect(result.ok).toBe(false);
        expect(result.code).not.toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
      }
    });
  });

  describe("preflight", () => {
    // M8 / D-18: pre-flight is the dangerous command — it tells an operator
    // which rows the CHECK will reject BEFORE the migration runs, so a stale
    // or drifted query produces a confidently wrong "all clear". Asserting
    // only ok/code/typeof message let an inverted operator, a folded-instead
    // -of-raw column (the round-5 D3 error) or a dropped WHERE stay green,
    // because no row that must be reported was ever seeded. These rows are.
    it.skipIf(SKIP)("reports seeded collision and non-ASCII tenants by id", async () => {
      const token = runToken();
      const foldedClaim = `pf-${token}.${ALIAS_CLAIM}`;
      // Two RAW spellings that are distinct (UNIQUE(external_id) holds) but
      // fold to one claim. The whitespace on the second is deliberate: drop
      // `btrim` from the fold and these stop grouping, so the assertion
      // below reds.
      const collisionA = `PF-${token}.${ALIAS_CLAIM}`;
      const collisionB = `  pf-${token}.${ALIAS_CLAIM}  `;
      const nonAsciiExternalId = `pf-${token}-テスト.${ALIAS_CLAIM}`;

      const tenantA = await ctx.createTenant();
      const tenantB = await ctx.createTenant();
      const tenantC = await ctx.createTenant();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const [id, externalId] of [
          [tenantA, collisionA],
          [tenantB, collisionB],
          [tenantC, nonAsciiExternalId],
        ] as const) {
          await tx.$executeRawUnsafe(
            `UPDATE tenants SET external_id = $2 WHERE id = $1::uuid`,
            id,
            externalId,
          );
        }
      });

      // finally, not trailing cleanup: these rows are the only ones this
      // file writes that are visible to `preflight` GLOBALLY, so leaking
      // them on a failed assertion would leave every other working copy on
      // the shared dev DB reading a permanent collision report.
      try {
        const result = await cmdPreflight();

        expect(result.ok).toBe(true);
        expect(result.code).toBe(0);
        const rows = (result.rows ?? []) as Record<string, unknown>[];

        // `some`/`find` rather than length or index: the dev DB is shared and
        // globally may hold other collisions.
        const collision = rows.find((r) => r.normalized_claim === foldedClaim) as
          | { tenant_ids: string[] }
          | undefined;
        expect(collision).toBeDefined();
        expect(collision?.tenant_ids).toEqual(expect.arrayContaining([tenantA, tenantB]));

        expect(rows.some((r) => r.id === tenantC && r.external_id === nonAsciiExternalId)).toBe(true);
        // The printable-ASCII tenants must NOT appear in the non-ASCII list —
        // this is what pins query 2's WHERE clause rather than only its sign.
        expect(rows.some((r) => r.id === tenantA && typeof r.external_id === "string")).toBe(false);
        expect(rows.some((r) => r.id === tenantB && typeof r.external_id === "string")).toBe(false);

        expect(typeof result.message).toBe("string");
      } finally {
        await ctx.deleteTestData(tenantA);
        await ctx.deleteTestData(tenantB);
        await ctx.deleteTestData(tenantC);
      }
    });
  });

  describe("missing MIGRATION_DATABASE_URL", () => {
    // M11 / C7: "no connection attempted" was in the test name and in the
    // acceptance criterion but asserted nowhere — an implementation that
    // built the client first and checked the env afterwards passed every
    // assertion. The property is an ORDER of two statements, so it is
    // asserted at the seam: the client factory must never be called.
    it("every command fails closed with an actionable message before building a database client", async () => {
      // "" rather than `delete process.env.X` (F12): check-test-hygiene gate
      // (c) forbids direct process.env mutation in tests, and "" is falsy at
      // every read site in the CLI, so each command still takes the
      // missing-URL branch. Unstubbed by this file's afterEach.
      vi.stubEnv("MIGRATION_DATABASE_URL", "");
      const createSpy = vi.spyOn(migrationClientFactory, "create");
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
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
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
