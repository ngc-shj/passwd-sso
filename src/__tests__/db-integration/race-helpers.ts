/**
 * Deterministic race helpers for real-DB integration tests.
 *
 * A race is made deterministic by parking one side mid-transaction on a row
 * lock that only a test-held "blocker" transaction holds, running the other
 * side, and observing through pg_blocking_pids whether it ran through or waited
 * on the parked side — no fixed sleeps. Used by
 * team-key-version-guard.integration.test.ts and
 * team-tenant-departure.integration.test.ts.
 */
import type { Pool, PoolClient } from "pg";

export const BLOCK_WAIT_MS = 10_000;

export type HeldLock = { pid: number; release: () => Promise<void> };

export function createRaceHelpers(pool: Pool) {
  /** Open a transaction holding `lockSql` until `release()`; returns its backend pid. */
  async function holdRowLock(lockSql: string, params: unknown[]): Promise<HeldLock> {
    const client: PoolClient = await pool.connect();
    let pid: number;
    try {
      await client.query("BEGIN");
      await client.query(lockSql, params);
      ({ rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }
    let released = false;
    return {
      pid,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      },
    };
  }

  /**
   * Hold `lockSql` in a blocker transaction, start `send`, wait until it parks
   * on the blocker, run `whileParked` (assertions on the parked backend, the
   * blocker's own writes), then commit and return what `send` resolved to.
   *
   * Failure-safe: when anything throws before the commit, the blocker rolls
   * back and is released, the parked request is let run to completion, and
   * the original error is rethrown — a failing cell leaves no open
   * transaction for the next cells to time out on.
   */
  async function parkBehind<T>(
    lockSql: string,
    params: unknown[],
    send: () => Promise<T>,
    whileParked: (blocker: PoolClient, parkedPid: number) => Promise<void> = async () => {},
  ): Promise<T> {
    const client: PoolClient = await pool.connect();
    let committed = false;
    let pending: Promise<T> | undefined;
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(lockSql, params);
      const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pending = send();
      // Handled here so a rejection while parked is not reported as
      // unhandled; awaiting `pending` below still rejects.
      pending.catch(() => {});
      const parkedPid = await waitForBackendBlockedBy(pid);
      await whileParked(client, parkedPid);
      await client.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) {
        await client.query("ROLLBACK").catch((e: unknown) => {
          broken = e instanceof Error ? e : new Error(String(e));
        });
      }
      // A connection whose ROLLBACK failed is destroyed, not reused.
      client.release(broken);
      if (!committed && pending) await pending.catch(() => {});
    }
  }

  /** The query a backend is waiting in (its first ungranted lock). */
  async function waitingQueryOf(pid: number): Promise<string | undefined> {
    const r = await pool.query<{ query: string }>(
      `SELECT a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.pid = $1 AND NOT l.granted`,
      [pid],
    );
    return r.rows[0]?.query;
  }

  async function backendsBlockedBy(pid: number): Promise<number[]> {
    const r = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [pid],
    );
    return r.rows.map((row) => row.pid);
  }

  /** Resolve with the first backend observed waiting on `pid`'s locks. */
  async function waitForBackendBlockedBy(pid: number, except: readonly number[] = []): Promise<number> {
    const deadline = Date.now() + BLOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const blocked = (await backendsBlockedBy(pid)).find((p) => !except.includes(p));
      if (blocked !== undefined) return blocked;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`no backend blocked on pid ${pid} within ${BLOCK_WAIT_MS}ms`);
  }

  /**
   * Wait until `work` settles or waits on `parkedPid`, and say which. The
   * guarded write waits on the parked transaction; an unguarded one runs
   * through ("settled"). A write that instead waits on the blocker (which then
   * blocks two backends) never reached the race at all, so that throws,
   * naming what it waited in.
   */
  async function settledOrBlocked(
    work: Promise<unknown>,
    parkedPid: number,
    blockerPid: number,
  ): Promise<"settled" | "blocked-on-parked"> {
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + BLOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (settled) return "settled";
      if ((await backendsBlockedBy(parkedPid)).length > 0) return "blocked-on-parked";
      const onBlocker = (await backendsBlockedBy(blockerPid)).filter((pid) => pid !== parkedPid);
      if (onBlocker.length > 0) {
        const r = await pool.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity WHERE pid = $1`,
          [onBlocker[0]],
        );
        throw new Error(`write waited on the blocker, not the parked transaction: ${r.rows[0]?.query}`);
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`work neither settled nor blocked on pid ${parkedPid} within ${BLOCK_WAIT_MS}ms`);
  }

  return { holdRowLock, parkBehind, waitingQueryOf, backendsBlockedBy, waitForBackendBlockedBy, settledOrBlocked };
}
