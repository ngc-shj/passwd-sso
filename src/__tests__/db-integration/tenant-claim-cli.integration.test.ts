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
  runToken,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import {
  cmdList,
  cmdUnmapped,
  cmdPreflight,
  cmdAdd,
  cmdRemove,
  cmdHistory,
  formatUnmappedMessage,
  migrationClientFactory,
  DEFAULT_UNMAPPED_WINDOW_DAYS,
} from "../../../scripts/tenant-domain";
import {
  TENANT_CLAIM_EVENT_OPERATION,
  SIGNIN_ACTOR_LABEL,
  DEREGISTER_ACTOR_LABEL,
} from "@/lib/tenant/tenant-claim-event";

const SKIP = !process.env.DATABASE_URL;

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

  /**
   * The live role name this connection authenticates as (VE5) — read fresh
   * each call rather than cached, and never a literal: MIGRATION_DATABASE_URL
   * names passwd_user locally and postgres in CI.
   */
  async function currentDbUser(): Promise<string> {
    const [row] = await ctx.su.prisma.$queryRaw<{ dbUser: string }[]>`SELECT current_user AS "dbUser"`;
    return row.dbUser;
  }

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

      const removed = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", yes: true });
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

    /**
     * Round-6, Codex. `add --from` overwrites `tenant_id` and clears
     * `revokedAt`, so after the move the row cannot tell an investigator who
     * owned the claim before or that it had been revoked — which falsifies SC8's
     * "the row itself carries the timeline" for exactly the two verbs that change
     * authentication routing. SC11 (this PR) closed that gap with the
     * append-only `tenant_claim_events` table, so the destroyed state is no
     * longer lost — it is queryable with `tenant-domain history`. The printed
     * line changed accordingly (C6): it used to claim the terminal output was
     * "NOT RECOVERABLE from the row after this change", which SC11 makes
     * false, and a false "this is the only copy" instruction is the wrong
     * remedy at incident time. It still has to name the destroyed values by
     * value, not merely allude to them, and it now points at `history`.
     */
    it.skipIf(SKIP)("names the state the move destroys, and points at history instead of claiming it is the only record", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const revokedAt = new Date("2026-07-01T00:00:00.000Z");
      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: losingTenant, claim, createdBy: "signin", revokedAt },
      });

      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        const result = await cmdAdd({
          tenant: gainingTenant,
          domain: claim,
          by: "test-op",
          from: losingTenant,
          confirm: alwaysYes,
        });
        expect(result.ok).toBe(true);
      } finally {
        log.mockRestore();
      }

      const printed = lines.join("\n");
      // C6: the old "NOT RECOVERABLE from the row after this change" wording
      // is false once SC11's history table exists, and must not reappear.
      expect(printed).not.toContain("NOT RECOVERABLE");
      // The wording names WHERE the record is, not "above" — what is above is a
      // command suggestion, not printed history (round-2 F4).
      expect(printed).toContain("Overwritten on this row (not lost — recorded in tenant_claim_events");
      expect(printed).toContain("tenant-domain history");
      expect(printed).toContain("tenant-domain history --domain");
      // Both destroyed values, by value — a message that merely says "see
      // history" without naming them is not itself a record of what changed.
      expect(printed).toContain(`previous owner tenant ${losingTenant}`);
      expect(printed).toContain(`revokedAt ${revokedAt.toISOString()}`);

      await ctx.deleteTestData(losingTenant);
      await ctx.deleteTestData(gainingTenant);
    });

    it.skipIf(SKIP)("does not claim anything was destroyed on a plain first registration", async () => {
      // The allow side: a create overwrites nothing, so the warning must not
      // fire — otherwise it becomes noise an operator learns to skip past.
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await cmdAdd({ tenant: tenantId, domain: claim, by: "test-op", yes: true });
      } finally {
        log.mockRestore();
      }
      expect(lines.join("\n")).not.toContain("NOT RECOVERABLE");

      await ctx.deleteTestData(tenantId);
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

    /**
     * Round-6, raised independently by Codex. The reassignment CAS re-asserted
     * `id` and `tenantId` but NOT `revokedAt` — the field the preview prints and
     * this write clears. So a concurrent `remove` landing while the operator
     * reads the (deliberately long) absorption warning was silently undone: the
     * move succeeded and set `revokedAt: null`, reversing another operator's
     * incident containment with no notice to either of them.
     *
     * The existing two cases above could not catch it: both race by changing the
     * OWNER, which the old predicate did cover. The class is "every field the
     * preview showed and the write changes must be in the WHERE", and only a
     * per-field case shows which fields were actually covered.
     */
    it.skipIf(SKIP)(
      "reassignment: refuses when a concurrent remove revokes the row between the read and the write (CAS on revokedAt)",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({
          data: { tenantId: losingTenant, claim, createdBy: "signin" },
        });

        let raced = false;
        const revokedAt = new Date();
        const confirmAfterConcurrentRevoke = async () => {
          // Exactly what `tenant-domain remove` does: soft delete, owner
          // unchanged. The owner predicate therefore still matches.
          await ctx.su.prisma.tenantClaim.update({ where: { claim }, data: { revokedAt } });
          raced = true;
          return true;
        };

        try {
          const result = await cmdAdd({
            tenant: gainingTenant,
            domain: claim,
            by: "test-op",
            from: losingTenant,
            confirm: confirmAfterConcurrentRevoke,
          });

          expect(raced).toBe(true);
          expect(result.ok).toBe(false);
          expect(result.code).not.toBe(0);
          expect(result.message).toContain("was modified concurrently by another process");

          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          // Neither half of the containment may be reversed: the claim stays
          // revoked AND stays with the tenant that owned it.
          expect(row?.revokedAt?.getTime()).toBe(revokedAt.getTime());
          expect(row?.tenantId).toBe(losingTenant);
        } finally {
          await ctx.deleteTestData(losingTenant);
          await ctx.deleteTestData(gainingTenant);
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
      // QA-5 / VE1: scoped to this test's own tenant, never a GLOBAL count —
      // the dev database is shared, and a concurrent run's own add/remove
      // would move the unscoped count for a reason unrelated to this test.
      const countBefore = await ctx.su.prisma.tenantClaim.count({ where: { tenantId } });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).not.toBeNull();
      const countAfter = await ctx.su.prisma.tenantClaim.count({ where: { tenantId } });
      expect(countAfter).toBe(countBefore);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("refuses when --tenant does not own the domain, row intact", async () => {
      const ownerTenant = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: ownerTenant, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: otherTenant, domain: claim, by: "test-op", yes: true });

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

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("an unresolvable --tenant is refused with no row changed", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: randomUUID(), domain: claim, by: "test-op", yes: true });

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

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", yes: true });
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

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", confirm: alwaysNo });

      expect(result.ok).toBe(false);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).toBeNull();

      await ctx.deleteTestData(tenantId);
    });
  });

  // C4 acceptance criteria: one case per member-set row that lives in this
  // CLI (register/revoke/unrevoke/reassign), the count===0 CAS and the
  // already-revoked idempotent early return writing no event, and both
  // halves of the `remove --by` guard (RT8/RT10).
  describe("tenant_claim_events (C4)", () => {
    it.skipIf(SKIP)("register (cmdAdd create arm): event matches C1's population table", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
      expect(result.ok).toBe(true);

      const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REGISTER);
      expect(event.oldTenantId).toBeNull();
      expect(event.newTenantId).toBe(tenantId);
      expect(event.oldRevokedAt).toBeNull();
      expect(event.newRevokedAt).toBeNull();
      expect(event.actorLabel).toBe("ops-oncall");
      // VE5: never a literal — passwd_user locally, postgres in CI.
      expect(event.dbUser).toBe(await currentDbUser());

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("revoke (cmdRemove): event matches C1's population table", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
      expect(result.ok).toBe(true);

      const claimRow = await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim } });
      const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REVOKE);
      expect(event.oldTenantId).toBe(tenantId);
      expect(event.newTenantId).toBe(tenantId);
      expect(event.oldRevokedAt).toBeNull();
      expect(event.newRevokedAt?.getTime()).toBe(claimRow.revokedAt?.getTime());
      expect(event.actorLabel).toBe("ops-oncall");
      expect(event.dbUser).toBe(await currentDbUser());

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)("unrevoke (cmdAdd un-revoke arm): event matches C1's population table", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      const revokedAt = new Date();
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed", revokedAt } });

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
      expect(result.ok).toBe(true);

      const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.UNREVOKE);
      expect(event.oldTenantId).toBe(tenantId);
      expect(event.newTenantId).toBe(tenantId);
      expect(event.oldRevokedAt?.getTime()).toBe(revokedAt.getTime());
      expect(event.newRevokedAt).toBeNull();
      expect(event.actorLabel).toBe("ops-oncall");
      expect(event.dbUser).toBe(await currentDbUser());

      await ctx.deleteTestData(tenantId);
    });

    it.skipIf(SKIP)(
      "reassign (cmdAdd --from) from an ACTIVE row: one event naming both tenants (F2)",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

        const result = await cmdAdd({
          tenant: gainingTenant,
          domain: claim,
          by: "ops-oncall",
          from: losingTenant,
          yes: true,
        });
        expect(result.ok).toBe(true);

        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REASSIGN);
        expect(event.oldTenantId).toBe(losingTenant);
        expect(event.newTenantId).toBe(gainingTenant);
        expect(event.oldRevokedAt).toBeNull();
        expect(event.newRevokedAt).toBeNull();
        expect(event.actorLabel).toBe("ops-oncall");
        expect(event.dbUser).toBe(await currentDbUser());

        await ctx.deleteTestData(losingTenant);
        await ctx.deleteTestData(gainingTenant);
      },
    );

    it.skipIf(SKIP)(
      "reassign (cmdAdd --from) against a REVOKED row: one reassign event, old_revoked_at non-NULL, new_revoked_at NULL",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const revokedAt = new Date();
        await ctx.su.prisma.tenantClaim.create({
          data: { tenantId: losingTenant, claim, createdBy: "signin", revokedAt },
        });

        const result = await cmdAdd({
          tenant: gainingTenant,
          domain: claim,
          by: "ops-oncall",
          from: losingTenant,
          yes: true,
        });
        expect(result.ok).toBe(true);

        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REASSIGN);
        expect(event.oldTenantId).toBe(losingTenant);
        expect(event.newTenantId).toBe(gainingTenant);
        expect(event.oldRevokedAt).not.toBeNull();
        expect(event.oldRevokedAt?.getTime()).toBe(revokedAt.getTime());
        expect(event.newRevokedAt).toBeNull();

        await ctx.deleteTestData(losingTenant);
        await ctx.deleteTestData(gainingTenant);
      },
    );

    it.skipIf(SKIP)("a CAS refusal (count === 0) writes no event", async () => {
      const losingTenant = await ctx.createTenant();
      const gainingTenant = await ctx.createTenant();
      const raceWinnerTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

      const confirmAfterConcurrentMove = async () => {
        await ctx.su.prisma.tenantClaim.update({ where: { claim }, data: { tenantId: raceWinnerTenant } });
        return true;
      };

      try {
        const result = await cmdAdd({
          tenant: gainingTenant,
          domain: claim,
          by: "ops-oncall",
          from: losingTenant,
          confirm: confirmAfterConcurrentMove,
        });
        expect(result.ok).toBe(false);
        // Pins WHICH refusal ran: an earlier denial (e.g. --from not
        // matching the owner) would also leave result.ok === false and
        // write no event, making "no event" trivially true without the CAS
        // arm ever firing. The three pre-existing CAS cases in this file
        // pin the arm the same way.
        expect(result.message).toContain("was modified concurrently by another process");

        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(0);
      } finally {
        await ctx.deleteTestData(losingTenant);
        await ctx.deleteTestData(gainingTenant);
        await ctx.deleteTestData(raceWinnerTenant);
      }
    });

    it.skipIf(SKIP)("remove's idempotent already-revoked early return writes no event", async () => {
      const tenantId = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      const revokedAt = new Date();
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed", revokedAt } });

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
      expect(result.ok).toBe(true);
      expect(result.message).toBe("already revoked (idempotent)");

      const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
      expect(events).toHaveLength(0);

      await ctx.deleteTestData(tenantId);
    });

    describe("remove --by guard (RT8/RT10)", () => {
      it.skipIf(SKIP)("allow side: remove --by ops succeeds and the event's actor_label is \"ops\"", async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${PRIMARY_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

        const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops", yes: true });
        expect(result.ok).toBe(true);

        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        expect(events[0].actorLabel).toBe("ops");

        await ctx.deleteTestData(tenantId);
      });

      it.skipIf(SKIP)(
        "deny side: an empty --by is refused, leaving the claim row unchanged and writing no event",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

          const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "", yes: true });
          expect(result.ok).toBe(false);
          expect(result.message).toContain("--by is required");

          // The mutation, not just the verdict (RT8).
          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          expect(row?.revokedAt).toBeNull();
          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(0);

          await ctx.deleteTestData(tenantId);
        },
      );

      it.skipIf(SKIP)(
        "deny side: a --by carrying a bidi control is refused, leaving the claim row unchanged and writing no event",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

          const result = await cmdRemove({
            tenant: tenantId,
            domain: claim,
            by: `ops${String.fromCodePoint(0x202e)}admin`,
            yes: true,
          });
          expect(result.ok).toBe(false);
          expect(result.message).toContain("--by contains a control, bidi or zero-width character");

          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          expect(row?.revokedAt).toBeNull();
          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(0);

          await ctx.deleteTestData(tenantId);
        },
      );

      // RT10/RT7: the third axis of validateActorLabel (length) had no test
      // on either side. The 255 case is deliberately the boundary-adjacent
      // allow, not another distant allow like "ops" above — a mis-typed
      // bound (e.g. `>=` instead of `>`) still admits "ops" but would wrongly
      // deny the nearest legitimate input, and this validator sits on the
      // lockout-recovery path where a false deny blocks remediation.
      it.skipIf(SKIP)(
        "deny side: a --by of 256 characters is refused, leaving the claim row unchanged and writing no event",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

          const result = await cmdRemove({
            tenant: tenantId,
            domain: claim,
            by: "a".repeat(256),
            yes: true,
          });
          expect(result.ok).toBe(false);
          expect(result.message).toContain("--by is too long");

          // The mutation, not just the verdict (RT8).
          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          expect(row?.revokedAt).toBeNull();
          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(0);

          await ctx.deleteTestData(tenantId);
        },
      );

      it.skipIf(SKIP)(
        "allow side: a --by of exactly 255 characters (the boundary) succeeds",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });
          const label = "a".repeat(255);

          const result = await cmdRemove({ tenant: tenantId, domain: claim, by: label, yes: true });
          expect(result.ok).toBe(true);

          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(1);
          expect(events[0].actorLabel).toBe(label);

          await ctx.deleteTestData(tenantId);
        },
      );

      // QA2-2: the remaining two axes of validateActorLabel — the reserved
      // label and the printable-ASCII narrowing that makes it meaningful —
      // had no test on either side, and both sit on the lockout-recovery
      // path (RT10's escalation condition) where a false deny blocks
      // remediation.
      it.skipIf(SKIP)(
        "deny side: --by equal to the reserved sign-in label, case/whitespace-insensitively, is refused, " +
          "leaving the claim row unchanged and writing no event",
        async () => {
          const tenantId = await ctx.createTenant();

          for (const label of ["signin", "SIGNIN", " signin "]) {
            const claim = `${runToken()}.${PRIMARY_CLAIM}`;
            await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

            const result = await cmdRemove({ tenant: tenantId, domain: claim, by: label, yes: true });
            expect(result.ok).toBe(false);
            expect(result.message).toContain(`--by must not be "${SIGNIN_ACTOR_LABEL}"`);

            const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
            expect(row?.revokedAt).toBeNull();
            const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
            expect(events).toHaveLength(0);
          }

          await ctx.deleteTestData(tenantId);
        },
      );

      // Boundary-adjacent allow: a label merely CONTAINING the reserved word
      // must still succeed. This is the false-deny an over-eager `includes()`
      // rewrite of the reserved-label check would introduce — without this
      // case nothing pins the difference from an exact-match comparison.
      it.skipIf(SKIP)(
        "allow side: a --by merely containing the reserved word (\"ops-signin\") succeeds " +
          "and the event's actor_label is \"ops-signin\"",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

          const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops-signin", yes: true });
          expect(result.ok).toBe(true);

          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(1);
          expect(events[0].actorLabel).toBe("ops-signin");

          await ctx.deleteTestData(tenantId);
        },
      );

      // The case that makes the reserved-label check above meaningful: a
      // Cyrillic confusable of "signin" (U+0455 "ѕ") renders identically in
      // `history` output but is refused earlier, by the printable-ASCII
      // narrowing, before it ever reaches the reserved-label comparison.
      it.skipIf(SKIP)(
        "deny side: a --by containing a Cyrillic look-alike of \"signin\" is refused as non-ASCII, " +
          "leaving the claim row unchanged and writing no event",
        async () => {
          const tenantId = await ctx.createTenant();
          const claim = `${runToken()}.${PRIMARY_CLAIM}`;
          await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

          const result = await cmdRemove({
            tenant: tenantId,
            domain: claim,
            by: `${String.fromCodePoint(0x0455)}ignin`,
            yes: true,
          });
          expect(result.ok).toBe(false);
          expect(result.message).toContain("--by must be printable ASCII");

          const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
          expect(row?.revokedAt).toBeNull();
          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(0);

          await ctx.deleteTestData(tenantId);
        },
      );
    });
  });

  // C6 acceptance criteria: the operator read path.
  describe("history (C6)", () => {
    it.skipIf(SKIP)("a claim with no events prints an explicit empty state, not an empty list", async () => {
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      const result = await cmdHistory({ domain: claim });

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(0);
      expect(result.message).toBe(`No routing history for claim "${claim}".`);
    });

    it.skipIf(SKIP)(
      "after a reassignment: one row naming both tenants, surviving a direct DELETE FROM tenants of the losing side (F3)",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

        try {
          const added = await cmdAdd({
            tenant: gainingTenant,
            domain: claim,
            by: "ops-oncall",
            from: losingTenant,
            yes: true,
          });
          expect(added.ok).toBe(true);

          const before = await cmdHistory({ domain: claim });
          expect(before.ok).toBe(true);
          const beforeRows = (before.rows ?? []) as {
            operation: string;
            oldTenantId: string | null;
            newTenantId: string | null;
          }[];
          expect(beforeRows).toHaveLength(1);
          expect(beforeRows[0].operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REASSIGN);
          expect(beforeRows[0].oldTenantId).toBe(losingTenant);
          expect(beforeRows[0].newTenantId).toBe(gainingTenant);

          // F3 / C1: deleted DIRECTLY, never through ctx.deleteTestData — by
          // the time cleanup runs it purges this claim's events first, which
          // would assert F3's negation rather than its proof.
          await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, losingTenant);
          });

          const after = await cmdHistory({ domain: claim });
          expect(after.ok).toBe(true);
          const afterRows = (after.rows ?? []) as {
            operation: string;
            oldTenantId: string | null;
            newTenantId: string | null;
          }[];
          expect(afterRows).toHaveLength(1);
          expect(afterRows[0].oldTenantId).toBe(losingTenant);
          expect(afterRows[0].newTenantId).toBe(gainingTenant);
        } finally {
          await ctx.deleteTestData(losingTenant);
          await ctx.deleteTestData(gainingTenant);
        }
      },
    );

    it.skipIf(SKIP)(
      "--tenant <uuid> for a tenant whose row no longer exists still returns its rows (the selector does not resolve through tenants)",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;

        try {
          const added = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
          expect(added.ok).toBe(true);

          await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
          });
          // Sanity: the tenant row really is gone, so a selector that resolved
          // through `tenants` (like `list`'s `--tenant`) would find nothing.
          expect(await ctx.su.prisma.tenant.findUnique({ where: { id: tenantId } })).toBeNull();

          const result = await cmdHistory({ tenant: tenantId });
          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as {
            operation: string;
            newTenantId: string | null;
            oldTenantId: string | null;
            actorLabel: string;
          }[];
          // TWO rows, and the second is the point: deleting the tenant cascades
          // its tenant_claims row away, and the BEFORE DELETE trigger records
          // that as `deregister`. Before that trigger existed this claim simply
          // stopped resolving with nothing to show for it — the gap the external
          // review named. So this case now pins both halves at once: the history
          // SURVIVES the tenant it names (the selector does not resolve through
          // `tenants`), and the routing END is itself recorded.
          expect(rows).toHaveLength(2);
          expect(rows[0].operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REGISTER);
          expect(rows[0].newTenantId).toBe(tenantId);
          expect(rows[1].operation).toBe(TENANT_CLAIM_EVENT_OPERATION.DEREGISTER);
          expect(rows[1].oldTenantId).toBe(tenantId);
          expect(rows[1].newTenantId).toBeNull();
          expect(rows[1].actorLabel).toBe(DEREGISTER_ACTOR_LABEL);
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    // QA-1: the case above only ever seeds a REGISTER row, whose
    // old_tenant_id is NULL — so it cannot exercise the `{ oldTenantId }`
    // half of cmdHistory's `OR: [{ oldTenantId }, { newTenantId }]`
    // predicate. Deleting that disjunct would leave this whole suite green
    // while falsifying user scenario 3: a tenant deleted after a claim was
    // moved OFF it.
    it.skipIf(SKIP)(
      "--tenant <uuid> for the LOSING side of a reassignment also returns the row (the oldTenantId disjunct)",
      async () => {
        const losingTenant = await ctx.createTenant();
        const gainingTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId: losingTenant, claim, createdBy: "signin" } });

        try {
          const added = await cmdAdd({
            tenant: gainingTenant,
            domain: claim,
            by: "ops-oncall",
            from: losingTenant,
            yes: true,
          });
          expect(added.ok).toBe(true);

          const result = await cmdHistory({ tenant: losingTenant });
          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as {
            operation: string;
            oldTenantId: string | null;
            newTenantId: string | null;
          }[];
          expect(rows).toHaveLength(1);
          expect(rows[0].operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REASSIGN);
          expect(rows[0].oldTenantId).toBe(losingTenant);
          expect(rows[0].newTenantId).toBe(gainingTenant);
        } finally {
          await ctx.deleteTestData(losingTenant);
          await ctx.deleteTestData(gainingTenant);
        }
      },
    );

    // QA-11: cmdHistory's non-UUID --tenant branch (resolveTenantRef fallback)
    // had no test at all — only the bare-UUID branch above was covered.
    it.skipIf(SKIP)(
      "a non-UUID --tenant falls back to resolveTenantRef and returns that tenant's history",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;

        try {
          const added = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-oncall", yes: true });
          expect(added.ok).toBe(true);

          // The claim string itself is a valid resolveTenantRef ref (the
          // same non-UUID path list/add/remove use) — unlike the bare-UUID
          // branch, which never calls resolveTenantRef at all (F3).
          const result = await cmdHistory({ tenant: claim });
          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as { operation: string; newTenantId: string | null }[];
          expect(rows).toHaveLength(1);
          expect(rows[0].operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REGISTER);
          expect(rows[0].newTenantId).toBe(tenantId);
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    it.skipIf(SKIP)(
      "a non-UUID --tenant that resolves to no tenant is refused with 'Tenant not found'",
      async () => {
        const ref = `no-such-tenant-${runToken()}`;
        const result = await cmdHistory({ tenant: ref });
        expect(result.ok).toBe(false);
        expect(result.code).not.toBe(0);
        expect(result.message).toBe(`Tenant not found: ${ref}`);
      },
    );

    it.skipIf(SKIP)(
      "--domain and --tenant together are REFUSED, before either selector is applied",
      async () => {
        const tenantA = await ctx.createTenant();
        const tenantB = await ctx.createTenant();
        const claimA = `${runToken()}.${ALIAS_CLAIM}`;
        const claimB = `${runToken()}.${PRIMARY_CLAIM}`;

        try {
          expect((await cmdAdd({ tenant: tenantA, domain: claimA, by: "ops-oncall", yes: true })).ok).toBe(true);
          expect((await cmdAdd({ tenant: tenantB, domain: claimB, by: "ops-oncall", yes: true })).ok).toBe(true);

          // Both selectors name something that EXISTS and each would return a
          // different, non-empty answer — so a refusal here cannot be mistaken
          // for "nothing matched", and the case still proves the refusal
          // happens before either selector is applied.
          const result = await cmdHistory({ domain: claimA, tenant: tenantB });
          expect(result.ok).toBe(false);
          expect(result.code).not.toBe(0);
          expect(result.message).toContain("not both");
          expect(result.rows ?? []).toHaveLength(0);
        } finally {
          await ctx.deleteTestData(tenantA);
          await ctx.deleteTestData(tenantB);
        }
      },
    );

    it.skipIf(SKIP)("refuses cleanly when neither --domain nor --tenant is given", async () => {
      const result = await cmdHistory({});

      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.message).toContain("--domain");
      expect(result.message).toContain("--tenant");
    });

    it.skipIf(SKIP)(
      "no printed history line carries a raw unsafe character when a stored actor_label contains one (sweeps every printed line, not one site)",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const poisoned = `ops${String.fromCodePoint(0x202e)}admin`;

        // Direct INSERT, not the CLI: validateActorLabel rejects an unsafe
        // --by at ingest, so this seeds the shape only a row predating this
        // PR's ingest boundary can carry.
        await ctx.su.prisma.$executeRawUnsafe(
          `INSERT INTO tenant_claim_events
             (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
           VALUES ($1::uuid, $2, 'register', NULL, $3::uuid, NULL, NULL, $4)`,
          randomUUID(),
          claim,
          tenantId,
          poisoned,
        );

        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
        try {
          const result = await cmdHistory({ domain: claim });
          expect(result.ok).toBe(true);
        } finally {
          log.mockRestore();
        }

        const printed = lines.join("\n");
        expect(printed).toContain("ops<U+202E>admin");
        // Swept over the WHOLE output, not one `includes()` check per known
        // print site — the assertion this criterion exists for is the one
        // that catches a missed site among several.
        expect(printed).not.toContain(String.fromCodePoint(0x202e));

        await ctx.deleteTestData(tenantId);
      },
    );

    // External review finding 4 (LOW): created_at is TIMESTAMPTZ(3), and
    // consecutive clock_timestamp() reads have been observed identical at
    // that resolution — same-millisecond writes have no defined order under
    // it. `seq` (20260731170000, GENERATED ALWAYS AS IDENTITY) is what
    // cmdHistory now orders by instead.
    //
    // A literal created_at collision cannot be forced deterministically —
    // the BEFORE INSERT trigger always overwrites whatever timestamp a
    // caller supplies (I2), and clock_timestamp() is real wall-clock time —
    // so this does not assert the two rows' created_at values are equal
    // (that would make the case flaky on a host whose clock resolution
    // happens to be finer). What IS asserted, and what the fix actually
    // guarantees regardless of whether the millisecond collides: a single
    // multi-row INSERT statement — the closest reproducible proxy for "the
    // same instant" — comes back from `history` in the literal VALUES order,
    // driven by `seq`, never by a `created_at` tie-break that has no defined
    // winner.
    it.skipIf(SKIP)(
      "two events inserted in the same statement come back in insertion order (seq, not created_at)",
      async () => {
        const tenantA = await ctx.createTenant();
        const tenantB = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;

        try {
          await ctx.su.prisma.$executeRawUnsafe(
            `INSERT INTO tenant_claim_events
               (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
             VALUES
               ($1::uuid, $4, 'register', NULL, $2::uuid, NULL, NULL, 'ordering-test-first'),
               ($5::uuid, $4, 'register', NULL, $3::uuid, NULL, NULL, 'ordering-test-second')`,
            randomUUID(),
            tenantA,
            tenantB,
            claim,
            randomUUID(),
          );

          const result = await cmdHistory({ domain: claim });
          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as { actorLabel: string; seq: bigint; newTenantId: string | null }[];
          expect(rows).toHaveLength(2);
          expect(rows.map((r) => r.actorLabel)).toEqual([
            "ordering-test-first",
            "ordering-test-second",
          ]);
          expect(rows[0].newTenantId).toBe(tenantA);
          expect(rows[1].newTenantId).toBe(tenantB);
          // Anti-vacuity (RT4-shaped): the two seq values really are
          // adjacent, i.e. this asserted an actual insertion-order pair, not
          // two rows that happened to sort the way the fixture already
          // wrote them.
          expect(rows[1].seq - rows[0].seq).toBe(1n);
        } finally {
          await ctx.deleteTestData(tenantA);
          await ctx.deleteTestData(tenantB);
        }
      },
    );

    // C6 / external review finding 3: the row cap and its continuation
    // cursor. `rowCap` is the test seam cmdHistory exports for exactly this
    // — red-proving the truncation path without inserting
    // HISTORY_ROW_CAP+1 real rows on the shared dev database.
    it.skipIf(SKIP)(
      "a capped result prints how to continue, and --after continues from where it stopped",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;

        try {
          // Three genuine, distinct events on one claim/tenant pair —
          // register, revoke, un-revoke — cheaper than inserting rows
          // directly and exercising the real writers `cmdAdd`/`cmdRemove`
          // use in production.
          expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-1", yes: true })).ok).toBe(true);
          expect((await cmdRemove({ tenant: tenantId, domain: claim, by: "ops-2", yes: true })).ok).toBe(true);
          expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops-3", yes: true })).ok).toBe(true);

          const allEvents = await cmdHistory({ domain: claim });
          expect(allEvents.ok).toBe(true);
          const allRows = (allEvents.rows ?? []) as { seq: bigint }[];
          expect(allRows.length).toBeGreaterThanOrEqual(3);

          const page1 = await cmdHistory({ domain: claim, rowCap: 2 });
          expect(page1.ok).toBe(true);
          const page1Rows = (page1.rows ?? []) as { seq: bigint }[];
          expect(page1Rows).toHaveLength(2);
          expect(page1.message).toContain("capped at 2");
          expect(page1.message).toContain("continuation hint");

          const cursor = page1Rows[1].seq.toString();
          const page2 = await cmdHistory({ domain: claim, rowCap: 2, after: cursor });
          expect(page2.ok).toBe(true);
          const page2Rows = (page2.rows ?? []) as { seq: bigint }[];
          // Every row on page 2 continues strictly after the cursor, and the
          // two pages together are exactly the full result — the cursor
          // neither drops nor repeats a row at the boundary.
          for (const row of page2Rows) {
            expect(row.seq > page1Rows[1].seq).toBe(true);
          }
          expect(page1Rows.length + page2Rows.length).toBe(allRows.length);
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    it.skipIf(SKIP)("a non-digit --after is refused before any query runs", async () => {
      const result = await cmdHistory({ tenant: randomUUID(), after: "not-a-number" });
      expect(result.ok).toBe(false);
      expect(result.code).not.toBe(0);
      expect(result.message).toContain("--after");
    });

    // External review, second round (MEDIUM): the continuation hint used to be
    // a ready-to-paste `tenant-domain history --domain <claim> --after <seq>`.
    // A claim is printable ASCII by CHECK constraint — `;`, `$(…)` and
    // backticks are all admissible — and `escapeUnsafeDisplayChars` neutralises
    // terminal control sequences, not shell metacharacters. So the tool was
    // building a command line out of attacker-influenceable text and offering
    // it to an operator mid-incident.
    it.skipIf(SKIP)(
      "the continuation hint does not put the claim into command position",
      async () => {
        const tenantId = await ctx.createTenant();
        // Direct INSERT, not cmdAdd: operatorDomainSchema refuses this shape at
        // ingest. The claim below is what the sign-in auto-registration path's
        // looser storableClaimSchema, and the table's own CHECK, still admit —
        // lowercase, trimmed, non-empty, printable ASCII.
        const claim = `a;whoami$(id)\`id\`.example`;
        const events = ["ops-1", "ops-2", "ops-3"];

        try {
          for (const label of events) {
            await ctx.su.prisma.$executeRawUnsafe(
              `INSERT INTO tenant_claim_events
                 (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
               VALUES ($1::uuid, $2, 'register', NULL, $3::uuid, NULL, NULL, $4)`,
              randomUUID(),
              claim,
              tenantId,
              label,
            );
          }

          const lines: string[] = [];
          const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(" "));
          });
          let result;
          try {
            result = await cmdHistory({ domain: claim, rowCap: 2 });
          } finally {
            log.mockRestore();
          }
          expect(result.ok).toBe(true);

          // Split on newlines: the truncation notice is one console.log
          // carrying two lines, and the LINE is the unit an operator selects
          // and copies. Asserting over the whole call would conflate the
          // descriptive line (which names the claim, escaped, as every other
          // display line does) with the copyable one.
          //
          // Anti-vacuity: the truncation path really ran, so the assertions
          // below are about a hint that exists rather than about its absence.
          const hint = lines.flatMap((l) => l.split("\n")).find((l) => l.includes("--after"));
          expect(hint, "the capped result must print a continuation hint").toBeDefined();
          expect(hint).toMatch(/--after \d+/);

          // The claim does not appear in the hint at all — neither raw nor in
          // the escaped display form. Substring checks on the metacharacters
          // alone would pass a hint that carried the claim with the ONE
          // character this fixture happens to use stripped.
          expect(hint).not.toContain(claim);
          expect(hint).not.toContain("whoami");
          expect(hint).not.toContain("$(");
          expect(hint).not.toContain(";");
          expect(hint).not.toContain("--domain");
          expect(hint).not.toContain("--tenant");
        } finally {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    // The tenant selector is two indexed queries merged in the CLI rather than
    // one `OR` (20260731190000). The merge has to be exact, so the case that
    // matters is a row naming the SAME tenant on both sides — it comes back
    // from both queries and must appear once.
    it.skipIf(SKIP)(
      "--tenant merges the old-side and new-side queries without duplicating or dropping a row",
      async () => {
        const tenantId = await ctx.createTenant();
        const otherTenant = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;

        try {
          // both sides FIRST, then new-side only, then old-side only. The order
          // is load-bearing, not cosmetic: with the both-sides row seeded
          // second, a merge that had lost its de-duplication still produced two
          // DISTINCT rows under `rowCap: 2` — the duplicate fell off the end of
          // the cap — so the capped assertion below passed against exactly the
          // defect it names. Seeded first, the duplicate lands inside the cap.
          const seeds = [
            ["both-sides", tenantId, tenantId],
            ["new-side-only", null, tenantId],
            ["old-side-only", tenantId, otherTenant],
          ] as const;
          for (const [label, oldTenant, newTenant] of seeds) {
            await ctx.su.prisma.$executeRawUnsafe(
              `INSERT INTO tenant_claim_events
                 (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
               VALUES ($1::uuid, $2, 'reassign', $3::uuid, $4::uuid, NULL, NULL, $5)`,
              randomUUID(),
              claim,
              oldTenant,
              newTenant,
              label,
            );
          }

          const result = await cmdHistory({ tenant: tenantId });
          expect(result.ok).toBe(true);
          const rows = (result.rows ?? []) as { actorLabel: string; seq: bigint }[];
          const mine = rows.filter((r) => seeds.some(([label]) => label === r.actorLabel));
          expect(mine.map((r) => r.actorLabel)).toEqual([
            "both-sides",
            "new-side-only",
            "old-side-only",
          ]);
          // Strictly increasing seq across the merged result, not merely the
          // right set: the merge sorts rows that arrived from two separately
          // ordered queries.
          for (let i = 1; i < mine.length; i++) {
            expect(mine[i].seq > mine[i - 1].seq).toBe(true);
          }

          // The cap applies to the MERGED result, not per side: a row that
          // arrives from both queries must not consume two of the two slots.
          const capped = await cmdHistory({ tenant: tenantId, rowCap: 2 });
          expect(capped.ok).toBe(true);
          const cappedRows = (capped.rows ?? []) as { seq: bigint }[];
          expect(cappedRows).toHaveLength(2);
          expect(new Set(cappedRows.map((r) => r.seq.toString())).size).toBe(2);
          // Truncation is reported. `cmdHistory` returns no `truncated` field,
          // so `message` is the ONLY channel it is observable through — without
          // this, a per-side fetch that dropped the `+1` probe row returns the
          // same two rows and says "2 event(s) listed", and an incident
          // responder reads a truncated routing history as the whole of it.
          expect(capped.message).toContain("capped at 2");
        } finally {
          await ctx.deleteTestData(tenantId);
          await ctx.deleteTestData(otherTenant);
        }
      },
    );

    // `--after` is spread into BOTH per-side queries independently
    // (20260731190000), which makes losing it from one of them the most
    // natural way for a later refactor to break paging — and the domain
    // selector's pagination case cannot see it, because that path issues one
    // query. Symptom if the new-side filter were dropped: page 2 re-includes
    // rows page 1 already returned, `lastSeq` can move BACKWARDS relative to
    // the cursor the operator just used, and the documented continue-loop never
    // terminates while the tail of the history stays unreachable.
    it.skipIf(SKIP)("--tenant paginates with --after across both sides", async () => {
      const tenantId = await ctx.createTenant();
      const otherTenant = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      try {
        // Alternating sides, so any page that spans the boundary contains rows
        // that came from different queries.
        const seeds = [
          ["p-old-1", tenantId, otherTenant],
          ["p-new-1", otherTenant, tenantId],
          ["p-both", tenantId, tenantId],
          ["p-old-2", tenantId, otherTenant],
          ["p-new-2", otherTenant, tenantId],
        ] as const;
        for (const [label, oldTenant, newTenant] of seeds) {
          await ctx.su.prisma.$executeRawUnsafe(
            `INSERT INTO tenant_claim_events
               (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
             VALUES ($1::uuid, $2, 'reassign', $3::uuid, $4::uuid, NULL, NULL, $5)`,
            randomUUID(),
            claim,
            oldTenant,
            newTenant,
            label,
          );
        }

        const all = await cmdHistory({ tenant: tenantId });
        expect(all.ok).toBe(true);
        const allRows = (all.rows ?? []) as { seq: bigint }[];
        expect(allRows).toHaveLength(seeds.length);

        const page1 = await cmdHistory({ tenant: tenantId, rowCap: 2 });
        const page1Rows = (page1.rows ?? []) as { seq: bigint }[];
        expect(page1Rows).toHaveLength(2);
        expect(page1.message).toContain("capped at 2");

        const cursor = page1Rows[1].seq;
        const page2Lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
          page2Lines.push(args.map(String).join(" "));
        });
        let page2;
        try {
          page2 = await cmdHistory({
            tenant: tenantId,
            rowCap: 2,
            after: cursor.toString(),
          });
        } finally {
          log.mockRestore();
        }
        const page2Rows = (page2.rows ?? []) as { seq: bigint }[];

        // The hint on a page that ALREADY carries `--after` must not say
        // "appended": `parseFlags` refuses a repeated flag outright, so an
        // operator following that literally gets exit 1 and no rows, on the
        // incident read path, from page 3 onwards. Asserted here because this
        // is the only pagination case that reaches a second truncated page.
        expect(page2.message).toContain("capped at 2");
        const hint = page2Lines.flatMap((l) => l.split("\n")).find((l) => l.includes("--after"));
        expect(hint, "a truncated page must print a continuation hint").toBeDefined();
        expect(hint).toContain("in place of the --after already on it");
        expect(hint).not.toContain("appended");
        // Strictly after the cursor — the assertion that reds if either side
        // lost the filter, because the unfiltered side would return its own
        // first rows again, all of them at or below the cursor.
        for (const row of page2Rows) {
          expect(row.seq > cursor).toBe(true);
        }

        const page3 = await cmdHistory({
          tenant: tenantId,
          rowCap: 2,
          after: page2Rows[page2Rows.length - 1].seq.toString(),
        });
        const page3Rows = (page3.rows ?? []) as { seq: bigint }[];

        // The three pages partition the full result: no row dropped at a
        // boundary, none returned twice.
        const paged = [...page1Rows, ...page2Rows, ...page3Rows].map((r) => r.seq.toString());
        expect(new Set(paged).size).toBe(paged.length);
        expect(paged.sort()).toEqual(allRows.map((r) => r.seq.toString()).sort());

        // The last page is not truncated — the boundary the `+1` probe row
        // exists to get right, and the direction the capped cases above cannot
        // check.
        expect(page3.message).not.toContain("capped at");
      } finally {
        await ctx.deleteTestData(tenantId);
        await ctx.deleteTestData(otherTenant);
      }
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
        const outboxRefusalDiagnosis = `refused: contains U+202E (${runToken()})`;
        const unstorableClaim = `${runToken()}.${ALIAS_CLAIM}`;

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
          // Round-6 T2. The refusal row above is seeded ONLY in `audit_logs`,
          // so round 5's claim to have red-proved BOTH reason predicates was
          // false for the OUTBOX arm: every outbox row it seeded already used
          // `tenant_claim_unmapped`, so reverting
          // `payload->'metadata'->>'reason' IN (…)` back to `= 'tenant_claim_unmapped'`
          // left the file 39/39 green. The outbox arm is the one that matters
          // most — a stopped or degraded worker is the scenario this whole union
          // exists for, and it is the scenario an operator is in when they reach
          // for this tool.
          //
          // Structurally unclaimable for the same reason as the row above
          // (`nextRetryAt` an hour ahead vs claimBatch's `next_retry_at <= now()`).
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
                metadata: {
                  reason: "tenant_mismatch",
                  claimRefusal: outboxRefusalDiagnosis,
                  provider: "google",
                },
                ip: null,
                userAgent: null,
              },
            },
          });
          // Round-6 F1's population: a claim that PASSES ingest and fails
          // `storableClaimSchema`. It carries BOTH fields — the value the IdP
          // asserted and the rule it broke — which is the shape that used to be
          // indistinguishable from the row-7 row above and was therefore printed
          // under "move it with `add --from`".
          await tx.auditLog.create({
            data: {
              tenantId,
              scope: AuditScope.PERSONAL,
              action: AuditAction.AUTH_LOGIN_FAILURE,
              userId: randomUUID(),
              actorType: ActorType.SYSTEM,
              metadata: {
                reason: "tenant_mismatch",
                claim: unstorableClaim,
                claimRefusal: "refused: claim must be printable ASCII",
                provider: "google",
              },
            },
          });
        });

        const printed: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
          printed.push(args.map(String).join(" "));
        });
        try {
          const result = await cmdUnmapped();
          log.mockRestore();

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

          // Round-6 T2: the OUTBOX arm's reason predicate. Every outbox row the
          // round-5 fixture seeded already carried `tenant_claim_unmapped`, so
          // reverting `payload->'metadata'->>'reason' IN (…)` to
          // `= 'tenant_claim_unmapped'` stayed green — and that arm is the
          // stopped-worker case the union exists for.
          const outboxRefusal = mine.find((r) => r.claim_refusal === outboxRefusalDiagnosis);
          expect(
            outboxRefusal,
            "a refused-at-ingest denial present ONLY in audit_outbox must be reported",
          ).toBeDefined();
          expect(outboxRefusal?.claim).toBeNull();

          // Round-6 F1: a claim that passes ingest and cannot be STORED carries
          // both fields, and must not be reported as an other-tenant mismatch.
          const unstorable = mine.find((r) => r.claim === unstorableClaim);
          expect(unstorable, "the unstorable-claim denial must be reported").toBeDefined();
          expect(unstorable?.claim_refusal).toBe("refused: claim must be printable ASCII");

          // F9: `toBeTruthy()` held for every branch. These tokens hold only
          // for the non-empty branch, and only for the window queried.
          expect(result.message).toContain(`in the last ${DEFAULT_UNMAPPED_WINDOW_DAYS} days`);
          // All three counts, and the two new populations are non-zero — a
          // summary that merged them would not distinguish these numbers.
          expect(result.message).toMatch(/[1-9]\d* unmapped-claim, [1-9]\d* other-tenant and [1-9]\d* refused-claim/);

          // ─── Round-6 T3: the print GROUPS ────────────────────────────────
          //
          // The three `printGroup` calls had no test at all: deleting the
          // `other_tenant` group and letting `refused` take its heading — i.e.
          // reproducing round-5 F1/S3 exactly, the finding those headings exist
          // to answer — left this file 39/39 green. The assertion has to be that
          // each row appears UNDER ITS OWN heading, which is a property of the
          // output's structure, not of any single line.
          const headingIndex = (needle: string) => printed.findIndex((l) => l.includes(needle));
          const rowIndex = (needle: string) => printed.findIndex((l) => l.includes(needle));
          const unregisteredHeading = headingIndex("Unregistered claims");
          const otherTenantHeading = headingIndex("registered to a DIFFERENT tenant");
          const refusedHeading = headingIndex("REFUSED");
          expect(unregisteredHeading).toBeGreaterThanOrEqual(0);
          expect(otherTenantHeading).toBeGreaterThanOrEqual(0);
          expect(refusedHeading).toBeGreaterThanOrEqual(0);

          // Each row falls under the LAST heading printed before it. Computed
          // rather than asserted per-pair, so a fourth heading or a reordering
          // cannot make this pass by coincidence.
          const headings = [
            { at: unregisteredHeading, name: "unregistered" },
            { at: otherTenantHeading, name: "other_tenant" },
            { at: refusedHeading, name: "refused" },
          ];
          const bucketOfPrintedRow = (needle: string): string | null => {
            const at = rowIndex(needle);
            expect(at, `printed line for ${needle}`).toBeGreaterThanOrEqual(0);
            const owner = headings
              .filter((h) => h.at < at)
              .sort((a, b) => b.at - a.at)[0];
            return owner?.name ?? null;
          };
          expect(bucketOfPrintedRow(outboxOnlyClaim)).toBe("unregistered");
          expect(bucketOfPrintedRow(auditLogClaim)).toBe("unregistered");
          expect(bucketOfPrintedRow(otherTenantClaim)).toBe("other_tenant");
          expect(bucketOfPrintedRow(refusalDiagnosis)).toBe("refused");
          expect(bucketOfPrintedRow(outboxRefusalDiagnosis)).toBe("refused");
          // The one round-6 F1 exists for: it carries a claim, so before the
          // diagnosis was produced it was indistinguishable from the row-7 row
          // and printed under "move it with `add --from`".
          expect(bucketOfPrintedRow(unstorableClaim)).toBe("refused");
          // And its printed line shows BOTH fields — the operator needs the
          // value to know which population is affected, and the rule to know
          // that `add` cannot help.
          expect(printed[rowIndex(unstorableClaim)]).toContain(
            'refusal="refused: claim must be printable ASCII"',
          );
        } finally {
          log.mockRestore();
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
          cmdRemove({ tenant: "acmecorp", domain: `${runToken()}.example`, by: "test-op", yes: true }),
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

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "test-op", yes: true });

      expect(result.ok).toBe(true);
      const row = await ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
      expect(row?.revokedAt).not.toBeNull();

      await ctx.deleteTestData(tenantId);
    });
  });
});
