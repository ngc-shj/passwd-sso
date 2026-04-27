import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from "vitest";

const errorSpy = vi.fn();

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: errorSpy }),
}));

import { createThrottledErrorLogger } from "@/lib/logger/throttled";

describe("createThrottledErrorLogger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    errorSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once per interval when called repeatedly", () => {
    const log = createThrottledErrorLogger(30_000, "M1");

    for (let i = 0; i < 5; i++) log();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({ code: "unknown" }, "M1");
  });

  it("fires again after the interval elapses", () => {
    const intervalMs = 30_000;
    const log = createThrottledErrorLogger(intervalMs, "M1");

    log();
    vi.advanceTimersByTime(intervalMs + 1);
    log();

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(1, { code: "unknown" }, "M1");
    expect(errorSpy).toHaveBeenNthCalledWith(2, { code: "unknown" }, "M1");
  });

  it("binds message at construction, not per call", () => {
    const intervalMs = 30_000;
    const logA = createThrottledErrorLogger(intervalMs, "MA");
    const logB = createThrottledErrorLogger(intervalMs, "MB");

    logA();
    vi.advanceTimersByTime(intervalMs + 1);
    logB();

    expect(errorSpy).toHaveBeenNthCalledWith(1, { code: "unknown" }, "MA");
    expect(errorSpy).toHaveBeenNthCalledWith(2, { code: "unknown" }, "MB");
  });

  it("returns a function with the documented signature", () => {
    const log = createThrottledErrorLogger(1_000, "M");
    expectTypeOf(log).toEqualTypeOf<(errCode?: string) => void>();
  });
});
