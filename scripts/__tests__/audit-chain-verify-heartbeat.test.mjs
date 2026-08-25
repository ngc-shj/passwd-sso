/**
 * The heartbeat is the only signal an operator has that the chain verifier is
 * doing its job — `docs/operations/alerts.md` alarms on its ABSENCE for 2h.
 * That makes emitting it after a tick that verified nothing the worst
 * available failure: it converts a dead control into a green one.
 *
 * These cases pin the suppression in both directions. Asserting only "an error
 * was logged" would pass while the heartbeat still fired, which is precisely
 * the state this guard exists to prevent, so every case asserts on the
 * heartbeat line itself.
 *
 * No DB: runTick is driven with a stub client whose $transaction throws for a
 * chosen tenant, which is how a missing RLS context surfaces after the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTick } from "../audit-chain-verify-worker.ts";

const HEARTBEAT = "audit-chain-verify-heartbeat";

/**
 * @param tenantIds tenants the tick should walk
 * @param failFor   tenant ids whose verify should throw
 */
function makeStubPrisma(tenantIds, failFor = []) {
  return {
    tenant: {
      findMany: async () => tenantIds.map((id) => ({ id })),
    },
    // verifyTenantChain wraps its reads in withTenantRls, which opens a
    // transaction — so failing here is exactly how a broken RLS context
    // reaches runTick.
    $transaction: async (fn) => {
      const tx = {
        $executeRaw: async () => 0,
        $queryRawUnsafe: async (sql) => {
          // withTenantRls sets the GUC through $executeRaw; the first read in
          // verifyTenantChain is the precondition assertion.
          if (String(sql).includes("current_setting")) {
            return [{ tenant_id: currentTenantId }];
          }
          // No anchor, no chained rows -> a legitimately empty, healthy chain.
          return [];
        },
      };
      if (failFor.includes(currentTenantId)) {
        throw new Error(
          `RLS_CONTEXT_MISSING: app.tenant_id is null, expected ${currentTenantId}`,
        );
      }
      return fn(tx);
    },
  };
}

// withTenantRls receives the tenant id, but the stub's $transaction does not;
// runTick walks tenants serially, so tracking the current one is sufficient.
let currentTenantId = null;

/** Advance `currentTenantId` in walk order as each transaction opens. */
function trackTenantOrder(prisma, order) {
  let i = 0;
  const orig = prisma.$transaction;
  prisma.$transaction = async (fn) => {
    currentTenantId = order[i++];
    return orig(fn);
  };
}

describe("audit-chain-verify heartbeat suppression", () => {
  let logLines;
  let errLines;

  beforeEach(() => {
    logLines = [];
    errLines = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logLines.push(a.map(String).join(" "));
    });
    // Raw args, not a joined string: console.error applies printf
    // formatting, so a joined spy leaves %d uninterpolated and an assertion
    // written against the formatted text would never match.
    vi.spyOn(console, "error").mockImplementation((...a) => {
      errLines.push(a);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    currentTenantId = null;
  });

  it("emits the heartbeat when every tenant verified", async () => {
    // Allow side. Without this a guard that suppressed unconditionally would
    // satisfy the deny case and silence the alarm forever.
    const tenants = ["11111111-1111-4111-8111-111111111111"];
    const prisma = makeStubPrisma(tenants);
    trackTenantOrder(prisma, tenants);

    await runTick(prisma, new Map());

    const beat = logLines.find((l) => l.includes(HEARTBEAT));
    expect(beat).toBeDefined();
    expect(JSON.parse(beat).verifiedTenantCount).toBe(1);
  });

  it("withholds the heartbeat when a tenant fails to verify", async () => {
    const tenants = ["22222222-2222-4222-8222-222222222222"];
    const prisma = makeStubPrisma(tenants, tenants);
    trackTenantOrder(prisma, tenants);

    await runTick(prisma, new Map());

    // Deny side: the heartbeat must be absent, so the 2h absence alarm fires.
    expect(logLines.find((l) => l.includes(HEARTBEAT))).toBeUndefined();
    expect(
      errLines.some(([fmt]) => String(fmt).includes("heartbeat withheld")),
    ).toBe(true);
  });

  it("withholds the heartbeat when only SOME tenants fail", async () => {
    // A partial tick is a failed tick: a heartbeat here would report healthy
    // for tenants that were never walked.
    const ok = "33333333-3333-4333-8333-333333333333";
    const bad = "44444444-4444-4444-8444-444444444444";
    const prisma = makeStubPrisma([ok, bad], [bad]);
    trackTenantOrder(prisma, [ok, bad]);

    await runTick(prisma, new Map());

    expect(logLines.find((l) => l.includes(HEARTBEAT))).toBeUndefined();
    const withheld = errLines.find(([fmt]) =>
      String(fmt).includes("heartbeat withheld"),
    );
    // 1 of 2 failed — the counts are the point, so assert the args, not prose.
    expect(withheld?.slice(1, 3)).toEqual([1, 2]);
  });
});
