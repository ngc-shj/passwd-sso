/**
 * Unit tests for the audit-anchor scheduler, driven by an injected clock and
 * timer: no real time passes, and every armed timer is inspected before it is
 * fired.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAnchorScheduler,
  ANCHOR_MAX_RETRIES_PER_BOUNDARY,
  ANCHOR_RETRY_INTERVAL_MS,
  ANCHOR_RETRY_STOP_BEFORE_NEXT_MS,
} from "./audit-anchor-scheduler";
import type { CadenceOutcome } from "./audit-anchor-publisher";

const { mockInfo, mockWarn, mockError } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: mockInfo, warn: mockWarn, error: mockError, debug: vi.fn() }),
}));

/** The fields of every line logged at `mock` with `_logType`. */
function linesOf(mock: ReturnType<typeof vi.fn>, logType: string): Array<Record<string, unknown>> {
  return mock.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((f) => f._logType === logType);
}

const EXHAUSTED = "audit-anchor-publisher.retries_exhausted";

const MINUTE = 60 * 1000;
const CADENCE_MS = 24 * 60 * MINUTE;
const OFFSET_MS = 5 * MINUTE;

const B0 = Date.parse("2026-01-15T00:05:00.000Z");
const B1 = B0 + CADENCE_MS;

const PUBLISHED: CadenceOutcome = {
  kind: "published",
  manifestSha256: "0".repeat(64),
  destinations: ["s3"],
  tenantsCount: 1,
  chainEnabledTenantCount: 1,
};
const UPLOAD_FAILED: CadenceOutcome = {
  kind: "failed",
  reason: "s3_UPLOAD_FAILED:unknown",
  stage: "upload",
  chainEnabledTenantCount: 1,
};
const COMMIT_FAILED: CadenceOutcome = {
  kind: "failed",
  reason: "COMMIT_FAILED_AFTER_UPLOAD:unknown",
  stage: "after_upload",
  chainEnabledTenantCount: 1,
};
const SIGNING_FAILED: CadenceOutcome = {
  kind: "failed",
  reason: "CADENCE_FAILED:unknown",
  stage: "before_upload",
  chainEnabledTenantCount: 1,
};
const LOCK_HELD: CadenceOutcome = { kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE", chainEnabledTenantCount: 1 };
const ALREADY_PUBLISHED: CadenceOutcome = {
  kind: "skipped_already_published",
  reason: "BOUNDARY_ALREADY_PUBLISHED",
  chainEnabledTenantCount: 1,
};

type FakeTimer = { at: number; fn: () => void; cleared: boolean };

function makeHarness(startMs: number) {
  let nowMs = startMs;
  const timers: FakeTimer[] = [];
  const runs: number[] = [];
  let outcomeFor: (boundaryMs: number, run: number) => CadenceOutcome | Promise<CadenceOutcome> = () => PUBLISHED;

  const scheduler = createAnchorScheduler({
    cadenceMs: CADENCE_MS,
    publishOffsetMs: OFFSET_MS,
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { at: nowMs + ms, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
    runCadence: async (boundary) => {
      runs.push(boundary.getTime());
      return outcomeFor(boundary.getTime(), runs.length);
    },
  });

  return {
    scheduler,
    runs,
    timers,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setOutcome: (fn: typeof outcomeFor) => {
      outcomeFor = fn;
    },
    /** The single live timer: the scheduler never holds two. */
    pending(): FakeTimer {
      const live = timers.filter((t) => !t.cleared);
      expect(live).toHaveLength(1);
      return live[0] as FakeTimer;
    },
    /** Fire the live timer at `atMs` (default: its own deadline) and let the run settle. */
    async fire(atMs?: number): Promise<void> {
      const timer = this.pending();
      timer.cleared = true;
      nowMs = atMs ?? timer.at;
      timer.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

describe("createAnchorScheduler", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
    h = makeHarness(B0 + 3 * 60 * MINUTE);
  });

  it("start() awaits one run for the current boundary before arming", async () => {
    await h.scheduler.start();

    expect(h.runs).toEqual([B0]);
    expect(h.pending().at).toBe(B1);
  });

  it("a timer firing 1 ms early still publishes the boundary it was armed for", async () => {
    await h.scheduler.start();
    await h.fire(B1 - 1);

    expect(h.runs).toEqual([B0, B1]);
    expect(h.pending().at).toBe(B1 + CADENCE_MS);
  });

  it("re-arms from the wall clock when a run ends past the next boundary", async () => {
    h.setOutcome(() => {
      h.setNow(B1 + 2 * 60 * MINUTE);
      return PUBLISHED;
    });
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1 + CADENCE_MS);
  });

  it("retries the same boundary every 15 min after an upload failure, at most three times", async () => {
    h.setNow(B0);
    h.setOutcome((boundaryMs) => (boundaryMs === B0 ? UPLOAD_FAILED : PUBLISHED));
    await h.scheduler.start();

    const armedAt: number[] = [];
    while (h.pending().at < B1) {
      armedAt.push(h.pending().at);
      await h.fire();
    }

    expect(ANCHOR_MAX_RETRIES_PER_BOUNDARY).toBe(3);
    expect(armedAt).toEqual([1, 2, 3].map((n) => B0 + n * ANCHOR_RETRY_INTERVAL_MS));
    expect(h.runs).toEqual([B0, B0, B0, B0]);
    expect(h.pending().at).toBe(B1);

    // The day after a failure, an early timer still publishes its boundary.
    await h.fire(B1 - 1);
    expect(h.runs.at(-1)).toBe(B1);
  });

  it("stops after three retries for a boundary when every run fails before the upload", async () => {
    // Such a failure never reaches the persisted attempt count, so this bound
    // is the only one on it.
    h.setOutcome(() => SIGNING_FAILED);
    await h.scheduler.start();

    while (h.pending().at < B1) await h.fire();

    expect(h.runs).toEqual([B0, B0, B0, B0]);
    expect(h.pending().at).toBe(B1);

    // The bound is per boundary: the next one gets its own three.
    await h.fire();
    while (h.pending().at < B1 + CADENCE_MS) await h.fire();
    expect(h.runs.filter((b) => b === B1)).toHaveLength(4);
  });

  it("retries the same boundary after a commit failure", async () => {
    h.setOutcome((_, run) => (run === 1 ? COMMIT_FAILED : PUBLISHED));
    await h.scheduler.start();

    const retry = h.pending();
    expect(retry.at).toBe(B0 + 3 * 60 * MINUTE + ANCHOR_RETRY_INTERVAL_MS);
    await h.fire();
    expect(h.runs).toEqual([B0, B0]);
    expect(h.pending().at).toBe(B1);
  });

  it("retries the same boundary after a failure before the upload", async () => {
    // A database outage at the boundary fails before the upload; it must not
    // cost the day. The persisted attempt count bounds a deterministic one.
    h.setOutcome((_, run) => (run === 1 ? SIGNING_FAILED : PUBLISHED));
    await h.scheduler.start();

    expect(h.pending().at).toBe(B0 + 3 * 60 * MINUTE + ANCHOR_RETRY_INTERVAL_MS);
    await h.fire();
    expect(h.runs).toEqual([B0, B0]);
    expect(h.pending().at).toBe(B1);
  });

  it("does not retry upload_cap_reached", async () => {
    h.setOutcome(() => ({ kind: "upload_cap_reached", reason: "UPLOAD_ATTEMPT_CAP_REACHED", attempts: 4, chainEnabledTenantCount: 1 }));
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([]);
  });

  it("retries lock_held for the same boundary, and the marker re-check ends it when the holder published", async () => {
    h.setOutcome((_, run) => (run === 1 ? LOCK_HELD : ALREADY_PUBLISHED));
    await h.scheduler.start();

    expect(h.pending().at).toBe(B0 + 3 * 60 * MINUTE + ANCHOR_RETRY_INTERVAL_MS);
    await h.fire();
    expect(h.runs).toEqual([B0, B0]);
    expect(h.pending().at).toBe(B1);
  });

  it("bounds lock_held retries by the same per-process count", async () => {
    h.setOutcome(() => LOCK_HELD);
    await h.scheduler.start();

    while (h.pending().at < B1) await h.fire();
    expect(h.runs).toEqual([B0, B0, B0, B0]);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([
      expect.objectContaining({ boundary: new Date(B0).toISOString(), retries: 3, reason: "count" }),
    ]);
  });

  it("arms no retry when the next one would land within 30 min of the next boundary, and says so", async () => {
    h.setNow(B1 - 40 * MINUTE);
    h.setOutcome(() => UPLOAD_FAILED);
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([
      { boundary: new Date(B0).toISOString(), retries: 0, reason: "window_closed", _logType: EXHAUSTED },
    ]);
  });

  it("admits a retry landing exactly 30 min before the next boundary, and none after it", async () => {
    // Started 45 min before B1: the first retry lands at B1 - 30 min, which
    // the stop window admits (equal); the one after would land at B1 - 15 min.
    expect(ANCHOR_RETRY_STOP_BEFORE_NEXT_MS).toBe(30 * MINUTE);
    h.setNow(B1 - 45 * MINUTE);
    h.setOutcome(() => UPLOAD_FAILED);
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1 - 30 * MINUTE);
    await h.fire();
    expect(h.runs).toEqual([B0, B0]);
    expect(h.pending().at).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([expect.objectContaining({ retries: 1, reason: "window_closed" })]);
  });

  it("arms no retry when started 1 ms later, 44:59.999 before the next boundary", async () => {
    h.setNow(B1 - 45 * MINUTE + 1);
    h.setOutcome(() => UPLOAD_FAILED);
    await h.scheduler.start();

    expect(h.runs).toEqual([B0]);
    expect(h.pending().at).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([expect.objectContaining({ retries: 0, reason: "window_closed" })]);
  });

  it("reports count, not window_closed, when the third retry uses up the count as the window closes", async () => {
    // Started 75 min before B1: retries at B1 - 60, - 45 and - 30 min. After
    // the third, both bounds stop a fourth (it would land at B1 - 15 min); the
    // count is the one named.
    h.setNow(B1 - 75 * MINUTE);
    h.setOutcome(() => SIGNING_FAILED);
    await h.scheduler.start();

    for (const minutesBefore of [60, 45, 30]) {
      expect(h.pending().at).toBe(B1 - minutesBefore * MINUTE);
      await h.fire();
    }
    expect(h.runs).toEqual([B0, B0, B0, B0]);
    expect(h.pending().at).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([
      { boundary: new Date(B0).toISOString(), retries: 3, reason: "count", _logType: EXHAUSTED },
    ]);
  });

  it("warns retries_exhausted exactly once, after the third retry, and never on a publishing run", async () => {
    h.setOutcome((boundaryMs) => (boundaryMs === B0 ? SIGNING_FAILED : PUBLISHED));
    await h.scheduler.start();

    for (let retry = 1; retry <= ANCHOR_MAX_RETRIES_PER_BOUNDARY; retry++) {
      expect(linesOf(mockWarn, EXHAUSTED)).toEqual([]);
      await h.fire();
    }
    expect(linesOf(mockWarn, EXHAUSTED)).toEqual([
      { boundary: new Date(B0).toISOString(), retries: 3, reason: "count", _logType: EXHAUSTED },
    ]);

    // B1 publishes: no further warn.
    await h.fire();
    expect(h.runs.at(-1)).toBe(B1);
    expect(linesOf(mockWarn, EXHAUSTED)).toHaveLength(1);
  });

  it("retries a throwing runCadence at +15 min and logs one cadence_error line", async () => {
    const armed: number[] = [];
    const throwing = createAnchorScheduler({
      cadenceMs: CADENCE_MS,
      publishOffsetMs: OFFSET_MS,
      now: () => B0 + 3 * 60 * MINUTE,
      setTimer: (fn, ms) => {
        armed.push(ms);
        return null;
      },
      clearTimer: () => undefined,
      runCadence: async () => {
        throw new Error("unexpected");
      },
    });
    await throwing.start();

    expect(armed).toEqual([ANCHOR_RETRY_INTERVAL_MS]);
    expect(linesOf(mockError, "audit-anchor-publisher.cadence_error")).toEqual([
      { boundary: new Date(B0).toISOString(), error: { name: "Error", code: "unknown" }, _logType: "audit-anchor-publisher.cadence_error" },
    ]);
    await throwing.stop();
  });

  it("stop() waits for the in-flight run and arms nothing after it", async () => {
    let release: (outcome: CadenceOutcome) => void = () => {};
    h.setOutcome(() => new Promise<CadenceOutcome>((resolve) => {
      release = resolve;
    }));
    const started = h.scheduler.start();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    let stopped = false;
    const stopping = h.scheduler.stop().then(() => {
      stopped = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(stopped).toBe(false);

    release(PUBLISHED);
    await stopping;
    await started;
    expect(stopped).toBe(true);
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
  });

  it("stop() clears an armed timer", async () => {
    await h.scheduler.start();
    const timer = h.pending();
    await h.scheduler.stop();

    expect(timer.cleared).toBe(true);
    expect(h.runs).toEqual([B0]);
  });
});
