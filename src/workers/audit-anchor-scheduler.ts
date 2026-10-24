/**
 * The audit-anchor publisher's scheduler: which boundary to publish, and when.
 *
 * The boundary is fixed when a timer is armed, not recomputed when it fires,
 * so a timer that fires early still publishes the boundary it was armed for.
 * The next timer is computed from the wall clock after each run (no
 * setInterval, which drifts and keeps firing on the old phase across a long
 * run). A failed run is retried for the same boundary until shortly before
 * the next one — a database outage at the boundary must not cost the day; the
 * publisher's persisted attempt count bounds how many of those reach the
 * destination.
 */
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { currentCadenceBoundary, type CadenceOutcome } from "@/workers/audit-anchor-publisher";

export const ANCHOR_RETRY_INTERVAL_MS = 15 * MS_PER_MINUTE;
/** No same-boundary retry is armed closer than this to the next boundary. */
export const ANCHOR_RETRY_STOP_BEFORE_NEXT_MS = 30 * MS_PER_MINUTE;

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

/** A failure the same boundary should be retried for, at any stage. */
function isRetryable(outcome: CadenceOutcome | null): boolean {
  return outcome === null || outcome.kind === "failed";
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

  function arm(at: number, boundary: Date): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      inFlight = runAndArm(boundary);
    }, Math.max(0, at - now()));
  }

  async function runAndArm(boundary: Date): Promise<void> {
    if (stopped) return;
    const outcome = await runOnce(boundary);
    if (stopped) return;

    const log = getLogger();
    const boundaryMs = boundary.getTime();
    const nextOfBoundary = boundaryMs + deps.cadenceMs;
    const retryAt = now() + retryIntervalMs;
    if (isRetryable(outcome) && retryAt <= nextOfBoundary - retryStopBeforeNextMs) {
      log.info(
        {
          boundary: boundary.toISOString(),
          retryAt: new Date(retryAt).toISOString(),
          _logType: "audit-anchor-publisher.retry_scheduled",
        },
        "audit-anchor-publisher.retry_scheduled",
      );
      arm(retryAt, boundary);
      return;
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
    arm(next.getTime(), next);
  }

  return {
    async start() {
      const boundary = currentCadenceBoundary(new Date(now()), deps.cadenceMs, deps.publishOffsetMs);
      inFlight = runAndArm(boundary);
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
