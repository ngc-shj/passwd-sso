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
 * Also pins the read-path preconditions — `RLS_CONTEXT_MISSING` on the tenant
 * path, `BYPASS_CONTEXT_MISSING` and `BYPASS_SCOPE_VIOLATION` on the sentinel's
 * bypass path — which the integration suite structurally cannot reach because
 * the real wrappers always set the GUCs there.
 *
 * No DB: runTick is driven with a stub client that records, per transaction,
 * the GUCs the wrappers wrote and answers `current_setting` reads from them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { format } from "node:util";
import { runTick, verifyChainUnderSentinelGrant } from "../audit-chain-verify-worker.ts";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { matchesFilterPattern } from "@/__tests__/helpers/cloudwatch-filter-pattern";
import { TerraformConfig, TERRAFORM_DIR, plain } from "@/__tests__/helpers/hcl-subset";

const HEARTBEAT = "audit-chain-verify-heartbeat";
const SENTINEL_GRANT = BYPASS_GRANT.AUDIT_CHAIN_VERIFY_SENTINEL_READ;
const ENUMERATION = "enumeration";
const FOREIGN = "abababab-abab-4bab-8bab-abababababab";

// console.error applies printf formatting, so a reason passed as a %s/%j
// argument never appears in the format string itself — only in a later
// element of the captured args array. Match across the whole call, not fmt.
function errLineIncludes(errLines, text) {
  return errLines.some((args) => args.some((a) => String(a).includes(text)));
}

/**
 * The `verify threw` line for `tenantId`, or undefined: [fmt, tenantId,
 * errorLogFields, detail], where detail is the worker's own precondition
 * message or null.
 */
function threwFor(errLines, tenantId) {
  return errLines.find(
    ([fmt, id]) => String(fmt).includes("verify threw") && id === tenantId,
  );
}

function heartbeatOf(logLines) {
  return JSON.parse(logLines.find((l) => l.includes(HEARTBEAT)));
}

/**
 * The `set_config(name, value, true)` calls of one tagged `$executeRaw`, as
 * { name: value }. A value is either a literal in the SQL text or a bound
 * template value — the setters use both — so the text is rejoined with a marker
 * per bound value and each call resolved against `values`.
 */
function parseGucWrites(strings, values) {
  const sql = strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? `\u0000${i}\u0000` : ""),
    "",
  );
  const writes = {};
  const re = /set_config\('([^']+)',\s*(?:'([^']*)'|\u0000(\d+)\u0000)/g;
  for (const m of sql.matchAll(re)) {
    writes[m[1]] = m[2] !== undefined ? m[2] : values[Number(m[3])];
  }
  return writes;
}

/**
 * @param tenantIds tenants the enumeration returns, in order
 * @param failFor   tenant ids whose transaction should fail to open
 * @param opts.enumerationRejects when true, the enumeration read itself rejects,
 *   simulating withBypassRls throwing (lost scope, dropped connection, ...)
 * @param opts.fixtures { [tenantId]: { anchors?, rows?, chainedRows? } } — what
 *   the anchor read, walk and chained-row count return for the tenant bound as
 *   $1. A tenant without an entry has no anchor and no chained rows.
 * @param opts.openErrors { [tenantId]: Error } — what that tenant's transaction
 *   throws at the open, as a driver error would reach runTick
 * @param opts.reads { [tenantId]: { tenantIdSetting?, bypassState? } } — what
 *   that tenant's transaction reports instead of what it wrote:
 *   `tenantIdSetting` replaces current_setting('app.tenant_id') on the tenant
 *   path; `bypassState` is merged over readBypassState's row, or `null` for no
 *   row at all.
 */
