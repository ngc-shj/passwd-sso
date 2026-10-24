/**
 * The audit-anchor publisher's scheduler: which boundary to publish, and when.
 *
 * The boundary is fixed when a timer is armed, not recomputed when it fires.
 * A timer that fires before its deadline re-arms for the remainder instead of
 * running: a run for a boundary the wall clock has not reached would write a
 * marker ahead of the clock, which the next run fails closed on
 * (BOUNDARY_MARKER_AHEAD).
 * The next timer is computed from the wall clock after each run (no
 * setInterval, which drifts and keeps firing on the old phase across a long
 * run). A failed run, or one that found the publish lock held, is retried for
 * the same boundary, at most ANCHOR_MAX_RETRIES_PER_BOUNDARY times and never
 * closer than shortly before the next one — a database outage at the boundary
 * must not cost the day, and a lock holder that never publishes must not
 * either (when it does publish, the retry's marker re-check skips). The
 * publisher's persisted attempt count bounds how many runs reach the
 * destination across restarts; this in-process bound covers the failures that
 * stop before the count is written, which the persisted count never sees.
 */
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { currentCadenceBoundary, type CadenceOutcome } from "@/workers/audit-anchor-publisher";

export const ANCHOR_RETRY_INTERVAL_MS = 15 * MS_PER_MINUTE;
/** No same-boundary retry is armed closer than this to the next boundary. */
export const ANCHOR_RETRY_STOP_BEFORE_NEXT_MS = 30 * MS_PER_MINUTE;
/** Same-boundary retries after the first run, whatever the failure stage. */
export const ANCHOR_MAX_RETRIES_PER_BOUNDARY = 3;

export type TimerHandle = unknown;

export type AnchorSchedulerDeps = {
  runCadence: (boundary: Date) => Promise<CadenceOutcome>;
  cadenceMs: number;
  publishOffsetMs: number;
  /** Wall clock in epoch ms. Default `Date.now`. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  retryIntervalMs?: number;
  retryStopBeforeNextMs?: number;
};

export type AnchorScheduler = {
  /** Await one run for the current boundary, then keep the schedule armed. */
  start: () => Promise<void>;
  /** Stop arming and wait for an in-flight run. */
  stop: () => Promise<void>;
};

/** An outcome the same boundary should be retried for: a failure at any stage, or the lock held. */
function isRetryable(outcome: CadenceOutcome | null): boolean {
  return outcome === null || outcome.kind === "failed" || outcome.kind === "lock_held";
}

export function createAnchorScheduler(deps: AnchorSchedulerDeps): AnchorScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const retryIntervalMs = deps.retryIntervalMs ?? ANCHOR_RETRY_INTERVAL_MS;
  const retryStopBeforeNextMs = deps.retryStopBeforeNextMs ?? ANCHOR_RETRY_STOP_BEFORE_NEXT_MS;

  let stopped = false;
  let timer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;

  async function runOnce(boundary: Date): Promise<CadenceOutcome | null> {
    try {
      return await deps.runCadence(boundary);
    } catch (err) {
      // runCadence does not throw; this line exists for the case it does.
      getLogger().error(
        {
          boundary: boundary.toISOString(),
          error: errorLogFields(err),
          _logType: "audit-anchor-publisher.cadence_error",
        },
        "audit-anchor-publisher.cadence_error",
      );
      return null;
    }
  }

  function arm(at: number, boundary: Date, retries: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      if (now() < at) {
        arm(at, boundary, retries);
        return;
      }
      inFlight = runAndArm(boundary, retries);
    }, Math.max(0, at - now()));
  }

  /** `retries`: the same-boundary retries already run before this one. */
  async function runAndArm(boundary: Date, retries: number): Promise<void> {
    if (stopped) return;
    const outcome = await runOnce(boundary);
    if (stopped) return;

    const log = getLogger();
    const boundaryMs = boundary.getTime();
    const nextOfBoundary = boundaryMs + deps.cadenceMs;
    const retryAt = now() + retryIntervalMs;
    const retryable = isRetryable(outcome);
    const windowOpen = retryAt <= nextOfBoundary - retryStopBeforeNextMs;
    if (retryable && windowOpen && retries < ANCHOR_MAX_RETRIES_PER_BOUNDARY) {
      log.info(
        {
          boundary: boundary.toISOString(),
          retryAt: new Date(retryAt).toISOString(),
          _logType: "audit-anchor-publisher.retry_scheduled",
        },
        "audit-anchor-publisher.retry_scheduled",
      );
      arm(retryAt, boundary, retries + 1);
      return;
    }
    if (retryable) {
      log.warn(
        {
          boundary: boundary.toISOString(),
          retries,
          // The bound that stopped it: three retries used, or the next one
          // would land within the stop window before the next boundary.
          reason: retries >= ANCHOR_MAX_RETRIES_PER_BOUNDARY ? "count" : "window_closed",
          _logType: "audit-anchor-publisher.retries_exhausted",
        },
        "audit-anchor-publisher.retries_exhausted",
      );
    }

    // The boundary after the one just run, or after the wall clock's current
    // boundary when the run ended past that.
    const fromWallClock =
      currentCadenceBoundary(new Date(now()), deps.cadenceMs, deps.publishOffsetMs).getTime() + deps.cadenceMs;
    const next = new Date(Math.max(nextOfBoundary, fromWallClock));
    log.info(
      { boundary: next.toISOString(), _logType: "audit-anchor-publisher.next_scheduled" },
      "audit-anchor-publisher.next_scheduled",
    );
    arm(next.getTime(), next, 0);
  }

  return {
    async start() {
      const boundary = currentCadenceBoundary(new Date(now()), deps.cadenceMs, deps.publishOffsetMs);
      inFlight = runAndArm(boundary, 0);
      await inFlight;
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}
