/**
 * The dispatcher owns the RLS bypass (#874, C1 / T6), driven through sweepOnce
 * only — the module-private inSweepTx has no exported seam.
 *
 * Each `$transaction` gets a fresh fake tx whose `current_setting` read
 * answers from that tx's own state, which is `on` only after a set_config on
 * that same tx. So a sweep reads `on` exactly when the dispatcher set the
 * bypass on the transaction it handed the sweep, and a mis-set entry surfaces
 * as -1 plus an entry_failed log.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { logError, logInfo } = vi.hoisted(() => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: logInfo, error: logError }),
}));

import { sweepOnce } from "../sweep";
import { RETENTION_REGISTRY } from "../registry";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { isBypassSetConfig, isBypassStateRead, sqlText } from "@/__tests__/workers/retention-gc-tx-fakes";

const ROWS_PER_WRITE = 5;
const TRASH_TENANT_ID = "11111111-1111-4111-8111-111111111111";

interface RecordedCall {
  name: string;
  args: unknown[];
}

interface FakeTxState {
  calls: RecordedCall[];
  bypass: string | null;
}

function makeDispatchPrisma(opts: { failDeleteOn?: string; inheritedBypass?: string } = {}) {
  const txs: FakeTxState[] = [];

  function makeTx() {
    const state: FakeTxState = { calls: [], bypass: opts.inheritedBypass ?? null };
    txs.push(state);
    const record =
      <A extends unknown[], R>(name: string, impl: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        state.calls.push({ name, args });
        return impl(...args);
      };
    return {
      $executeRaw: record("$executeRaw", async (strings: TemplateStringsArray) => {
        const set = /set_config\(\s*'app\.bypass_rls'\s*,\s*'([^']*)'/.exec(sqlText(strings));
        if (set) state.bypass = set[1];
        return 1;
      }),
      $queryRaw: record("$queryRaw", async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const text = sqlText(strings);
        // Both assertSweepBypass and enqueueAuditInWorkerTx read the same
        // readBypassState query; this tx's own state answers either.
        if (isBypassStateRead(text)) return [{ bypass_rls: state.bypass, purpose: null, tenant_id: null, tables: null }];
        if (text.includes("SELECT EXISTS")) return [{ ok: true }];
        return []; // the trash SELECT, audit_log_purge
      }),
      $executeRawUnsafe: record("$executeRawUnsafe", async (sql: string, ..._params: unknown[]) => {
        if (opts.failDeleteOn && sql.includes(`DELETE FROM ${opts.failDeleteOn}`)) {
          throw Object.assign(new Error("boom"), { code: "XX000" });
        }
        return ROWS_PER_WRITE;
      }),
      $queryRawUnsafe: record("$queryRawUnsafe", async (_sql: string, ..._params: unknown[]) => []),
      tenant: { findMany: record("tenant.findMany", async (_arg: unknown) => []) },
      auditOutbox: { create: record("auditOutbox.create", async (_arg: unknown) => ({})) },
    };
  }

  const workerPrisma = {
    // sweepTrashEntry enumerates on the client itself; one tenant gives each
    // trash entry one transaction.
    tenant: {
      findMany: vi.fn(async () => [{ id: TRASH_TENANT_ID, trashRetentionDays: 30 }]),
    },
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      fn(makeTx()),
    ),
  } as unknown as Parameters<typeof sweepOnce>[0];

  return { workerPrisma, txs };
}

function setConfigCalls(state: FakeTxState): RecordedCall[] {
  return state.calls.filter((c) => c.name === "$executeRaw" && isBypassSetConfig(sqlText(c.args[0])));
}

function deletesFrom(state: FakeTxState, table: string): boolean {
  return state.calls.some(
    (c) => c.name === "$executeRawUnsafe" && String(c.args[0]).includes(`DELETE FROM ${table}`),
  );
}

const NON_GLOBAL_DELETE = RETENTION_REGISTRY.filter(
  (e) =>
    (e.kind === "EXPIRY" || e.kind === "EXPIRY_GUARDED" || e.kind === "EXPIRY_AUDIT_PROVENANCE") &&
    e.globalDelete !== true,
).map((e) => e.table);

beforeEach(() => {
  logError.mockClear();
  logInfo.mockClear();
});

describe("sweepOnce dispatch sets the bypass each entry declares (C1)", () => {
  it("the registry has an entry without globalDelete to exercise the bypass:false path", () => {
    expect(NON_GLOBAL_DELETE).toEqual(["verification_tokens"]);
  });

  it("every entry runs without a -1 and without an entry_failed log", async () => {
    const { workerPrisma } = makeDispatchPrisma();
    const counts = await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: true });

    expect(Object.keys(counts).sort()).toEqual(RETENTION_REGISTRY.map((e) => e.table).sort());
    expect(Object.entries(counts).filter(([, n]) => n === -1)).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("set_config('app.bypass_rls', 'on', true) is the first call on every bypass transaction", async () => {
    const { workerPrisma, txs } = makeDispatchPrisma();
    await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: true });

    // access-request status sweep + one per non-trash entry + one per trash
    // entry (one tenant) + the heartbeat.
    expect(txs).toHaveLength(RETENTION_REGISTRY.length + 2);
    const bypassTxs = txs.filter((t) => !NON_GLOBAL_DELETE.some((table) => deletesFrom(t, table)));
    expect(bypassTxs).toHaveLength(txs.length - NON_GLOBAL_DELETE.length);
    for (const state of bypassTxs) {
      expect(setConfigCalls(state)).toHaveLength(1);
      expect(state.calls[0].name).toBe("$executeRaw");
      // Transaction-local (is_local = true): it ends with this transaction.
      expect(sqlText(state.calls[0].args[0])).toMatch(
        /set_config\(\s*'app\.bypass_rls'\s*,\s*'on'\s*,\s*true\s*\)/,
      );
      // The sweep's own first call follows it on the same tx.
      expect(state.calls.length).toBeGreaterThan(1);
    }
  });

  it("an entry without globalDelete (verification_tokens) runs with no set_config", async () => {
    const { workerPrisma, txs } = makeDispatchPrisma();
    const counts = await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: false });

    const tokenTxs = txs.filter((t) => deletesFrom(t, "verification_tokens"));
    expect(tokenTxs).toHaveLength(1);
    expect(tokenTxs[0].calls.filter((c) => c.name === "$executeRaw")).toEqual([]);
    // It still read the state (and found the bypass off) before the DELETE.
    expect(isBypassStateRead(sqlText(tokenTxs[0].calls[0].args[0]))).toBe(true);
    expect(counts.verification_tokens).toBe(ROWS_PER_WRITE);
  });

  it("passes each sweep's result through as the entry's count", async () => {
    const { workerPrisma } = makeDispatchPrisma();
    const counts = await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: false });

    expect(counts.sessions).toBe(ROWS_PER_WRITE);
    expect(counts.mcp_access_tokens).toBe(ROWS_PER_WRITE);
  });

  it("an entry without globalDelete refuses an inherited bypass, logged with its own code", async () => {
    // Every transaction starts with app.bypass_rls already 'on', as if a
    // caller's bypass had reached it.
    const { workerPrisma } = makeDispatchPrisma({ inheritedBypass: "on" });
    const counts = await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: false });

    expect(counts.verification_tokens).toBe(-1);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "verification_tokens",
        code: "RETENTION_GC_BYPASS_STATE",
        _logType: "retention-gc.entry_failed",
      }),
      "retention-gc.entry_failed",
    );
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("a sweep's rejection propagates out of its transaction as -1 plus entry_failed", async () => {
    const { workerPrisma } = makeDispatchPrisma({ failDeleteOn: "sessions" });
    const counts = await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: false });

    expect(counts.sessions).toBe(-1);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ table: "sessions", code: "XX000", _logType: "retention-gc.entry_failed" }),
      "retention-gc.entry_failed",
    );
    expect(logError).toHaveBeenCalledTimes(1);
    expect(counts.verification_tokens).toBe(ROWS_PER_WRITE);
  });

  it("the heartbeat runs through the wrapper and writes under the bypass", async () => {
    const { workerPrisma, txs } = makeDispatchPrisma();
    await sweepOnce(workerPrisma, 100, { intervalMs: 1, emitHeartbeatAudit: true });

    const heartbeatTxs = txs.filter((t) =>
      t.calls.some(
        (c) =>
          c.name === "auditOutbox.create" &&
          (c.args[0] as { data: { tenantId: string } }).data.tenantId === SYSTEM_TENANT_ID,
      ),
    );
    expect(heartbeatTxs).toHaveLength(1);
    expect(setConfigCalls(heartbeatTxs[0])).toHaveLength(1);
    expect(heartbeatTxs[0].calls[0].name).toBe("$executeRaw");
    expect(logError).not.toHaveBeenCalled();
  });
});
