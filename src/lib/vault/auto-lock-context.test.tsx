// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AutoLockProvider } from "./auto-lock-context";
import { VAULT_STATUS } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const ACTIVITY_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE;
const DEFAULT_HIDDEN_TIMEOUT_MS = 5 * MS_PER_MINUTE;

describe("AutoLockProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call lock before the inactivity threshold", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={null}
      >
        <div />
      </AutoLockProvider>,
    );

    // Advance well under the 15-minute default — interval fires several times
    act(() => {
      vi.advanceTimersByTime(ACTIVITY_CHECK_INTERVAL_MS * 5);
    });
    expect(lock).not.toHaveBeenCalled();
  });

  it("locks when inactivity exceeds the default timeout (15 min)", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={null}
      >
        <div />
      </AutoLockProvider>,
    );

    // Push timer past the default 15-minute inactivity window
    act(() => {
      vi.advanceTimersByTime(DEFAULT_INACTIVITY_TIMEOUT_MS + ACTIVITY_CHECK_INTERVAL_MS);
    });
    expect(lock).toHaveBeenCalled();
  });

  it("uses tenant-configured autoLockMinutes when provided", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={1} // 1 minute
      >
        <div />
      </AutoLockProvider>,
    );

    // 1-minute timeout — at 30s no lock yet
    act(() => {
      vi.advanceTimersByTime(ACTIVITY_CHECK_INTERVAL_MS); // 30s
    });
    expect(lock).not.toHaveBeenCalled();

    // After 90s total — past 1-minute threshold
    act(() => {
      vi.advanceTimersByTime(ACTIVITY_CHECK_INTERVAL_MS * 2); // +60s
    });
    expect(lock).toHaveBeenCalled();
  });

  it("resets the inactivity timer on user activity (mousemove)", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={1}
      >
        <div />
      </AutoLockProvider>,
    );

    // Sim 50s of inactivity (under 60s)
    act(() => {
      vi.advanceTimersByTime(50_000);
    });

    // User activity resets timer
    act(() => {
      window.dispatchEvent(new Event("mousemove"));
    });

    // Another 50s — still under 60s from last activity
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(lock).not.toHaveBeenCalled();

    // Another 30s — now over 60s since last activity
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(lock).toHaveBeenCalled();
  });

  it("resets the inactivity timer on keydown", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={1}
      >
        <div />
      </AutoLockProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(lock).not.toHaveBeenCalled();
  });

  it("does not register listeners or run timer when vault is LOCKED", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.LOCKED}
        lock={lock}
        autoLockMinutes={null}
      >
        <div />
      </AutoLockProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(DEFAULT_INACTIVITY_TIMEOUT_MS * 2);
    });
    expect(lock).not.toHaveBeenCalled();
  });

  it("cleans up listeners and timer on unmount", () => {
    const lock = vi.fn();
    const removeWindowSpy = vi.spyOn(window, "removeEventListener");
    const removeDocSpy = vi.spyOn(document, "removeEventListener");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={null}
      >
        <div />
      </AutoLockProvider>,
    );

    unmount();

    // Verify cleanup occurred for the activity listener set
    expect(removeWindowSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
    expect(removeWindowSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeWindowSpy).toHaveBeenCalledWith("click", expect.any(Function));
    expect(removeDocSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(clearIntervalSpy).toHaveBeenCalled();

    // After unmount, advancing timers must not lock
    act(() => {
      vi.advanceTimersByTime(DEFAULT_INACTIVITY_TIMEOUT_MS * 2);
    });
    expect(lock).not.toHaveBeenCalled();

    removeWindowSpy.mockRestore();
    removeDocSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("locks when tab stays hidden longer than the hidden-timeout (5 min default)", () => {
    const lock = vi.fn();
    render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={null}
      >
        <div />
      </AutoLockProvider>,
    );

    // Mark document hidden
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Advance past 5-minute hidden timeout
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HIDDEN_TIMEOUT_MS + ACTIVITY_CHECK_INTERVAL_MS);
    });
    expect(lock).toHaveBeenCalled();

    // Restore visibility for other tests
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
});
