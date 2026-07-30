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
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
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

/**
 * A row in `cmdUnmapped`'s shape. Round-4: `reason` became load-bearing (F3),
 * and hand-written literals had already drifted from the query's own select
 * list once — every field defaults here so a new column is added in one place.
 */
function unmappedRow(over: Partial<Parameters<typeof formatUnmappedMessage>[0][number]>) {
  return {
    tenant_id: randomUUID(),
    claim: "alias.example" as string | null,
    claim_refusal: null as string | null,
    reason: "tenant_claim_unmapped",
    cnt: 1,
    last_seen: new Date(),
    undelivered_cnt: 0,
    ...over,
  };
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

    // Round-4 T4. The `--by` reject guard and the eight escaped print sites
    // shipped with no test on either side — and the sweep that added them had
    // already missed one of its own sites (F4), which is exactly what an
    // untested guard hides.
    it.skipIf(SKIP)("refuses a --by label carrying a bidi control, before writing anything", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({
        tenant: tenantId,
        domain: claim,
        by: `ops${String.fromCodePoint(0x202e)}admin`,
        yes: true,
      });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.message).toContain("--by contains a control, bidi or zero-width character");
      // The mutation, not just the verdict (RT8): nothing was written.
      expect(await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } })).toBeNull();

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("accepts an ordinary --by label (the allow side of the same guard)", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });

      expect(result.ok).toBe(true);
      expect((await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } }))?.createdBy).toBe(
        "ops-oncall",
      );

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("escapes a poisoned createdBy everywhere it prints it", async () => {
      // Round-4 F4 + T4: `list` and `add`'s preview escape it; `add`'s
      // post-write line did not. A row written before the `--by` guard landed
      // — or by any other writer — can still carry U+202E, so the escape is
      // what stands between the operator and a reversed-looking attribution.
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const poisoned = `ops${String.fromCodePoint(0x202e)}admin`;
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId, claim, createdBy: poisoned, revokedAt: new Date() },
      });

      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await cmdList({ tenant: tenantId });
        // The un-revoke path, which is where the missed site lives.
        await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
      } finally {
        log.mockRestore();
      }

      const printed = lines.join("\n");
      expect(printed).toContain("ops<U+202E>admin");
      // Round-5 T9: the per-line loop this replaces was subsumed by the
      // assertion below AND filtered on `includes("admin")`, which misses the
      // truncated-label shape it advertised catching. Asserting the character
      // is absent from the WHOLE output is both stronger and honest about what
      // it checks.
      expect(printed).not.toContain(String.fromCodePoint(0x202e));

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

  describe("add — compare-and-swap on the confirmation window", () => {
    // The compare-and-swap in the `updateMany` WHERE is the security claim
    // M5 rests on: "a concurrent change is a refusal rather than a silent
    // overwrite". Nothing above reaches it — the wrong-owner cases exit at
    // the pre-check, hundreds of lines earlier — so the two cases below drive
    // the transaction to the write with the row changed underneath it.
    //
    // No sleep is involved and none is needed. The confirmation prompt runs
    // INSIDE the command's open transaction (D-14), so the `confirm` seam is
    // the window itself: by the time it is called the command has issued only
    // plain SELECTs (no FOR UPDATE), so it holds no lock on the claim row and
    // a write from a DIFFERENT client commits immediately. Under READ
    // COMMITTED the subsequent updateMany re-reads the new row version, its
    // re-asserted owner predicate no longer matches, and count is 0.
    it.skipIf(SKIP)(
      "reassignment: refuses without overwriting when the owner changes between the read and the write (CAS)",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const raceWinnerTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

        let raced = false;
        const confirmAfterConcurrentMove = async () => {
          await ctx.su.prisma.tenantClaim.update({
            where: { claim },
            data: { tenantId: raceWinnerTenant },
          });
          raced = true;
          return true;
        };

        try {
          const result = await cmdAdd({
            tenant: gainingTenant,
            domain: claim,
            by: "test-op",
            from: losingTenant,
            confirm: confirmAfterConcurrentMove,
          });

          // Anti-vacuity: a refusal that happened before the confirmation
          // would satisfy every assertion below without the CAS existing.
          expect(raced).toBe(true);
          expect(result.ok).toBe(false);
          expect(result.code).not.toBe(0);
          expect(result.message).toContain("was modified concurrently by another process");
          // "current owner" is the reassignment branch's wording; the
          // un-revoke branch says "current state". Pins WHICH CAS refused.
          expect(result.message).toContain("current owner");

          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          // The whole point: the row still belongs to the tenant that won the
          // race, not to the gaining tenant the operator was shown.
          expect(row?.tenantId).toBe(raceWinnerTenant);
        } finally {
          await ctx.deleteTestData(losingTenant);
          await ctx.deleteTestData(gainingTenant);
          await ctx.deleteTestData(raceWinnerTenant);
        }
      },
    );

    it.skipIf(SKIP)(
      "un-revoke: refuses without clearing revokedAt when the row is moved away between the read and the write (CAS)",
      async () => {
        // Same tenant on both sides (so this is the un-revoke branch, not a
        // reassignment) and a revoked row (so it is not the idempotent
        // no-write early return).
        const tenantId = await ctx.createTenant();
        const raceWinnerTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const revokedAt = new Date();
        await ctx.su.prisma.tenantClaim.create({
          data: { tenantId, claim, createdBy: "seed", revokedAt },
        });

        let raced = false;
        const confirmAfterConcurrentMove = async () => {
          await ctx.su.prisma.tenantClaim.update({
            where: { claim },
            data: { tenantId: raceWinnerTenant },
          });
          raced = true;
          return true;
        };

        try {
          const result = await cmdAdd({
            tenant: tenantId,
            domain: claim,
            by: "test-op",
            confirm: confirmAfterConcurrentMove,
          });

          expect(raced).toBe(true);
          expect(result.ok).toBe(false);
          expect(result.code).not.toBe(0);
          expect(result.message).toContain("was modified concurrently by another process");
          expect(result.message).toContain("current state");

          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          expect(row?.tenantId).toBe(raceWinnerTenant);
          // Un-revoking here would have handed an active claim to a tenant
          // the operator never named.
          expect(row?.revokedAt?.getTime()).toBe(revokedAt.getTime());
        } finally {
          await ctx.deleteTestData(tenantId);
          await ctx.deleteTestData(raceWinnerTenant);
        }
      },
    );
  });

  // Func F8 — the tenant whose backfill row `preflight` reports as skipped
  // has no claim row, so a claim-only resolver leaves it nameable by UUID
  // alone at incident time.
  describe("--tenant resolution", () => {
    it.skipIf(SKIP)("resolves a tenant by external_id, and refuses a slug (round-2 F-F)", async () => {
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
        // `tenants.slug` is NOT a resolution path: slugifyTenant collapses
        // [^a-z0-9]+, so the claim → slug mapping is many-to-one and one
        // squatted sign-in can pre-empt the slug an operator would later
        // type. --tenant names the GAINING side of a reassignment, so a
        // wrong resolution hands the claim away. Asserted here rather than
        // left to the resolver's comment, because the tenant below really
        // does have that slug — only the resolver refuses to look at it.
        const bySlug = `${runToken()}.${ALIAS_CLAIM}`;
        const slugResult = await cmdAdd({ tenant: tenant.slug, domain: bySlug, by: "test-op", yes: true });
        expect(slugResult.ok).toBe(false);
        // Round-3 T12: `ok === false` alone does not say the SLUG was refused
        // — a missing `--by`, a rejected `--domain`, or an unset
        // MIGRATION_DATABASE_URL all produce it, and each would keep this test
        // green with the slug path fully restored. The message pins that the
        // refusal is "this ref resolves to no tenant", naming the slug.
        expect(slugResult.message).toBe(`Tenant not found: ${tenant.slug}`);
        const slugRow = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: bySlug } });
        expect(slugRow).toBeNull();

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
        const otherTenantClaim = `${runToken()}.${ALIAS_CLAIM}`;
        const refusalDiagnosis = `refused: contains U+200B (${runToken()})`;

        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          // Present ONLY in audit_outbox — models a stopped outbox worker
          // (round-2 N14): the row never made it into audit_logs.
          //
          // `nextRetryAt` in the future is what makes that model hold against
          // a LIVE worker (round-3 M9). claimBatch selects
          // `status = 'PENDING' AND next_retry_at <= now()`, so a row dated
          // forward is structurally unclaimable — still PENDING, still absent
          // from audit_logs, which is exactly the state under test. The
          // previous fixture was claimable and relied on an after-the-fact
          // status re-read to notice, which turned one race (drained before
          // the query) into two (drained after it, reddening a run whose
          // query saw the right state).
          await tx.auditOutbox.create({
            data: {
              tenantId,
              status: AuditOutboxStatus.PENDING,
              nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
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
          // Round-5 T3: a REFUSED-at-ingest denial. Round-4's F3 widened the
          // query's reason predicate to catch this population and shipped
          // covered only by formatUnmappedMessage unit cases fed hand-written
          // rows — so reverting either UNION arm's predicate, or deleting the
          // second print group, left the whole integration file green. This
          // row is what makes the SQL itself load-bearing. It carries NO
          // claim, which is also what pins the widened NOT NULL filter.
          await tx.auditLog.create({
            data: {
              tenantId,
              scope: AuditScope.PERSONAL,
              action: AuditAction.AUTH_LOGIN_FAILURE,
              userId: randomUUID(),
              actorType: ActorType.SYSTEM,
              metadata: {
                reason: "tenant_mismatch",
                claimRefusal: refusalDiagnosis,
                provider: "google",
              },
            },
          });
          // And a row-7 style mismatch: a REAL claim registered to another
          // tenant. Round-5 F1/S3 — bucketing on `reason` swept this into the
          // "fix it at the IdP" heading, the opposite of its actual remedy.
          await tx.auditLog.create({
            data: {
              tenantId,
              scope: AuditScope.PERSONAL,
              action: AuditAction.AUTH_LOGIN_FAILURE,
              userId: randomUUID(),
              actorType: ActorType.SYSTEM,
              metadata: { reason: "tenant_mismatch", claim: otherTenantClaim, provider: "google" },
            },
          });
        });

        try {
          const result = await cmdUnmapped();

          // The outbox arm is only the outbox arm while the row is still
          // PENDING and absent from audit_logs: a drained row exists in BOTH
          // tables, so the assertion below would pass through the audit_logs
          // arm and deleting the audit_outbox half of the UNION would stay
          // green. The forward `nextRetryAt` above makes that unreachable
          // rather than merely detectable, so this assertion is a fixture
          // check — it cannot be reddened by worker timing (round-3 M9).
          const seeded = await ctx.su.prisma.auditOutbox.findFirst({
            where: { tenantId },
            select: { status: true },
          });
          expect(seeded?.status).toBe(AuditOutboxStatus.PENDING);

          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as {
            tenant_id: string;
            claim: string | null;
            claim_refusal: string | null;
            reason: string;
          }[];
          const mine = rows.filter((r) => r.tenant_id === tenantId);
          expect(mine.some((r) => r.claim === outboxOnlyClaim)).toBe(true);
          expect(mine.some((r) => r.claim === auditLogClaim)).toBe(true);

          // Round-5 T3 — the SQL, not the formatter. Each of these reds a
          // different mutation: the refusal row reds reverting either UNION
          // arm's reason predicate AND reds narrowing the NOT NULL filter back
          // to `claim IS NOT NULL`; the other-tenant row reds bucketing on
          // `reason` instead of on `claim_refusal`.
          const refusal = mine.find((r) => r.claim_refusal === refusalDiagnosis);
          expect(refusal, "the refused-at-ingest denial must be reported").toBeDefined();
          expect(refusal?.claim).toBeNull();
          expect(refusal?.reason).toBe("tenant_mismatch");

          const otherTenant = mine.find((r) => r.claim === otherTenantClaim);
          expect(otherTenant, "the other-tenant mismatch must be reported").toBeDefined();
          expect(otherTenant?.claim_refusal).toBeNull();
          expect(otherTenant?.reason).toBe("tenant_mismatch");

          // F9: `toBeTruthy()` held for every branch. These tokens hold only
          // for the non-empty branch, and only for the window queried.
          expect(result.message).toContain(`in the last ${DEFAULT_UNMAPPED_WINDOW_DAYS} days`);
          // All three counts, and the two new populations are non-zero — a
          // summary that merged them would not distinguish these numbers.
          expect(result.message).toMatch(/[1-9]\d* unmapped-claim, [1-9]\d* other-tenant and [1-9]\d* refused-claim/);
        } finally {
          // M10: neutralise the drainable row before deleteTestData — in a
          // `finally`, because a failing assertion above is exactly when the
          // PENDING row would otherwise be left behind for the live worker to
          // claim, i.e. the failure M10 fixed, relocated to the red path.
          // deleteTestData now drains the outbox before audit_logs for every
          // caller, so this is defence in depth for the one test that
          // deliberately manufactures a claimable row; both statements are
          // scoped to this test's own tenant — the dev DB is shared.
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
        }
      },
    );

    // Round-2 F-B end to end. The predicate is `status <> 'SENT'`, not
    // `status = 'PENDING'`: PROCESSING is a worker that crashed mid-claim and
    // FAILED is a row that exhausted its attempts, so both are in neither
    // audit_logs nor PENDING — invisible under the old predicate in exactly
    // the degraded-worker case the union exists for. Nothing else in this
    // suite drives those two statuses through cmdUnmapped, so narrowing the
    // predicate back would otherwise stay green.
    it.skipIf(SKIP)(
      "reports denials stuck in PROCESSING or terminal FAILED and counts them as undelivered, but not one still inside the worker's lease",
      async () => {
        const tenantId = await ctx.createTenant();
        const processingClaim = `${runToken()}.${ALIAS_CLAIM}`;
        const failedClaim = `${runToken()}.${ALIAS_CLAIM}`;
        const inFlightClaim = `${runToken()}.${ALIAS_CLAIM}`;

        const outboxPayload = (claim: string) => ({
          scope: AuditScope.PERSONAL,
          action: AuditAction.AUTH_LOGIN_FAILURE,
          userId: randomUUID(),
          actorType: ActorType.SYSTEM,
          serviceAccountId: null,
          teamId: null,
          targetType: null,
          targetId: null,
          metadata: { reason: "tenant_claim_unmapped", claim, provider: "google" },
          ip: null,
          userAgent: null,
        });

        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          // Round-3 T7: neither status is claimable by the live worker
          // (claimBatch selects `status = 'PENDING'`), which is WHY this
          // fixture is race-free — stated, because the previous version was
          // safe for that reason without saying so, and a later edit that
          // switched a status to PENDING would have re-armed the race
          // silently. The cleanup still sits in the `finally` below, for the
          // same reason the PENDING case does: a failing assertion must not
          // leave the rows behind.
          //
          // `processingStartedAt` is explicit on both PROCESSING rows, because
          // it is now the field that decides the outcome (round-3 M5). Leaving
          // it null would make the stuck row count as undelivered for the
          // wrong reason — the null fallback — and leave the lease boundary
          // itself untested.
          await tx.auditOutbox.create({
            data: {
              tenantId,
              status: AuditOutboxStatus.PROCESSING,
              // Older than the worker's own reap threshold: abandoned.
              processingStartedAt: new Date(
                Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000,
              ),
              payload: outboxPayload(processingClaim),
            },
          });
          await tx.auditOutbox.create({
            data: {
              tenantId,
              status: AuditOutboxStatus.PROCESSING,
              // Just claimed: a worker is delivering this right now. Reporting
              // it as degraded told an operator their audit pipeline was
              // broken while it was working normally.
              processingStartedAt: new Date(),
              payload: outboxPayload(inFlightClaim),
            },
          });
          await tx.auditOutbox.create({
            data: {
              tenantId,
              status: AuditOutboxStatus.FAILED,
              payload: outboxPayload(failedClaim),
            },
          });
        });

        try {
          const result = await cmdUnmapped();

          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as {
            tenant_id: string;
            claim: string;
            cnt: number;
            undelivered_cnt: number;
          }[];

          // Reported (the round-2 F-B property: the predicate is
          // `status <> 'SENT'`, so a non-PENDING row is still visible) AND
          // counted as undelivered (the operator-facing degradation signal).
          for (const [label, claim] of [
            ["stale PROCESSING", processingClaim],
            ["FAILED", failedClaim],
          ] as const) {
            const row = rows.find((r) => r.tenant_id === tenantId && r.claim === claim);
            expect(row, `${label} denial must be reported`).toBeDefined();
            expect(Number(row?.cnt), label).toBe(1);
            expect(Number(row?.undelivered_cnt), `${label} must count as undelivered`).toBe(1);
          }

          // Round-3 M5, the other side of the same boundary: an in-flight
          // PROCESSING row is still REPORTED — the denial happened and the
          // operator needs to see the claim — but must NOT count as
          // undelivered, or a healthy queue reads as a broken audit pipeline
          // in the middle of a lockout diagnosis. The two assertions together
          // are what distinguish "excluded from the report" (wrong) from
          // "reported, not degraded" (right).
          const inFlight = rows.find((r) => r.tenant_id === tenantId && r.claim === inFlightClaim);
          expect(inFlight, "in-flight denial must still be reported").toBeDefined();
          expect(Number(inFlight?.cnt)).toBe(1);
          expect(
            Number(inFlight?.undelivered_cnt),
            "a PROCESSING row inside the worker's lease is in flight, not stranded",
          ).toBe(0);

          expect(result.message).toContain("stranded in audit_outbox");
          // The lease seconds the report actually applied, named in the
          // message (round-4 F6) rather than described in the abstract.
          expect(result.message).toContain(
            `PROCESSING with no progress for ${Math.ceil(AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000)}s`,
          );
          expect(result.message).toContain("OUTBOX_PROCESSING_TIMEOUT_MS");
        } finally {
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
        }
      },
    );

    it("formatUnmappedMessage names the window it queried when there are no rows (S12 — pure, no DB dependency)", () => {
      const message = formatUnmappedMessage([], 30);
      expect(message).toContain("No claim-bearing sign-in denials");
      expect(message).toContain("in the last 30 days");
      expect(message).toContain("does NOT by itself mean nothing was denied");
      // Func F4: the empty message must not claim to have covered retention.
      expect(message).not.toContain("retained window");
    });

    it("formatUnmappedMessage summarises a non-empty result and names the requested window", () => {
      const message = formatUnmappedMessage([unmappedRow({ cnt: 3 })], 90);
      expect(message).toContain("1 unmapped-claim, 0 other-tenant and 0 refused-claim");
      expect(message).toContain("in the last 90 days");
      expect(message).not.toContain("No unmapped-claim denials");
      // Nothing undelivered — the degraded-delivery sentence must not appear,
      // or it would read as a standing warning on every healthy report.
      expect(message).not.toContain("audit_outbox");
    });

    // Round-4 F3: both populations are counted, always. A message that names
    // only the registrable one reads as "nothing else is wrong" — and the
    // refused-at-ingest population is a TOTAL lockout, so that reading is
    // exactly backwards.
    it("formatUnmappedMessage counts refused-at-ingest denials separately from unmapped ones", () => {
      const message = formatUnmappedMessage(
        [
          unmappedRow({ claim: "alias.example" }),
          // Refused-at-ingest: no claim, the diagnosis in its own column
          // (round-5 S2). Bucketed on the FIELD, so a claim whose text merely
          // looks like a diagnosis cannot join this population.
          unmappedRow({ claim: null, claim_refusal: "refused: contains U+200B", reason: "tenant_mismatch" }),
          unmappedRow({ claim: null, claim_refusal: "refused: 300 characters (max 255)", reason: "tenant_mismatch" }),
          // Row 7: a REAL claim registered to another tenant. Round-5 F1/S3 —
          // bucketing on `reason` swept this in with the refusals and printed
          // the opposite remedy.
          unmappedRow({ claim: "beta.example", reason: "tenant_mismatch" }),
          // And the forgery attempt: a claim whose text imitates a diagnosis
          // must count as an ordinary other-tenant mismatch, not a refusal.
          unmappedRow({ claim: "refused: contains U+200B", reason: "tenant_mismatch" }),
        ],
        30,
      );
      expect(message).toContain("1 unmapped-claim, 2 other-tenant and 2 refused-claim");
    });

    it("formatUnmappedMessage says zero refused groups rather than omitting the count", () => {
      const message = formatUnmappedMessage([unmappedRow({})], 30);
      expect(message).toContain("0 other-tenant and 0 refused-claim denial group(s)");
    });

    it("formatUnmappedMessage reports undelivered outbox events as degraded delivery", () => {
      const message = formatUnmappedMessage(
        [
          unmappedRow({ claim: "alias.example", cnt: 3, undelivered_cnt: 2 }),
          unmappedRow({ claim: "other.example", cnt: 1, undelivered_cnt: 1 }),
        ],
        30,
      );
      expect(message).toContain("2 unmapped-claim, 0 other-tenant and 0 refused-claim");
      expect(message).toContain("in the last 30 days");
      // Summed across groups, not per-row: the operator is being told how
      // many denial events will never reach audit_logs on their own.
      expect(message).toContain("3 of the denial event(s)");
      expect(message).toContain("stranded in audit_outbox");
      // Round-4 F6: the lease is this process's, and the message says so.
      expect(message).toContain("OUTBOX_PROCESSING_TIMEOUT_MS");
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

        // Round-3 T10: `typeof message === "string"` was the assertion here,
        // and it holds for every possible message including "0 collision(s),
        // 0 non-ASCII" — the exact output that would follow from the query
        // this test seeds rows for silently returning nothing. The summary
        // line is what an operator reads before deciding to migrate, so it
        // has to be pinned to a count that reflects the seeded rows.
        const summary = result.message ?? "";
        const collisionCount = Number(/^(\d+) collision\(s\)/.exec(summary)?.[1] ?? -1);
        const nonAsciiCount = Number(/(\d+) non-ASCII/.exec(summary)?.[1] ?? -1);
        expect(collisionCount).toBeGreaterThanOrEqual(1);
        expect(nonAsciiCount).toBeGreaterThanOrEqual(1);
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
