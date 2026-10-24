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
} from "./audit-anchor-scheduler";
import type { CadenceOutcome } from "./audit-anchor-publisher";

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

  it.each<CadenceOutcome>([
    { kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE", chainEnabledTenantCount: 1 },
    { kind: "upload_cap_reached", reason: "UPLOAD_ATTEMPT_CAP_REACHED", attempts: 4, chainEnabledTenantCount: 1 },
  ])("does not retry $kind", async (outcome) => {
    h.setOutcome(() => outcome);
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1);
  });

  it("arms no retry when the next one would land within 30 min of the next boundary", async () => {
    h.setNow(B1 - 40 * MINUTE);
    h.setOutcome(() => UPLOAD_FAILED);
    await h.scheduler.start();

    expect(h.pending().at).toBe(B1);
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
