/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
  MESSAGE_AUTO_DISMISS_MS,
  type DropdownOptions,
} from "../../../content/ui/suggestion-dropdown";
import { getShadowHost } from "../../../content/ui/shadow-host";
import { EXT_ENTRY_TYPE } from "../../../lib/constants";

// Mock chrome.runtime
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn(),
    lastError: null,
  },
  i18n: {
    getUILanguage: () => "en",
  },
});

function makeAnchorRect(): DOMRect {
  return {
    top: 100,
    left: 50,
    bottom: 130,
    right: 250,
    width: 200,
    height: 30,
    x: 50,
    y: 100,
    toJSON: () => ({}),
  };
}

function makeOptions(overrides?: Partial<DropdownOptions>): DropdownOptions {
  return {
    anchorRect: makeAnchorRect(),
    entries: [
      { id: "1", title: "Example", username: "alice", urlHost: "example.com", entryType: EXT_ENTRY_TYPE.LOGIN },
      { id: "2", title: "Test", username: "bob", urlHost: "test.com", entryType: EXT_ENTRY_TYPE.LOGIN },
    ],
    vaultLocked: false,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    lockedMessage: "Vault is locked",
    disconnectedMessage: "Not connected",
    noMatchesMessage: "No matches",
    headerLabel: "Logins",
    ...overrides,
  };
}

// jsdom sets Event.isTrusted as a non-configurable own property (false by default).
// Object.defineProperty cannot override it, so use a Proxy to intercept isTrusted
// reads. The self-assert below fails loudly if a future jsdom breaks the Proxy —
// otherwise the trusted-path tests would silently exercise the untrusted path and
// pass for the wrong reason.
const trustedKeydown = (key: string): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true });
  const proxied = new Proxy(e, {
    get(target, prop, receiver) {
      if (prop === "isTrusted") return true;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as KeyboardEvent;
  if (!proxied.isTrusted) throw new Error("trustedKeydown: isTrusted override failed");
  return proxied;
};

// The three message-only render states, by the option that selects each branch.
const MESSAGE_STATES: ReadonlyArray<[string, Partial<DropdownOptions>]> = [
  ["disconnected", { disconnected: true }],
  ["vaultLocked", { vaultLocked: true }],
  ["no matches", { entries: [] }],
];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  // File-level, unconditional, and before hideDropdown(): a describe-scoped
  // useRealTimers() leaks the fake clock into later tests when an auto-dismiss test
  // FAILS, turning one real failure into a cascade across the other blocks.
  vi.useRealTimers();
  hideDropdown();
  document.body.innerHTML = "";
});

describe("showDropdown", () => {
  it("creates a shadow host and renders entries", () => {
    showDropdown(makeOptions());
    expect(isDropdownVisible()).toBe(true);

    const host = document.querySelector("[data-passwd-sso-shadow-host]");
    expect(host).not.toBeNull();
  });

  it("renders locked message when vault is locked", () => {
    const opts = makeOptions({ vaultLocked: true });
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);
  });

  it("renders no matches message when entries is empty", () => {
    const opts = makeOptions({ entries: [] });
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);
  });
});

describe("hideDropdown", () => {
  it("removes the dropdown and calls onDismiss", () => {
    const opts = makeOptions();
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);

    hideDropdown();
    expect(isDropdownVisible()).toBe(false);
    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  it("is safe to call when no dropdown is shown", () => {
    expect(() => hideDropdown()).not.toThrow();
  });
});

describe("handleDropdownKeydown", () => {
  it("returns false when no dropdown is shown", () => {
    const e = new KeyboardEvent("keydown", { key: "ArrowDown" });
    expect(handleDropdownKeydown(e)).toBe(false);
  });

  it("navigates down with ArrowDown", () => {
    showDropdown(makeOptions());
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    const handled = handleDropdownKeydown(e);
    expect(handled).toBe(true);
  });

  it("navigates up with ArrowUp", () => {
    showDropdown(makeOptions());
    // First go down, then up
    handleDropdownKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    const e = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
    const handled = handleDropdownKeydown(e);
    expect(handled).toBe(true);
  });

  // T4: the entries-axis half of the RT10 pair. Pre-existing coverage — kept
  // unchanged to confirm the guard restructure did not regress the entries path.
  it("dismisses with Escape", () => {
    const opts = makeOptions();
    showDropdown(opts);
    const handled = handleDropdownKeydown(trustedKeydown("Escape"));
    expect(handled).toBe(true);
    expect(isDropdownVisible()).toBe(false);
  });

  it("selects active item with Enter", () => {
    const opts = makeOptions();
    showDropdown(opts);
    handleDropdownKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    const handled = handleDropdownKeydown(trustedKeydown("Enter"));
    expect(handled).toBe(true);
    expect(opts.onSelect).toHaveBeenCalledWith("1", undefined);
  });

  it("does NOT select on a synthetic (untrusted) Enter — blocks scripted exfiltration", () => {
    const opts = makeOptions();
    showDropdown(opts);
    handleDropdownKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    const handled = handleDropdownKeydown(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true }), // isTrusted=false
    );
    expect(handled).toBe(false);
    expect(opts.onSelect).not.toHaveBeenCalled();
  });
});

