// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AutoLockProvider } from "./auto-lock-context";
import { VAULT_STATUS } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const ACTIVITY_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE;

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("AutoLockProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset here (not in test bodies) so a failing assertion cannot leak
    // document.hidden=true into the next test — teardown runs even on throw.
    setHidden(false);
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

    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Well past the former 5-minute hidden cap, but under the 15-min inactivity
    // threshold — a hidden tab must no longer relock early.
    act(() => {
      vi.advanceTimersByTime(6 * MS_PER_MINUTE);
    });
    expect(lock).not.toHaveBeenCalled();
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

    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    act(() => {
      vi.advanceTimersByTime(DEFAULT_INACTIVITY_TIMEOUT_MS + ACTIVITY_CHECK_INTERVAL_MS);
    });
    expect(lock).toHaveBeenCalled();
  });

  it("treats a fresh hidden → visible return as activity and does not lock", () => {
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
    // (under 60s so it has not aged out at the point of return).
    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(50_000); // 50s < 60s
    });
    expect(lock).not.toHaveBeenCalled();

    // Return to visible while still fresh: handleVisibility resets lastActivity
    // (does NOT lock, because the threshold was not exceeded).
    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lock).not.toHaveBeenCalled();

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

  it("locks on return if the threshold was exceeded while the interval was throttled/suspended", () => {
    // Background tabs have setInterval throttled or suspended, so checkInactivity
    // may never fire while hidden past the threshold. Advance the clock WITHOUT
    // firing timers (setSystemTime, not advanceTimersByTime) to reproduce that
    // gap, then return to visible. The vault must lock ON THE RETURN EVENT — not
    // treat the return as fresh activity (fail-open regression guard).
    const start = new Date("2026-07-08T00:00:00.000Z");
    vi.setSystemTime(start);

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

    // Hide the tab.
    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Move the clock 5 minutes forward WITHOUT firing the throttled interval.
    vi.setSystemTime(new Date(start.getTime() + 5 * MS_PER_MINUTE));
    expect(lock).not.toHaveBeenCalled(); // interval never ran while hidden

    // Return to visible: handleVisibility must lock synchronously on the event
    // (lock-first ordering), before any interval tick could run.
    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("applies a mid-session autoLockMinutes prop change on the next tick", () => {
    const lock = vi.fn();
    const { rerender } = render(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={10} // 10 minutes
      >
        <div />
      </AutoLockProvider>,
    );

    // Under the original 10-min threshold — no lock.
    act(() => {
      vi.advanceTimersByTime(2 * MS_PER_MINUTE);
    });
    expect(lock).not.toHaveBeenCalled();

    // Tenant lowers the policy to 1 minute mid-session.
    rerender(
      <AutoLockProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        lock={lock}
        autoLockMinutes={1}
      >
        <div />
      </AutoLockProvider>,
    );

    // Now 3 min of total inactivity exceeds the new 1-min threshold.
    act(() => {
      vi.advanceTimersByTime(1 * MS_PER_MINUTE);
    });
    expect(lock).toHaveBeenCalled();
  });
});
