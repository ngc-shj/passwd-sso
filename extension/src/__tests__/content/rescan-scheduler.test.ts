import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createRescanScheduler,
  ATTR_RESCAN_DELAY_MS,
  ATTR_RECENT_MS,
} from "../../content/rescan-scheduler";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRescanScheduler", () => {
  it("coalesces several noteAttributeChange calls within one window into a single rescan", () => {
    const rescan = vi.fn();
    const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

    scheduler.noteAttributeChange();
    scheduler.noteAttributeChange();
    scheduler.noteAttributeChange();
    vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("never re-arms the timer while one is already pending", () => {
    const rescan = vi.fn();
    const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

    scheduler.noteAttributeChange();
    vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS - 1);
    // A change noted just before the deadline must not push the deadline out.
    scheduler.noteAttributeChange();
    vi.advanceTimersByTime(1);

    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("runNow cancels a pending timer and runs immediately, without a second run at the original deadline", () => {
    const rescan = vi.fn();
    const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

    scheduler.noteAttributeChange();
    scheduler.runNow();
    expect(rescan).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("runNow runs even with nothing pending", () => {
    const rescan = vi.fn();
    const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

    scheduler.runNow();

    expect(rescan).toHaveBeenCalledTimes(1);
  });

  describe("flushForFocus", () => {
    it("runs and returns true when a rescan is pending", () => {
      const rescan = vi.fn();
      const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

      scheduler.noteAttributeChange();
      const flushed = scheduler.flushForFocus();

      expect(flushed).toBe(true);
      expect(rescan).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("runs and returns true when the last noted change is within recentMs of a timer that already fired", () => {
      const rescan = vi.fn();
      const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

      scheduler.noteAttributeChange();
      vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
      expect(rescan).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(ATTR_RECENT_MS - ATTR_RESCAN_DELAY_MS - 1);
      const flushed = scheduler.flushForFocus();

      expect(flushed).toBe(true);
      expect(rescan).toHaveBeenCalledTimes(2);
    });

    it("returns false and does not rescan when nothing is pending or recent", () => {
      const rescan = vi.fn();
      const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

      const flushed = scheduler.flushForFocus();

      expect(flushed).toBe(false);
      expect(rescan).not.toHaveBeenCalled();
    });

    it("returns false once the noted change falls outside recentMs", () => {
      const rescan = vi.fn();
      const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

      scheduler.noteAttributeChange();
      vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
      rescan.mockClear();
      vi.advanceTimersByTime(ATTR_RECENT_MS);

      const flushed = scheduler.flushForFocus();

      expect(flushed).toBe(false);
      expect(rescan).not.toHaveBeenCalled();
    });
  });

  it("cancel clears a pending timer so it never fires", () => {
    const rescan = vi.fn();
    const scheduler = createRescanScheduler(rescan, { delayMs: ATTR_RESCAN_DELAY_MS, recentMs: ATTR_RECENT_MS });

    scheduler.noteAttributeChange();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.cancel();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
    expect(rescan).not.toHaveBeenCalled();
  });
});