function makeStubPrisma(tenantIds, failFor = [], opts = {}) {
  const {
    enumerationRejects = false,
    fixtures = {},
    reads = {},
    openErrors = {},
  } = opts;
  /** One record per $transaction call, in call order. */
  const transactions = [];
  return {
    transactions,
    $transaction: async (fn, txOpts) => {
      // The tenant enumeration runs under withBypassRls, so it is the FIRST
      // $transaction call runTick makes — before any per-tenant one.
      const label = transactions.length === 0 ? ENUMERATION : currentTenantId;
      const record = { tenant: label, gucs: {}, options: txOpts, queried: [] };
      transactions.push(record);
      // Failing at the open is exactly how a broken context reaches runTick.
      if (label !== ENUMERATION && failFor.includes(label)) {
        throw new Error(`RLS_CONTEXT_MISSING: app.tenant_id is null, expected ${label}`);
      }
      if (label in openErrors) throw openErrors[label];
      const read = reads[label] ?? {};
      const tx = {
        // setBypassGucs / setTenantGucs write through the tagged form.
        $executeRaw: async (strings, ...values) => {
          Object.assign(record.gucs, parseGucWrites(strings, values));
          return 0;
        },
        // readBypassState's tagged read.
        $queryRaw: async (strings) => {
          if (!strings.join("").includes("current_setting")) {
            throw new Error(`stub: unexpected $queryRaw ${strings.join("?")}`);
          }
          if (read.bypassState === null) return [];
          return [
            {
              bypass_rls: record.gucs["app.bypass_rls"] ?? null,
              purpose: record.gucs["app.bypass_purpose"] ?? null,
              tenant_id: record.gucs["app.tenant_id"] ?? null,
              tables: record.gucs["app.bypass_tables"] ?? null,
              ...read.bypassState,
            },
          ];
        },
        $queryRawUnsafe: async (sql, ...params) => {
          const text = String(sql);
          if (text.includes("current_setting")) {
            return [
              {
                tenant_id:
                  "tenantIdSetting" in read
                    ? read.tenantIdSetting
                    : (record.gucs["app.tenant_id"] ?? null),
              },
            ];
          }
          const tenantId = params[0];
          // A mislabelled transaction (a wrong trackTenantOrder list) would
          // otherwise serve one tenant's fixture to another and pass quietly.
          // Case-insensitive, as PostgreSQL's uuid equality is: a spelling
          // difference must reach the worker's own row checks, not stop here.
          if (String(tenantId).toLowerCase() !== label) {
            throw new Error(`stub: transaction for ${label} queried ${tenantId}`);
          }
          record.queried.push(text);
          const fixture = fixtures[label] ?? {};
          if (text.includes("audit_chain_anchors")) return fixture.anchors ?? [];
          if (text.includes("COUNT(*)")) {
            return [{ count: BigInt(fixture.chainedRows ?? 0) }];
          }
          if (text.includes("audit_logs")) return fixture.rows ?? [];
          throw new Error(`stub: unexpected query ${text}`);
        },
        tenant: {
          findMany: async () => {
            // Thrown here, not returned as a rejection value: this is what
            // withBypassRls's $transaction call itself failing looks like
            // from runTick's perspective (its try/catch around the call).
            if (enumerationRejects) {
              throw new Error("ENUMERATION_REJECTED: bypass transaction aborted");
            }
            return tenantIds.map((id) => ({ id }));
          },
        },
      };
      return fn(tx);
    },
  };
}

// The wrappers receive the tenant id, but the stub's $transaction does not;
// runTick walks tenants serially, so tracking the current one is sufficient.
let currentTenantId = null;

/** Advance `currentTenantId` in walk order as each transaction opens. */
function trackTenantOrder(prisma, order) {
  let i = 0;
  let callCount = 0;
  const orig = prisma.$transaction;
  // Forward opts: dropping it here would make the tx-budget assertions vacuous
  // even with the stub recording them.
  prisma.$transaction = async (fn, opts) => {
    callCount += 1;
    // The enumeration transaction (withBypassRls) is always the first call —
    // it carries no per-tenant id, and must not consume the per-tenant order.
    if (callCount === 1) return orig(fn, opts);
    currentTenantId = order[i++];
    return orig(fn, opts);
  };
}