describe("Escape in message-only states", () => {
  // T1-T3. These are the states the guard used to swallow Escape in: nothing to
  // navigate, so itemElements is empty and the old length check returned early.
  it.each(MESSAGE_STATES)("dismisses with Escape when %s", (_label, overrides) => {
    const opts = makeOptions(overrides);
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);

    const handled = handleDropdownKeydown(trustedKeydown("Escape"));

    expect(handled).toBe(true);
    expect(isDropdownVisible()).toBe(false);
    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  // T15. Escape must deny synthetic events like Enter and the mouse path do,
  // so a page cannot suppress the notice or read defaultPrevented as a state oracle.
  it.each(MESSAGE_STATES)(
    "ignores a synthetic (untrusted) Escape when %s, leaving defaultPrevented false",
    (_label, overrides) => {
      const opts = makeOptions(overrides);
      showDropdown(opts);

      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      const handled = handleDropdownKeydown(e);

      expect(handled).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(isDropdownVisible()).toBe(true);
      expect(opts.onDismiss).not.toHaveBeenCalled();
    },
  );

  it("ignores a synthetic Escape in the entries state too", () => {
    const opts = makeOptions();
    showDropdown(opts);

    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

    expect(handleDropdownKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(isDropdownVisible()).toBe(true);
  });

  // T5. Asserting the return value alone cannot tell "fell through untouched" from
  // "handled, then returned false" — defaultPrevented is what distinguishes them.
  it.each(MESSAGE_STATES)("leaves ArrowDown unhandled when %s", (_label, overrides) => {
    showDropdown(makeOptions(overrides));

    const e = trustedKeydown("ArrowDown");

    expect(handleDropdownKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(isDropdownVisible()).toBe(true);
  });

  it.each(MESSAGE_STATES)("leaves ArrowUp unhandled when %s", (_label, overrides) => {
    showDropdown(makeOptions(overrides));

    const e = trustedKeydown("ArrowUp");

    expect(handleDropdownKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  // T7. Escape becoming reachable must not make it reachable with nothing on screen.
  it("returns false for Escape when no dropdown is shown", () => {
    const e = trustedKeydown("Escape");

    expect(handleDropdownKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("message-only auto-dismiss", () => {
  // The timing tests below derive their boundary from MESSAGE_AUTO_DISMISS_MS so
  // they never drift from the shipped value — which means they alone cannot detect
  // the constant being changed. This pins the value itself: long enough to read the
  // notice, short enough not to be the nuisance the timer exists to remove.
  it("dismisses after 5 seconds", () => {
    expect(MESSAGE_AUTO_DISMISS_MS).toBe(5000);
  });

  // rAF is on vitest's default fake-timer set, so a bare useFakeTimers() would let
  // advanceTimersByTime install the real outside-click handler mid-test. Faking only
  // the timeout pair keeps these tests exercising the timer path and nothing else.
  const useTimeoutOnlyFakeTimers = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

  // Pins the toFake list above. With a bare useFakeTimers(), vitest also fakes rAF,
  // so advancing the clock would run showDropdown's pending frame and install the
  // outside-click listener mid-test — leaving these tests exercising a dismissal
  // path they never meant to involve.
  it("does not install the outside-click listener while the clock advances", () => {
    useTimeoutOnlyFakeTimers();
    const addSpy = vi.spyOn(document, "addEventListener");

    showDropdown(makeOptions({ vaultLocked: true }));
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    const mousedownInstalls = addSpy.mock.calls.filter(
      ([type, , capture]) => type === "mousedown" && capture === true,
    );
    expect(mousedownInstalls).toHaveLength(0);
    addSpy.mockRestore();
  });

  // Chrome pauses rAF in a background tab but keeps timers running, so the
  // auto-dismiss routinely beats the pending frame. Faking setTimeout while leaving
  // rAF real reproduces exactly that ordering.
  it("does not strand a document listener when the dismissal beats the pending frame", () => {
    useTimeoutOnlyFakeTimers();
    const addSpy = vi.spyOn(document, "addEventListener");
    const mousedownInstalls = () =>
      addSpy.mock.calls.filter(([type, , capture]) => type === "mousedown" && capture === true);

    showDropdown(makeOptions({ vaultLocked: true }));
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);
    expect(isDropdownVisible()).toBe(false);

    // Tab becomes visible again: any surviving frame callback would run here.
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve())).then(() => {
      expect(mousedownInstalls()).toHaveLength(0);
      addSpy.mockRestore();
    });
  });

  // The allow side of the same guard: when the frame does run first, the listener
  // must still be installed — the cancellation must not disable outside-click.
  it("still installs the outside-click listener when the frame runs first", () => {
    const addSpy = vi.spyOn(document, "addEventListener");

    showDropdown(makeOptions({ vaultLocked: true }));

    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve())).then(() => {
      const installs = addSpy.mock.calls.filter(
        ([type, , capture]) => type === "mousedown" && capture === true,
      );
      expect(installs).toHaveLength(1);
      addSpy.mockRestore();
    });
  });

  // T8.
  it.each(MESSAGE_STATES)("dismisses %s after the interval", (_label, overrides) => {
    useTimeoutOnlyFakeTimers();
    const opts = makeOptions(overrides);
    showDropdown(opts);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(isDropdownVisible()).toBe(false);
    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  // A notice the user never saw has not been read. These three states are the only
  // in-page signal that a dropdown is genuinely ours, so expiring one behind a
  // background tab would silently remove the warning a look-alike has to compete with.
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it.each(MESSAGE_STATES)("does not expire %s while the tab is hidden", (_label, overrides) => {
    useTimeoutOnlyFakeTimers();
    const opts = makeOptions(overrides);
    showDropdown(opts);

    vi.advanceTimersByTime(1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS * 10);

    expect(isDropdownVisible()).toBe(true);
    expect(opts.onDismiss).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(isDropdownVisible()).toBe(true);

    // Only the 1000 ms seen before hiding counts, so the remainder is still owed.
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS - 1000 - 1);
    expect(isDropdownVisible()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isDropdownVisible()).toBe(false);
    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  it("stops watching visibility once dismissed", () => {
    useTimeoutOnlyFakeTimers();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    showDropdown(makeOptions({ vaultLocked: true }));
    hideDropdown();

    expect(
      removeSpy.mock.calls.filter(([type]) => type === "visibilitychange"),
    ).toHaveLength(1);

    // A later visibility change must not resurrect a timer for a gone dropdown.
    setVisibility("hidden");
    setVisibility("visible");
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS * 2);

    expect(isDropdownVisible()).toBe(false);
    removeSpy.mockRestore();
  });

  // T9. Lower bound only — meaningful as a pair with T8, which supplies the upper.
  it.each(MESSAGE_STATES)("still shows %s one tick before the interval", (_label, overrides) => {
    useTimeoutOnlyFakeTimers();
    const opts = makeOptions(overrides);
    showDropdown(opts);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS - 1);

    expect(isDropdownVisible()).toBe(true);
    expect(opts.onDismiss).not.toHaveBeenCalled();
  });

  // T10. The entries list must never expire under a user who is still choosing.
  it("does not arm a timer in the entries state", () => {
    useTimeoutOnlyFakeTimers();
    const opts = makeOptions();
    showDropdown(opts);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS * 2);

    expect(isDropdownVisible()).toBe(true);
    expect(opts.onDismiss).not.toHaveBeenCalled();
  });

  // `isDropdownVisible()` only reads a module variable, so nothing above notices if
  // the shadow root is never drained. That matters: showDropdown appends a fresh
  // <style> and dropdown every call, so a teardown that skips the drain stacks one
  // stale dropdown per show — the reported bug, made worse.
  it("empties the shadow root, identically to a manual dismiss", () => {
    useTimeoutOnlyFakeTimers();
    const { root } = getShadowHost();

    showDropdown(makeOptions({ vaultLocked: true }));
    expect(root.children.length).toBeGreaterThan(0);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(root.children.length).toBe(0);

    showDropdown(makeOptions({ vaultLocked: true }));
    expect(root.children.length).toBeGreaterThan(0);

    hideDropdown();

    expect(root.children.length).toBe(0);
  });

  // T13. Visibility and onDismiss alone would also pass for a hand-rolled teardown;
  // the listener removal is what proves the timer routes through hideDropdown().
  // rAF is faked here on purpose — it is the only way to install the outside-click
  // listener synchronously so the removal has something to remove.
  it("removes the outside-click listener, identically to a manual dismiss", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"] });
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const mousedownCaptureRemovals = () =>
      removeSpy.mock.calls.filter(([type, , capture]) => type === "mousedown" && capture === true);

    showDropdown(makeOptions({ vaultLocked: true }));
    vi.advanceTimersToNextFrame();
    removeSpy.mockClear();

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(isDropdownVisible()).toBe(false);
    expect(mousedownCaptureRemovals()).toHaveLength(1);

    // The manual path must produce the same call, so the two agree rather than the
    // timer path merely doing something of its own.
    showDropdown(makeOptions({ vaultLocked: true }));
    vi.advanceTimersToNextFrame();
    removeSpy.mockClear();

    hideDropdown();

    expect(mousedownCaptureRemovals()).toHaveLength(1);
    removeSpy.mockRestore();
  });

  // T11. An aggregate onDismiss count cannot detect an orphaned timer — both the
  // fixed and the buggy version total two. The 3000 ms gap separates the orphan's
  // deadline from the legitimate one so the checkpoint below can tell them apart.
  it("cancels the prior timer on re-show, so the second dropdown lives its full interval", () => {
    useTimeoutOnlyFakeTimers();
    const first = makeOptions({ vaultLocked: true });
    const second = makeOptions({ entries: [] });

    showDropdown(first);
    vi.advanceTimersByTime(3000);
    showDropdown(second);

    expect(first.onDismiss).toHaveBeenCalledOnce();
    expect(second.onDismiss).not.toHaveBeenCalled();

    // An orphaned first timer would fire here (t=5000 from the first show).
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS - 1);
    expect(isDropdownVisible()).toBe(true);
    expect(second.onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(isDropdownVisible()).toBe(false);
    expect(second.onDismiss).toHaveBeenCalledOnce();
  });

  // T14. The transition where an orphan would tear down a list mid-selection.
  it("does not tear down an entries dropdown shown after a message state", () => {
    useTimeoutOnlyFakeTimers();
    const message = makeOptions({ vaultLocked: true });
    const entries = makeOptions();

    showDropdown(message);
    vi.advanceTimersByTime(2000);
    showDropdown(entries);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS * 2);

    expect(isDropdownVisible()).toBe(true);
    expect(entries.onDismiss).not.toHaveBeenCalled();
  });

  // T12. Cleared, not merely outrun.
  it("clears the timer on an explicit hideDropdown", () => {
    useTimeoutOnlyFakeTimers();
    const opts = makeOptions({ vaultLocked: true });

    showDropdown(opts);
    hideDropdown();
    expect(opts.onDismiss).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  // An onDismiss that re-shows an entries list must leave it alone: the message
  // state's timer has already fired, and the entries branch arms none of its own.
  it("does not dismiss an entries dropdown put up by an onDismiss callback", () => {
    useTimeoutOnlyFakeTimers();
    const entries = makeOptions();
    let reshown = false;
    const message = makeOptions({
      vaultLocked: true,
      onDismiss: () => {
        if (!reshown) {
          reshown = true;
          showDropdown(entries);
        }
      },
    });

    showDropdown(message);
    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(isDropdownVisible()).toBe(true);
    expect(entries.onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS * 2);

    expect(isDropdownVisible()).toBe(true);
    expect(entries.onDismiss).not.toHaveBeenCalled();
  });

  // I2.2's binding landmark: the clear must precede the onDismiss re-entrancy point,
  // or a callback that re-shows leaves its freshly-armed timer uncancelled.
  it("does not orphan a timer when onDismiss re-shows the dropdown", () => {
    useTimeoutOnlyFakeTimers();
    const reshown = makeOptions({ entries: [] });
    let reshowCount = 0;
    const opts = makeOptions({
      vaultLocked: true,
      onDismiss: () => {
        if (reshowCount++ === 0) showDropdown(reshown);
      },
    });

    showDropdown(opts);
    hideDropdown();

    expect(isDropdownVisible()).toBe(true);

    vi.advanceTimersByTime(MESSAGE_AUTO_DISMISS_MS);

    expect(isDropdownVisible()).toBe(false);
    expect(reshown.onDismiss).toHaveBeenCalledOnce();
  });
});
