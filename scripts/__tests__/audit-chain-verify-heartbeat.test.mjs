/**
 * Liveness and coverage are separate signals, and these cases pin that split.
 *
 * `docs/operations/alerts.md` alarms on the heartbeat's ABSENCE for 2h, so the
 * heartbeat must mean "the process ran" and nothing more: withholding it when a
 * tenant fails would make one permanently-failing tenant indistinguishable from
 * a dead worker, and the resulting always-firing alarm gets muted. Coverage
 * therefore rides on the counts carried by the same line, which is what an
 * operator alerts on for a partial tick.
 *
 * Also pins the RLS precondition (`RLS_CONTEXT_MISSING`) — the branch's
 * anti-regression device, which the integration suite structurally cannot reach
 * because withTenantRls always sets the GUC there.
 *
 * No DB: runTick is driven with a stub client.
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
    $transaction: async (fn, opts) => {
      txOptions = opts;
      const tx = {
        $executeRaw: async () => 0,
        $queryRawUnsafe: async (sql) => {
          // withTenantRls sets the GUC through $executeRaw; the first read in
          // verifyTenantChain is the precondition assertion.
          if (String(sql).includes("current_setting")) {
            // gucOverride lets a case simulate a context that was never
            // established, which is the only way to reach the precondition
            // throw without deleting the wrapper.
            return [
              { tenant_id: gucOverride === undefined ? currentTenantId : gucOverride },
            ];
          }
          if (String(sql).includes("audit_chain_anchors") && anchorRows) {
            return anchorRows;
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
/** undefined = report the real tenant id; otherwise the value to report. */
let gucOverride;
/** Options withTenantRls forwarded to $transaction on the last call. */
let txOptions;
/** When set, the anchors query returns this instead of []. */
let anchorRows;

/** Advance `currentTenantId` in walk order as each transaction opens. */
function trackTenantOrder(prisma, order) {
  let i = 0;
  const orig = prisma.$transaction;
  // Forward opts: dropping it here would make the tx-budget assertion vacuous
  // even with the stub capturing it.
  prisma.$transaction = async (fn, opts) => {
    currentTenantId = order[i++];
    return orig(fn, opts);
  };
}

describe("audit-chain-verify liveness vs coverage signals", () => {
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
    gucOverride = undefined;
    txOptions = undefined;
    anchorRows = undefined;
  });

  it("emits the heartbeat with full coverage when every tenant verified", async () => {
    const tenants = ["11111111-1111-4111-8111-111111111111"];
    const prisma = makeStubPrisma(tenants);
    trackTenantOrder(prisma, tenants);

    await runTick(prisma, new Map());

    const beat = JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
    expect(beat.tenantCount).toBe(1);
    expect(beat.verifiedTenantCount).toBe(1);
    expect(beat.erroredTenantCount).toBe(0);
  });

  it("still emits the heartbeat when a tenant fails, but reports the shortfall", async () => {
    // Liveness is not conditional on coverage: a live worker must stay
    // distinguishable from a dead one. The counts are what a partial tick is
    // detected by.
    const ok = "33333333-3333-4333-8333-333333333333";
    const bad = "44444444-4444-4444-8444-444444444444";
    const prisma = makeStubPrisma([ok, bad], [bad]);
    trackTenantOrder(prisma, [ok, bad]);

    await runTick(prisma, new Map());

    const beat = JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
    expect(beat.tenantCount).toBe(2);
    expect(beat.verifiedTenantCount).toBe(1);
    expect(beat.erroredTenantCount).toBe(1);
    // verifiedTenantCount < tenantCount is the coverage alarm's predicate.
    expect(beat.verifiedTenantCount).toBeLessThan(beat.tenantCount);
  });

  it("names the failing tenants so the coverage alarm is actionable", async () => {
    const bad = "22222222-2222-4222-8222-222222222222";
    const prisma = makeStubPrisma([bad], [bad]);
    trackTenantOrder(prisma, [bad]);

    await runTick(prisma, new Map());

    const incomplete = errLines.find(([fmt]) =>
      String(fmt).includes("tick incomplete"),
    );
    expect(incomplete).toBeDefined();
    expect(incomplete.slice(1, 4)).toEqual([1, 1, bad]);
  });

  it("throws RLS_CONTEXT_MISSING when the GUC was never established", async () => {
    // The precondition assertion is the device that keeps a future refactor
    // from silently reinstating the inert verifier. Reaching it needs a
    // context that reports the wrong tenant, not a deleted wrapper.
    const t = "55555555-5555-4555-8555-555555555555";
    gucOverride = null;
    const prisma = makeStubPrisma([t]);
    trackTenantOrder(prisma, [t]);

    await runTick(prisma, new Map());

    const threw = errLines.find(([fmt]) => String(fmt).includes("verify threw"));
    expect(threw).toBeDefined();
    expect(String(threw[2])).toMatch(/RLS_CONTEXT_MISSING/);
    // And it counts as a coverage shortfall rather than a silent pass.
    const beat = JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
    expect(beat.erroredTenantCount).toBe(1);
  });

  it("forwards an explicit transaction budget, not Prisma's 5s default", async () => {
    // The whole point of the F5 fix. Without capturing opts here, dropping the
    // { timeout, maxWait } argument reds nothing.
    const t = "77777777-7777-4777-8777-777777777777";
    const prisma = makeStubPrisma([t]);
    trackTenantOrder(prisma, [t]);

    await runTick(prisma, new Map());

    expect(txOptions?.timeout).toBeGreaterThan(5000);
  });

  it("counts a tampered tenant as verified, not as a coverage shortfall", async () => {
    // The worker/runbook contract: erroredTenantCount drives the coverage
    // alarm, failedTenantCount drives the tamper alarm. Moving `verified++`
    // inside `if (result.ok)` would turn every real tamper into a
    // "verifier is inert" page and hide the critical behind the high.
    const t = "88888888-8888-4888-8888-888888888888";
    // An anchor claiming chain_seq 1 with no chained rows -> ok:false.
    anchorRows = [{ chain_seq: "1", prev_hash: Buffer.from([0]) }];
    const prisma = makeStubPrisma([t]);
    trackTenantOrder(prisma, [t]);

    await runTick(prisma, new Map());

    const beat = JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
    expect(beat.verifiedTenantCount).toBe(1);
    expect(beat.erroredTenantCount).toBe(0);
    expect(beat.failedTenantCount).toBe(1);
    // And the tamper line itself is emitted.
    expect(
      errLines.some(([fmt]) => String(fmt).includes("CHAIN_VERIFY_FAILED")),
    ).toBe(true);
  });

  it("does NOT throw when the GUC matches the tenant under verification", async () => {
    // Allow side: an assertion that always fired would be caught here.
    const t = "66666666-6666-4666-8666-666666666666";
    const prisma = makeStubPrisma([t]);
    trackTenantOrder(prisma, [t]);

    await runTick(prisma, new Map());

    expect(errLines.find(([fmt]) => String(fmt).includes("verify threw"))).toBeUndefined();
    const beat = JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
    expect(beat.erroredTenantCount).toBe(0);
  });
});
