/**
 * @vitest-environment jsdom
 */
// C6: while a fill sequence is active, focus moves field by field; no detector
// may reopen its dropdown on those focus events. Each row first advances past
// 1500 ms and starts the fill directly (the popup path, which never sets the
// detectors' autofillSuppressUntil), so that window cannot mask a missing check.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const showDropdownMock = vi.fn();

vi.mock("../../content/ui/suggestion-dropdown", () => ({
  showDropdown: (opts: unknown) => showDropdownMock(opts),
  hideDropdown: vi.fn(),
  isDropdownVisible: () => false,
  handleDropdownKeydown: () => false,
  MESSAGE_AUTO_DISMISS_MS: 5000,
}));

vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

// jsdom has no layout: the layout-dependent guards pass, the field predicates stay real.
vi.mock("../../content/form-detector-lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../content/form-detector-lib")>()),
  isElementVisuallySafe: () => true,
  isPageVisuallySafe: () => true,
  isInputHitTestSafe: () => true,
  hasVisiblePopoverOverlayNear: () => false,
}));

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

const ENTRY = { id: "e-1", title: "x", username: "u", urlHost: "", entryType: "LOGIN" };

function installChrome(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn((msg: { type?: string }, cb?: (r: unknown) => void) => {
        cb?.({ type: msg.type, entries: [ENTRY], vaultLocked: false, suppressInline: false });
      }),
      lastError: null,
    },
    i18n: { getUILanguage: () => "en" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  showDropdownMock.mockReset();
  installChrome();
});

afterEach(async () => {
  const { __resetFillSequenceForTests } = await import("../../content/fill-sequence-lib");
  __resetFillSequenceForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// A fill whose only step waits for a field that never appears stays active
// until its deadline. Wrapped so that awaiting the import does not also await the fill.
async function startPendingFill(): Promise<{ done: Promise<void> }> {
  const { runFillSequence } = await import("../../content/fill-sequence-lib");
  const done = runFillSequence(document.body, [
    {
      key: "late",
      initial: null,
      relocate: () => null,
      accepts: () => true,
      write: () => {},
      release: () => {},
    },
  ]);
  return { done };
}

function focus(id: string): void {
  document.getElementById(id)?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

describe.each([
  {
    kind: "LOGIN",
    html: `<input id="target" type="password" />`,
    init: async () => (await import("../../content/form-detector-lib")).initFormDetector(),
  },
  {
    kind: "CREDIT_CARD",
    html: `<input id="target" autocomplete="cc-number" />`,
    init: async () => (await import("../../content/cc-form-detector-lib")).initCreditCardDetector(),
  },
  {
    kind: "IDENTITY",
    html: `<input id="target" autocomplete="name" /><input autocomplete="address-line1" />`,
    init: async () =>
      (await import("../../content/identity-form-detector-lib")).initIdentityDetector(),
  },
])("$kind detector while a fill is active", ({ html, init }) => {
  it("keeps the dropdown closed on focus, and reopens it once the fill exits", async () => {
    document.body.innerHTML = html;
    const { destroy } = await init();
    await vi.advanceTimersByTimeAsync(1600);

    const fill = await startPendingFill();
    focus("target");
    await vi.advanceTimersByTimeAsync(0);
    expect(showDropdownMock).not.toHaveBeenCalled();

    const { DEFAULT_LATE_FIELD_WINDOW_MS } = await import("../../content/fill-sequence-lib");
    await vi.advanceTimersByTimeAsync(DEFAULT_LATE_FIELD_WINDOW_MS);
    await fill.done;
    focus("target");
    await vi.advanceTimersByTimeAsync(0);
    expect(showDropdownMock).toHaveBeenCalledTimes(1);

    destroy();
  });
});