function txOf(prisma, tenantId) {
  return prisma.transactions.find((t) => t.tenant === tenantId);
}

function anchor(tenantId, seq) {
  return { tenant_id: tenantId, chain_seq: String(seq), prev_hash: Buffer.alloc(32) };
}

function chainRow(tenantId, seq, id) {
  return {
    id,
    tenant_id: tenantId,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    chain_seq: BigInt(seq),
    event_hash: Buffer.alloc(32, seq),
    chain_prev_hash: Buffer.alloc(32),
    metadata: {},
  };
}

/** Run a tick whose only tenant is the sentinel. */
async function sentinelTick(opts) {
  const prisma = makeStubPrisma([SYSTEM_TENANT_ID], [], opts);
  trackTenantOrder(prisma, [SYSTEM_TENANT_ID]);
  await runTick(prisma, new Map());
  return prisma;
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
  });

  it("emits the heartbeat with full coverage when every tenant verified", async () => {
    const t = "11111111-1111-4111-8111-111111111111";
    // The sentinel is always in the real enumeration; omitting it here would
    // incidentally trip TENANT_ENUMERATION_INCOMPLETE and corrupt this test's
    // own count, which is not what it is pinning down.
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(2);
    expect(beat.verifiedTenantCount).toBe(2);
    expect(beat.erroredTenantCount).toBe(0);
  });

  it("still emits the heartbeat when a tenant fails, but reports the shortfall", async () => {
    // Liveness is not conditional on coverage: a live worker must stay
    // distinguishable from a dead one. The counts are what a partial tick is
    // detected by.
    const ok = "33333333-3333-4333-8333-333333333333";
    const bad = "44444444-4444-4444-8444-444444444444";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, ok, bad], [bad]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, ok, bad]);

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(3);
    expect(beat.verifiedTenantCount).toBe(2);
    expect(beat.erroredTenantCount).toBe(1);
    // verifiedTenantCount < tenantCount is the coverage alarm's predicate.
    expect(beat.verifiedTenantCount).toBeLessThan(beat.tenantCount);
  });

  it("names the failing tenants so the coverage alarm is actionable", async () => {
    const bad = "22222222-2222-4222-8222-222222222222";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, bad], [bad]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, bad]);

    await runTick(prisma, new Map());

    const incomplete = errLines.find(([fmt]) =>
      String(fmt).includes("tick incomplete"),
    );
    expect(incomplete).toBeDefined();
    // 1 failed of 2 enumerated: the sentinel is in the denominator.
    expect(incomplete.slice(1, 4)).toEqual([1, 2, bad]);
  });

  it("throws RLS_CONTEXT_MISSING when the GUC was never established", async () => {
    // The precondition assertion is the device that keeps a future refactor
    // from silently reinstating the inert verifier. Reaching it needs a
    // context that reports the wrong tenant, not a deleted wrapper.
    const t = "55555555-5555-4555-8555-555555555555";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t], [], {
      reads: { [t]: { tenantIdSetting: null } },
    });
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    const threw = threwFor(errLines, t);
    expect(threw).toBeDefined();
    expect(threw[2]).toEqual({ name: "ChainVerifyPreconditionError", code: "RLS_CONTEXT_MISSING" });
    expect(String(threw[3])).toMatch(/RLS_CONTEXT_MISSING/);
    // No read ran on a context that failed its precondition.
    expect(txOf(prisma, t).queried).toEqual([]);
    // And it counts as a coverage shortfall rather than a silent pass.
    const beat = heartbeatOf(logLines);
    expect(beat.erroredTenantCount).toBe(1);
  });

  it("prints any other thrown error as its name and code, never its message", async () => {
    // A driver or Prisma message can carry a connection target or a query
    // with its bound parameters; only the worker's own preconditions print one.
    const t = "66666666-6666-4666-8666-666666666666";
    const leak = "postgresql://verify_role:s3cr3t@db.internal:5432/passwd_sso";
    const err = Object.assign(new Error(`connect failed: ${leak}`), { code: "ECONNREFUSED" });
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t], [], { openErrors: { [t]: err } });
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    const threw = threwFor(errLines, t);
    expect(threw).toBeDefined();
    expect(threw[2]).toEqual({ name: "Error", code: "ECONNREFUSED" });
    expect(threw[3]).toBeNull();
    // As console.error prints it.
    const printed = errLines.map((args) => format(...args)).join("\n");
    expect(printed).toContain(`tenant=${t} verify threw: error={"name":"Error","code":"ECONNREFUSED"}`);
    expect(printed).not.toContain(leak);
    expect(heartbeatOf(logLines).erroredTenantCount).toBe(1);
  });

  it("forwards an explicit transaction budget, not Prisma's 5s default", async () => {
    // The whole point of the F5 fix. Without recording opts, dropping the
    // { timeout, maxWait } argument reds nothing.
    const t = "77777777-7777-4777-8777-777777777777";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    // The tenant path's own transaction, set up by withTenantRls.
    const tenantTx = txOf(prisma, t);
    expect(tenantTx.gucs["app.tenant_id"]).toBe(t);
    expect(tenantTx.options?.timeout).toBeGreaterThan(5000);
  });

  it("forwards the stated budget on the sentinel's bypass transaction too", async () => {
    // Its own recorded options, not the last transaction's: the sentinel is
    // walked first here, so a tenant-path budget opened after it cannot stand
    // in for a dropped argument on the bypass call.
    const t = "77777777-7777-4777-8777-777777777777";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    const sentinelTx = txOf(prisma, SYSTEM_TENANT_ID);
    expect(sentinelTx.gucs["app.bypass_rls"]).toBe("on");
    expect(sentinelTx.options?.timeout).toBeGreaterThan(5000);
    expect(sentinelTx.options?.maxWait).toBeGreaterThan(0);
  });

  it("counts a tampered tenant as verified, not as a coverage shortfall", async () => {
    // The worker/runbook contract: erroredTenantCount drives the coverage
    // alarm, failedTenantCount drives the tamper alarm. Moving `verified++`
    // inside `if (result.ok)` would turn every real tamper into a
    // "verifier is inert" page and hide the critical behind the high.
    const t = "88888888-8888-4888-8888-888888888888";
    // An anchor claiming chain_seq 1 with no chained rows -> ok:false. Keyed
    // to t, so the sentinel keeps its own (empty, healthy) chain.
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t], [], {
      fixtures: { [t]: { anchors: [anchor(t, 1)] } },
    });
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.verifiedTenantCount).toBe(2);
    expect(beat.erroredTenantCount).toBe(0);
    expect(beat.failedTenantCount).toBe(1);
    // And the tamper line itself is emitted, for that tenant.
    const failedLine = errLines.find(([fmt]) =>
      String(fmt).includes("CHAIN_VERIFY_FAILED"),
    );
    expect(failedLine?.[1]).toBe(t);
  });

  it("emits TENANT_ENUMERATION_EMPTY and a non-zero erroredTenantCount when enumeration returns no tenants (C3)", async () => {
    // The `__system__` tenant always exists, so an empty enumeration means the
    // bypass read lost its scope, not "this deployment has no tenants" — the
    // tick must still emit its heartbeat (liveness), but as a coverage failure.
    const prisma = makeStubPrisma([]);

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(0);
    expect(beat.verifiedTenantCount).toBe(0);
    expect(beat.erroredTenantCount).toBe(1);
    expect(errLineIncludes(errLines, "TENANT_ENUMERATION_EMPTY")).toBe(true);
  });

  it("verifies the sentinel under the sentinel-read grant and counts it", async () => {
    // withTenantRls refuses the sentinel, so it is read under the named bypass
    // instead — and counted like every other tenant, with no `verify threw`.
    const other = "99999999-9999-4999-8999-999999999999";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, other]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, other]);

    await runTick(prisma, new Map());

    const sentinelTx = txOf(prisma, SYSTEM_TENANT_ID);
    expect(sentinelTx.gucs["app.bypass_rls"]).toBe("on");
    expect(sentinelTx.gucs["app.bypass_purpose"]).toBe(SENTINEL_GRANT.purpose);
    expect(sentinelTx.gucs["app.bypass_tables"]).toBe(SENTINEL_GRANT.tables);
    // The reads ran (anchor lookup, then the chained-row count).
    expect(sentinelTx.queried).toHaveLength(2);
    // The other tenant stays on the tenant path.
    expect(txOf(prisma, other).gucs["app.bypass_rls"]).toBe("off");
    expect(threwFor(errLines, SYSTEM_TENANT_ID)).toBeUndefined();

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(2);
    expect(beat.verifiedTenantCount).toBe(2);
    expect(beat.erroredTenantCount).toBe(0);
  });

  it("treats [SYSTEM_TENANT_ID] alone as a complete, healthy tick (allow side)", async () => {
    // A deployment with no other tenants yet is the minimum healthy state: the
    // sentinel is present (enumeration is complete) and is itself verified.
    await sentinelTick();

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(1);
    expect(beat.verifiedTenantCount).toBe(1);
    expect(beat.erroredTenantCount).toBe(0);
    expect(
      errLines.some(([fmt]) => String(fmt).includes("tick incomplete")),
    ).toBe(false);
  });

  it("still verifies a returned tenant when the sentinel is missing from enumeration (TENANT_ENUMERATION_INCOMPLETE)", async () => {
    // A non-empty enumeration without the sentinel lost its scope just as
    // surely as an empty one — but the tenant it did return is real and gets
    // verified anyway; coverage failure and per-tenant verification are
    // independent facts.
    const other = "99999999-9999-4999-8999-999999999999";
    const prisma = makeStubPrisma([other]);
    trackTenantOrder(prisma, [other]);

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.erroredTenantCount).toBe(1);
    expect(beat.verifiedTenantCount).toBe(1);
    expect(errLineIncludes(errLines, "TENANT_ENUMERATION_INCOMPLETE")).toBe(
      true,
    );
  });

  it("still emits the heartbeat when the enumeration read itself throws (TENANT_ENUMERATION_FAILED)", async () => {
    // Simulates withBypassRls's $transaction call rejecting outright (a
    // dropped connection, a nesting-guard throw, ...) — distinct from a
    // successful read that came back empty or incomplete.
    const prisma = makeStubPrisma([], [], { enumerationRejects: true });

    await runTick(prisma, new Map());

    const beat = heartbeatOf(logLines);
    expect(beat.tenantCount).toBe(0);
    expect(beat.verifiedTenantCount).toBe(0);
    expect(beat.erroredTenantCount).toBe(1);
    expect(errLineIncludes(errLines, "TENANT_ENUMERATION_FAILED")).toBe(true);
    // No list came back, so the line must not blame a missing system tenant.
    expect(errLineIncludes(errLines, "did not include")).toBe(false);
    expect(errLineIncludes(errLines, "read threw")).toBe(true);
  });

  it("reads an uppercase-spelled tenant id under the sentinel grant as that tenant", async () => {
    // PostgreSQL returns uuids in lowercase. A row check comparing against the
    // caller's spelling would call every row foreign; the path normalises once.
    // (The sentinel's own id has no hex letters, so this is exercised on
    // another tenant, as the integration cells run this path.)
    const t = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const prisma = makeStubPrisma([], [], {
      fixtures: { [t]: { anchors: [anchor(t, 1)], rows: [chainRow(t, 1, "efefefef-efef-4fef-8fef-efefefefefef")] } },
    });
    // No enumeration precedes a direct call: take the first slot as `t`'s.
    prisma.transactions.push({ tenant: ENUMERATION, gucs: {}, options: undefined, queried: [] });
    currentTenantId = t;

    const result = await verifyChainUnderSentinelGrant(t.toUpperCase(), { prisma, logger: console });

    // No BYPASS_SCOPE_VIOLATION: both the anchor read and the walk ran and
    // their rows were accepted as this tenant's. (The fixture's hashes are not
    // a real chain, so the verdict itself is a tamper — not what is tested.)
    expect(result.tenantId).toBe(t);
    expect(txOf(prisma, t).queried).toHaveLength(2);
    expect(txOf(prisma, t).gucs["app.bypass_rls"]).toBe("on");
  });

  it("does NOT throw when the GUC matches the tenant under verification", async () => {
    // Allow side: an assertion that always fired would be caught here.
    const t = "66666666-6666-4666-8666-666666666666";
    const prisma = makeStubPrisma([SYSTEM_TENANT_ID, t]);
    trackTenantOrder(prisma, [SYSTEM_TENANT_ID, t]);

    await runTick(prisma, new Map());

    expect(errLines.find(([fmt]) => String(fmt).includes("verify threw"))).toBeUndefined();
    const beat = heartbeatOf(logLines);
    expect(beat.erroredTenantCount).toBe(0);
  });

  describe("sentinel bypass precondition (BYPASS_CONTEXT_MISSING)", () => {
    /** The sentinel's thrown message; also asserts no read ran and it errored. */
    function missingContextMessage(prisma) {
      const threw = threwFor(errLines, SYSTEM_TENANT_ID);
      expect(threw).toBeDefined();
      expect(threw[2]).toEqual({ name: "ChainVerifyPreconditionError", code: "BYPASS_CONTEXT_MISSING" });
      const message = String(threw[3]);
      expect(message).toContain("BYPASS_CONTEXT_MISSING");
      expect(txOf(prisma, SYSTEM_TENANT_ID).queried).toEqual([]);
      const beat = heartbeatOf(logLines);
      expect(beat.erroredTenantCount).toBe(1);
      expect(beat.verifiedTenantCount).toBe(0);
      return message;
    }

    it("throws when bypass_rls is not on", async () => {
      const prisma = await sentinelTick({
        reads: { [SYSTEM_TENANT_ID]: { bypassState: { bypass_rls: "off" } } },
      });
      expect(missingContextMessage(prisma)).toContain('bypass_rls="off"');
    });

    it("throws when the purpose differs from the grant's", async () => {
      const purpose = BYPASS_GRANT.WEBAUTHN_AUTHORIZE_CREDENTIAL.purpose;
      expect(purpose).not.toBe(SENTINEL_GRANT.purpose);
      const prisma = await sentinelTick({
        reads: { [SYSTEM_TENANT_ID]: { bypassState: { purpose } } },
      });
      expect(missingContextMessage(prisma)).toContain(
        `purpose=${JSON.stringify(purpose)}`,
      );
    });

    it("throws when the tables differ from the grant's", async () => {
      // Same purpose, wider table set: only the tables comparison can catch it.
      const tables = BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP.tables;
      expect(BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP.purpose).toBe(
        SENTINEL_GRANT.purpose,
      );
      const prisma = await sentinelTick({
        reads: { [SYSTEM_TENANT_ID]: { bypassState: { tables } } },
      });
      expect(missingContextMessage(prisma)).toContain(
        `tables=${JSON.stringify(tables)}`,
      );
    });

    it("throws when readBypassState returns no row", async () => {
      const prisma = await sentinelTick({
        reads: { [SYSTEM_TENANT_ID]: { bypassState: null } },
      });
      expect(missingContextMessage(prisma)).toContain(
        "bypass_rls=null purpose=null tables=null",
      );
    });
  });

  describe("sentinel bypass row scope (BYPASS_SCOPE_VIOLATION)", () => {
    function scopeViolationMessage() {
      const threw = threwFor(errLines, SYSTEM_TENANT_ID);
      expect(threw).toBeDefined();
      const beat = heartbeatOf(logLines);
      expect(beat.erroredTenantCount).toBe(1);
      expect(beat.verifiedTenantCount).toBe(0);
      expect(threw[2]).toEqual({ name: "ChainVerifyPreconditionError", code: "BYPASS_SCOPE_VIOLATION" });
      return String(threw[3]);
    }

    it("throws on a foreign anchor row", async () => {
      await sentinelTick({
        fixtures: { [SYSTEM_TENANT_ID]: { anchors: [anchor(FOREIGN, 3)] } },
      });
      const message = scopeViolationMessage();
      expect(message).toContain(
        `BYPASS_SCOPE_VIOLATION: audit_chain_anchors returned a row of tenant ${JSON.stringify(FOREIGN)} ` +
          `while verifying ${JSON.stringify(SYSTEM_TENANT_ID)}`,
      );
    });

    it("throws on the sentinel's own anchor followed by a foreign one", async () => {
      await sentinelTick({
        fixtures: {
          [SYSTEM_TENANT_ID]: {
            anchors: [anchor(SYSTEM_TENANT_ID, 1), anchor(FOREIGN, 3)],
          },
        },
      });
      expect(scopeViolationMessage()).toContain(
        `audit_chain_anchors returned a row of tenant ${JSON.stringify(FOREIGN)}`,
      );
    });

    it("throws on two anchor rows even when both are the sentinel's (at most one row)", async () => {
      // The only case the row-count half alone decides: no foreign tenant id
      // is there to find.
      await sentinelTick({
        fixtures: {
          [SYSTEM_TENANT_ID]: {
            anchors: [anchor(SYSTEM_TENANT_ID, 1), anchor(SYSTEM_TENANT_ID, 2)],
          },
        },
      });
      expect(scopeViolationMessage()).toContain(
        `BYPASS_SCOPE_VIOLATION: audit_chain_anchors returned 2 rows ` +
          `while verifying ${JSON.stringify(SYSTEM_TENANT_ID)}, expected at most 1`,
      );
    });

    it("throws on a foreign walked row, naming the tenant but not the row", async () => {
      const foreignRowId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
      await sentinelTick({
        fixtures: {
          [SYSTEM_TENANT_ID]: {
            anchors: [anchor(SYSTEM_TENANT_ID, 2)],
            rows: [
              chainRow(SYSTEM_TENANT_ID, 1, "efefefef-efef-4fef-8fef-efefefefefef"),
              chainRow(FOREIGN, 2, foreignRowId),
            ],
          },
        },
      });
      const message = scopeViolationMessage();
      expect(message).toContain(
        `BYPASS_SCOPE_VIOLATION: audit_logs returned a row of tenant ${JSON.stringify(FOREIGN)} ` +
          `while verifying ${JSON.stringify(SYSTEM_TENANT_ID)}`,
      );
      expect(message).not.toContain(foreignRowId);
    });

    it("does not throw when the anchor and walked rows are all the sentinel's (allow side)", async () => {
      // The positive control for the cases above: same shape, own tenant id.
      // The rows' hashes are not a real chain, so the walk reports a tamper —
      // verified and failed, not errored.
      const prisma = await sentinelTick({
        fixtures: {
          [SYSTEM_TENANT_ID]: {
            anchors: [anchor(SYSTEM_TENANT_ID, 2)],
            rows: [
              chainRow(SYSTEM_TENANT_ID, 1, "efefefef-efef-4fef-8fef-efefefefefef"),
              chainRow(SYSTEM_TENANT_ID, 2, "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"),
            ],
          },
        },
      });
      expect(threwFor(errLines, SYSTEM_TENANT_ID)).toBeUndefined();
      // Anchor read, then the walk.
      expect(txOf(prisma, SYSTEM_TENANT_ID).queried).toHaveLength(2);
      const beat = heartbeatOf(logLines);
      expect(beat.verifiedTenantCount).toBe(1);
      expect(beat.erroredTenantCount).toBe(0);
      expect(beat.failedTenantCount).toBe(1);
    });
  });
});

