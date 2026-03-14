// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRevealTimeout, useRevealSet } from "./use-reveal-timeout";
import type { RequireVerificationFn } from "./use-reveal-timeout";

const REVEAL_TIMEOUT_MS = 30_000;

// A requireVerification that always calls the callback immediately (no reprompt)
function makeImmediate(): RequireVerificationFn {
  return (_entryId, _requireReprompt, callback) => callback();
}

// A requireVerification that captures the callback for deferred invocation
function makeDeferred(): { fn: RequireVerificationFn; trigger: () => void } {
  let pending: (() => void) | null = null;
  return {
    fn: (_entryId, _requireReprompt, callback) => {
      pending = callback;
    },
    trigger: () => {
      pending?.();
      pending = null;
    },
  };
}

describe("useRevealTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveal/hide cycle: handleReveal → revealed=true → advance 30s → revealed=false", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealTimeout(requireVerification, "entry-1", false),
    );

    expect(result.current.revealed).toBe(false);

    act(() => result.current.handleReveal());
    expect(result.current.revealed).toBe(true);

    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(result.current.revealed).toBe(false);
  });

  it("unmount cleanup: handleReveal → unmount → clearTimeout called", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const requireVerification = makeImmediate();
    const { result, unmount } = renderHook(() =>
      useRevealTimeout(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleReveal());
    expect(result.current.revealed).toBe(true);

    clearSpy.mockClear();
    unmount();

    // clearTimeout must have been called during cleanup
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("rapid toggle: handleReveal twice → previous timer cleared", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealTimeout(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleReveal());

    clearSpy.mockClear();
    act(() => result.current.handleReveal());

    // The second call must clear the previous timer before setting a new one
    expect(clearSpy).toHaveBeenCalled();
    expect(result.current.revealed).toBe(true);

    // After 30s from the second call the reveal should expire
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(result.current.revealed).toBe(false);

    clearSpy.mockRestore();
  });

  it("hide(): handleReveal → hide() → revealed=false immediately", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealTimeout(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleReveal());
    expect(result.current.revealed).toBe(true);

    act(() => result.current.hide());
    expect(result.current.revealed).toBe(false);

    // Advancing time must not flip revealed back
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(result.current.revealed).toBe(false);
  });

  it("reference stability: handleReveal and hide are stable across re-renders", () => {
    const requireVerification = makeImmediate();
    const { result, rerender } = renderHook(() =>
      useRevealTimeout(requireVerification, "entry-1", false),
    );

    const handleReveal1 = result.current.handleReveal;
    const hide1 = result.current.hide;

    act(() => rerender());

    expect(result.current.handleReveal).toBe(handleReveal1);
    expect(result.current.hide).toBe(hide1);
  });

  it("requireReprompt=true path: callback is invoked when deferred trigger fires", () => {
    const deferred = makeDeferred();
    const { result } = renderHook(() =>
      useRevealTimeout(deferred.fn, "entry-1", true),
    );

    // Trigger the reveal — verification is pending, revealed stays false
    act(() => result.current.handleReveal());
    expect(result.current.revealed).toBe(false);

    // Simulate the user completing the re-prompt
    act(() => deferred.trigger());
    expect(result.current.revealed).toBe(true);

    // Timer still expires after 30s
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(result.current.revealed).toBe(false);
  });
});

describe("useRevealSet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("multi-index independence: reveal idx 0 and 2 → both visible → advance 30s → both expire", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleRevealIndex(0));
    act(() => result.current.handleRevealIndex(2));

    expect(result.current.isRevealed(0)).toBe(true);
    expect(result.current.isRevealed(2)).toBe(true);

    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));

    expect(result.current.isRevealed(0)).toBe(false);
    expect(result.current.isRevealed(2)).toBe(false);
  });

  it("staggered timers: idx 0 expires while idx 2 remains visible", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    // Reveal idx 0 first
    act(() => result.current.handleRevealIndex(0));
    expect(result.current.isRevealed(0)).toBe(true);

    // Advance 29s, then reveal idx 2
    act(() => vi.advanceTimersByTime(29_000));
    act(() => result.current.handleRevealIndex(2));
    expect(result.current.isRevealed(0)).toBe(true);
    expect(result.current.isRevealed(2)).toBe(true);

    // Advance 1s — idx 0 expires (30s total), idx 2 still has 29s left
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.isRevealed(0)).toBe(false);
    expect(result.current.isRevealed(2)).toBe(true);

    // Advance 29s — idx 2 expires
    act(() => vi.advanceTimersByTime(29_000));
    expect(result.current.isRevealed(2)).toBe(false);
  });

  it("stale-setTimeout prevention: reveal idx 0, hideIndex(0), reveal idx 0 again → timer resets", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    // First reveal
    act(() => result.current.handleRevealIndex(0));
    expect(result.current.isRevealed(0)).toBe(true);

    // Hide before timer fires
    act(() => result.current.hideIndex(0));
    expect(result.current.isRevealed(0)).toBe(false);

    // Advance partway — should NOT trigger any lingering timer
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.isRevealed(0)).toBe(false);

    // Reveal again — fresh 30s timer
    act(() => result.current.handleRevealIndex(0));
    expect(result.current.isRevealed(0)).toBe(true);

    // Advancing the full 30s must hide it
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(result.current.isRevealed(0)).toBe(false);
  });

  it("unmount clears all timers", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const requireVerification = makeImmediate();
    const { result, unmount } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleRevealIndex(0));
    act(() => result.current.handleRevealIndex(1));

    clearSpy.mockClear();
    unmount();

    // Both timers must be cleared
    expect(clearSpy).toHaveBeenCalledTimes(2);
    clearSpy.mockRestore();
  });

  it("hideIndex removes from set immediately", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleRevealIndex(3));
    expect(result.current.isRevealed(3)).toBe(true);

    act(() => result.current.hideIndex(3));
    expect(result.current.isRevealed(3)).toBe(false);
  });

  it("toggle: handleRevealIndex on already-revealed index → hides it", () => {
    const requireVerification = makeImmediate();
    const { result } = renderHook(() =>
      useRevealSet(requireVerification, "entry-1", false),
    );

    act(() => result.current.handleRevealIndex(1));
    expect(result.current.isRevealed(1)).toBe(true);

    // Second call on the same index acts as a toggle → hide
    act(() => result.current.handleRevealIndex(1));
    expect(result.current.isRevealed(1)).toBe(false);
  });
});
