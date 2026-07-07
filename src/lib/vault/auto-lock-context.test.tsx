// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AutoLockProvider } from "./auto-lock-context";
import { VAULT_STATUS } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const ACTIVITY_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE;

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

  it("does not lock while hidden if below the inactivity threshold", () => {
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

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Well past the former 5-minute hidden cap, but under the 15-min inactivity
    // threshold — a hidden tab must no longer relock early.
    act(() => {
      vi.advanceTimersByTime(6 * MS_PER_MINUTE);
    });
    expect(lock).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("locks while hidden once the inactivity threshold (15 min) is exceeded", () => {
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

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    act(() => {
      vi.advanceTimersByTime(DEFAULT_INACTIVITY_TIMEOUT_MS + ACTIVITY_CHECK_INTERVAL_MS);
    });
    expect(lock).toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("resets activity on hidden → visible return, so it does not lock immediately", () => {
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

    // Hide, then let almost the full 1-minute threshold pass while hidden
    // (under 60s so it has not locked yet at the point of return).
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(50_000); // 50s < 60s
    });
    expect(lock).not.toHaveBeenCalled();

    // Return to visible: handleVisibility resets lastActivity.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 50s more: without the reset this would be 100s (>60s) and lock;
    // with the reset it is only 50s since return, so it must not lock.
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(lock).not.toHaveBeenCalled();

    // Past the full threshold measured from the return, it locks.
    act(() => {
      vi.advanceTimersByTime(20_000); // 70s since return > 60s
    });
    expect(lock).toHaveBeenCalled();
  });
});
