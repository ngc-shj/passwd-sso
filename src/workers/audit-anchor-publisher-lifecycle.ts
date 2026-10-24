/**
 * The audit-anchor publisher's boot and signal wiring, injectable so the
 * ordering it promises is testable without a process: a signal lets an
 * in-flight run finish before the database is disconnected, and a signal that
 * arrives during boot waits for the boot to settle and exits 0 — the boot's
 * own failure is then not reported as `boot_failed`, since the shutdown is
 * what ended it.
 */
import { errorLogFields } from "@/lib/logger/error-fields";
import type { AnchorScheduler } from "@/workers/audit-anchor-scheduler";

/** One JSON line; the script prints `info` to stdout and `error` to stderr. */
export type LifecycleLog = {
  info: (line: Record<string, unknown>) => void;
  error: (line: Record<string, unknown>) => void;
};

export type PublisherLifecycleDeps = {
  ensureDeploymentIdMatch: () => Promise<void>;
  scheduler: AnchorScheduler;
  /** Disconnect the database. */
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  log: LifecycleLog;
  /** Logged once the deployment id matched, before the first run. */
  bootLine: Record<string, unknown>;
};

export type PublisherLifecycle = {
  /** Never rejects: a failure is logged as `boot_failed` and exits 1. */
  boot: () => Promise<void>;
  handleSignal: (signal: string) => void;
};

export function createPublisherLifecycle(deps: PublisherLifecycleDeps): PublisherLifecycle {
  let shuttingDown = false;
  let booting: Promise<void> | null = null;

  async function bootSteps(): Promise<void> {
    await deps.ensureDeploymentIdMatch();
    if (shuttingDown) return;
    deps.log.info(deps.bootLine);
    // One run for the current boundary, then the schedule stays armed.
    await deps.scheduler.start();
  }

  return {
    async boot() {
      booting = bootSteps();
      try {
        await booting;
      } catch (err) {
        // The signal handler owns the exit once a shutdown began.
        if (shuttingDown) return;
        deps.log.error({
          level: "fatal",
          msg: "audit-anchor-publisher.boot_failed",
          // errorLogFields, not a top-level `code` read or the message: a
          // Prisma raw-query failure carries the driver's SQLSTATE nested
          // underneath a P2010, and a message can carry a connection target.
          error: errorLogFields(err),
        });
        deps.exit(1);
      }
    },

    handleSignal(signal) {
      if (shuttingDown) return;
      shuttingDown = true;

      deps.log.info({ level: "info", msg: "audit-anchor-publisher.shutdown", signal });

      // A boot still running settles first: disconnecting under it would fail
      // its transaction. Then stop arming and let an in-flight run finish
      // before disconnecting.
      const bootSettled = booting === null ? Promise.resolve() : booting.then(() => undefined, () => undefined);
      bootSettled
        .then(() => deps.scheduler.stop())
        .then(() => deps.shutdown())
        .then(() => {
          deps.exit(0);
        })
        .catch((err: unknown) => {
          deps.log.error({
            level: "fatal",
            msg: "audit-anchor-publisher.shutdown_error",
            error: errorLogFields(err),
          });
          deps.exit(1);
        });
    },
  };
}
