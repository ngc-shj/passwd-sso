/**
 * Unit tests for the publisher's boot and signal wiring, with every
 * collaborator injected: a run is a deferred promise the test settles, so the
 * order of stop, shutdown and exit is observed, not assumed.
 */
import { describe, it, expect, vi } from "vitest";
import { createPublisherLifecycle, type PublisherLifecycleDeps } from "./audit-anchor-publisher-lifecycle";
import type { AnchorScheduler } from "./audit-anchor-scheduler";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const BOOT_LINE = { level: "info", msg: "audit-anchor-publisher: cadence=24h", key: "audit-anchor-0123456789abcdef" };

function makeDeps(overrides: Partial<PublisherLifecycleDeps> = {}) {
  const events: string[] = [];
  const info: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const scheduler: AnchorScheduler = {
    start: vi.fn(async () => {
      events.push("start");
    }),
    stop: vi.fn(async () => {
      events.push("stop");
    }),
  };
  const deps: PublisherLifecycleDeps = {
    ensureDeploymentIdMatch: vi.fn(async () => {
      events.push("ensureDeploymentIdMatch");
    }),
    scheduler,
    shutdown: vi.fn(async () => {
      events.push("shutdown");
    }),
    exit: vi.fn((code: number) => {
      events.push(`exit(${code})`);
    }),
    log: {
      info: (line) => info.push(line),
      error: (line) => errors.push(line),
    },
    bootLine: BOOT_LINE,
    ...overrides,
  };
  return { deps, events, info, errors, scheduler };
}

describe("createPublisherLifecycle — boot", () => {
  it("starts the scheduler only after the deployment id matched, logging the boot line between", async () => {
    const { deps, events, info } = makeDeps();
    await createPublisherLifecycle(deps).boot();

    expect(events).toEqual(["ensureDeploymentIdMatch", "start"]);
    expect(info).toEqual([BOOT_LINE]);
  });

  it("exits 1 with boot_failed and never starts the scheduler when the deployment id check rejects", async () => {
    const { deps, events, errors, scheduler } = makeDeps({
      ensureDeploymentIdMatch: vi.fn(async () => {
        throw Object.assign(new Error("DEPLOYMENT_ID mismatch: expected=a, found=b"), { name: "DeploymentIdMismatchError" });
      }),
    });
    await createPublisherLifecycle(deps).boot();

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(events).toEqual(["exit(1)"]);
    expect(errors).toEqual([
      { level: "fatal", msg: "audit-anchor-publisher.boot_failed", error: { name: "DeploymentIdMismatchError", code: "unknown" } },
    ]);
  });
});

describe("createPublisherLifecycle — signals", () => {
  it("waits for an in-flight run before disconnecting, then exits 0", async () => {
    const run = deferred();
    const { deps, events, scheduler } = makeDeps();
    vi.mocked(scheduler.stop).mockImplementation(async () => {
      events.push("stop");
      await run.promise;
    });
    const lifecycle = createPublisherLifecycle(deps);
    await lifecycle.boot();

    lifecycle.handleSignal("SIGTERM");
    await settle();
    expect(deps.shutdown).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();

    run.resolve();
    await settle();
    expect(events.slice(2)).toEqual(["stop", "shutdown", "exit(0)"]);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
  });

  it("disconnects at once when nothing is in flight", async () => {
    const { deps, events, info } = makeDeps();
    const lifecycle = createPublisherLifecycle(deps);
    await lifecycle.boot();

    lifecycle.handleSignal("SIGINT");
    await settle();
    expect(events.slice(2)).toEqual(["stop", "shutdown", "exit(0)"]);
    expect(info.at(-1)).toEqual({ level: "info", msg: "audit-anchor-publisher.shutdown", signal: "SIGINT" });
  });

  it("ignores a second signal", async () => {
    const run = deferred();
    const { deps, scheduler, info } = makeDeps();
    vi.mocked(scheduler.stop).mockImplementation(() => run.promise);
    const lifecycle = createPublisherLifecycle(deps);
    await lifecycle.boot();

    lifecycle.handleSignal("SIGTERM");
    lifecycle.handleSignal("SIGTERM");
    lifecycle.handleSignal("SIGINT");
    run.resolve();
    await settle();

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(info.filter((l) => l.msg === "audit-anchor-publisher.shutdown")).toHaveLength(1);
  });

  it("exits 1 with shutdown_error when the disconnect rejects", async () => {
    const { deps, errors } = makeDeps({
      shutdown: vi.fn(async () => {
        throw Object.assign(new Error("pool end failed: postgresql://u:p@db/x"), { code: "57P01" });
      }),
    });
    const lifecycle = createPublisherLifecycle(deps);
    await lifecycle.boot();

    lifecycle.handleSignal("SIGTERM");
    await settle();

    expect(vi.mocked(deps.exit).mock.calls).toEqual([[1]]);
    expect(errors).toEqual([
      { level: "fatal", msg: "audit-anchor-publisher.shutdown_error", error: { name: "Error", code: "57P01" } },
    ]);
  });

  it("lets a boot run in flight finish before stopping, and exits 0", async () => {
    const firstRun = deferred();
    const { deps, events, scheduler } = makeDeps();
    vi.mocked(scheduler.start).mockImplementation(async () => {
      events.push("start");
      await firstRun.promise;
    });
    const lifecycle = createPublisherLifecycle(deps);
    const booting = lifecycle.boot();
    await settle();

    lifecycle.handleSignal("SIGTERM");
    await settle();
    expect(scheduler.stop).not.toHaveBeenCalled();
    expect(deps.shutdown).not.toHaveBeenCalled();

    firstRun.resolve();
    await booting;
    await settle();
    expect(events).toEqual(["ensureDeploymentIdMatch", "start", "stop", "shutdown", "exit(0)"]);
  });

  it("a signal during the deployment id check waits for it, starts nothing, and exits 0 without boot_failed", async () => {
    const check = deferred();
    const { deps, events, errors, scheduler } = makeDeps({
      ensureDeploymentIdMatch: vi.fn(() => check.promise),
    });
    const lifecycle = createPublisherLifecycle(deps);
    const booting = lifecycle.boot();
    await settle();

    lifecycle.handleSignal("SIGTERM");
    await settle();
    expect(deps.shutdown).not.toHaveBeenCalled();

    // The check fails because the shutdown is under way; that is not a boot failure.
    check.reject(new Error("Connection terminated"));
    await booting;
    await settle();

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(events).toEqual(["stop", "shutdown", "exit(0)"]);
    expect(errors).toEqual([]);
  });

  it("a signal during a deployment id check that then succeeds starts nothing and exits 0", async () => {
    const check = deferred();
    const { deps, events, info, scheduler } = makeDeps({
      ensureDeploymentIdMatch: vi.fn(() => check.promise),
    });
    const lifecycle = createPublisherLifecycle(deps);
    const booting = lifecycle.boot();
    await settle();

    lifecycle.handleSignal("SIGTERM");
    check.resolve();
    await booting;
    await settle();

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(events).toEqual(["stop", "shutdown", "exit(0)"]);
    expect(info).not.toContainEqual(BOOT_LINE);
  });
});