// The heartbeat against the CloudWatch filters that count it
// (infra/terraform/monitoring.tf), as Terraform renders them: each matches the
// line a tick of that kind really emits, and not the others.
describe("audit-chain-verify heartbeat vs its metric filters", () => {
  const tf = new TerraformConfig(TERRAFORM_DIR);
  const counts = plain(tf.local("audit_chain_verify_count_alarms"));
  const countPattern = (key) =>
    String(tf.attr(tf.resource("aws_cloudwatch_log_metric_filter", "audit_chain_verify_count"), "pattern", { each: { key, value: counts[key] } }));
  const heartbeatPattern = String(tf.attr(tf.resource("aws_cloudwatch_log_metric_filter", "audit_chain_verify_heartbeat"), "pattern"));

  const healthyT = "11111111-1111-4111-8111-111111111111";
  const tamperedT = "88888888-8888-4888-8888-888888888888";
  /** The heartbeat of one tick over `prisma`, as the JSON line it logs. */
  async function beatOf(prisma, order) {
    const logged = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      trackTenantOrder(prisma, order);
      await runTick(prisma, new Map());
    } finally {
      vi.restoreAllMocks();
      currentTenantId = null;
    }
    return heartbeatOf(logged);
  }

  const ticks = {};
  beforeEach(async () => {
    ticks.healthy = await beatOf(makeStubPrisma([SYSTEM_TENANT_ID, healthyT]), [SYSTEM_TENANT_ID, healthyT]);
    ticks.errored = await beatOf(makeStubPrisma([SYSTEM_TENANT_ID, healthyT], [healthyT]), [SYSTEM_TENANT_ID, healthyT]);
    ticks.failed = await beatOf(
      makeStubPrisma([SYSTEM_TENANT_ID, tamperedT], [], { fixtures: { [tamperedT]: { anchors: [anchor(tamperedT, 1)] } } }),
      [SYSTEM_TENANT_ID, tamperedT],
    );
  });

  const matching = (p) => Object.keys(ticks).filter((k) => matchesFilterPattern(p, ticks[k])).sort();

  it("counts every tick's heartbeat for the absence alarm, whatever it found", () => {
    expect(matching(heartbeatPattern)).toEqual(["errored", "failed", "healthy"]);
  });

  it("raises the errored filter only for a tick with a tenant that failed to verify", () => {
    expect(matching(countPattern("errored"))).toEqual(["errored"]);
  });

  it("raises the failed filter only for a tick with a tampered chain", () => {
    expect(matching(countPattern("failed"))).toEqual(["failed"]);
  });

  it("alarms on the heartbeat's absence for 2 h, silence breaching", () => {
    const alarm = tf.resource("aws_cloudwatch_metric_alarm", "audit_chain_verify_heartbeat_absent");
    expect(tf.attr(alarm, "treat_missing_data")).toBe("breaching");
    expect(Number(tf.attr(alarm, "period")) * Number(tf.attr(alarm, "evaluation_periods"))).toBe(2 * 3600);
  });

  it("binds the filters to the verify worker's log group", () => {
    for (const name of ["audit_chain_verify_heartbeat", "audit_chain_verify_count"]) {
      const filter = tf.resource("aws_cloudwatch_log_metric_filter", name);
      expect(String(tf.attr(filter, "log_group_name", { each: { key: "errored", value: "erroredTenantCount" } }))).toBe(
        "<ref:aws_cloudwatch_log_group.audit_chain_verify_worker.name>",
      );
    }
  });
});
