/**
 * @vitest-environment jsdom
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EXT_MSG } from "../../lib/constants";
import { ATTR_RESCAN_DELAY_MS, ATTR_RECENT_MS } from "../../content/rescan-scheduler";
import { documentScans } from "../helpers/scan-count";

// Capture showDropdown options so we can drive onSelect.
const showDropdownMock = vi.fn();
const hideDropdownMock = vi.fn();

vi.mock("../../content/ui/suggestion-dropdown", () => ({
  showDropdown: (opts: unknown) => showDropdownMock(opts),
  hideDropdown: (...a: unknown[]) => hideDropdownMock(...a),
  isDropdownVisible: () => false,
  handleDropdownKeydown: () => false,
  MESSAGE_AUTO_DISMISS_MS: 5000,
}));

vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

// C3 (#875): wraps the real ccClaimedFields so the rate/filter/focus-matrix
// tests below can count detector scans without faking detection itself —
// identity's own rescan calls through to the same function, so only one live
// detector is created per counting test (see "C3" describe block).
const ccClaimedFieldsMock = vi.hoisted(() => vi.fn());
vi.mock("../../content/cc-field-detection-lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../content/cc-field-detection-lib")>();
  ccClaimedFieldsMock.mockImplementation(actual.ccClaimedFields);
  return { ...actual, ccClaimedFields: ccClaimedFieldsMock };
});


// M6: spy on showInlineNotice; stub the guard helpers with jsdom-safe defaults
// (no layout in jsdom → hit-test always passes, elements always visible).
const showInlineNoticeMock = vi.hoisted(() => vi.fn());
// The real field predicates (isUsableInput / isUsableFieldOfType, now in
// field-query-lib, which is not mocked) still run, so the fillable-type gate is
// exercised as production does — field visibility runs for real against the
// global layout stub (helpers/layout-stub.ts); only the page-level and hit-test
// helpers below are stubbed to pass.
vi.mock("../../content/form-detector-lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../content/form-detector-lib")>()),
  showInlineNotice: showInlineNoticeMock,
  isPageVisuallySafe: () => true,
  isInputHitTestSafe: () => true,
  hasVisiblePopoverOverlayNear: () => false,
}));

// jsdom lacks layout — make visibility/hit-test helpers pass.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

let sentMessages: Array<{ msg: { type?: string }; cb?: (r: unknown) => void }> = [];

function installChrome(responses: Record<string, unknown>) {
  sentMessages = [];
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn((msg: { type?: string }, cb?: (r: unknown) => void) => {
        sentMessages.push({ msg, cb });
        const resp = responses[msg.type ?? ""];
        if (resp !== undefined && cb) cb(resp);
      }),
      lastError: null,
    },
    i18n: { getUILanguage: () => "en" },
  });
}

function matchRequests(type: string) {
  return sentMessages.filter((m) => m.msg.type === type);
}

// File-level cleanup registry (#CR2): every test that inits a detector
// routes it through registerDestroy instead of calling destroy() itself at
// the end of the test body. A destroy() placed only at the end of a test
// never runs when an earlier assertion in that test throws, leaking a live
// MutationObserver + document-level listeners that outlive the test and can
// affect whichever test runs next against the same jsdom `document`.
let cleanups: Array<{ destroy: () => void }> = [];
function registerDestroy<T extends { destroy: () => void }>(detector: T): T {
  cleanups.push(detector);
  return detector;
}

beforeEach(() => {
  showDropdownMock.mockReset();
  hideDropdownMock.mockReset();
  showInlineNoticeMock.mockReset();
  document.body.innerHTML = "";
  cleanups = [];
});

afterEach(() => {
  for (const d of cleanups) d.destroy();
  cleanups = [];
  document.body.innerHTML = "";
});

describe("initCreditCardDetector", () => {
  it("issues exactly one GET_CC_MATCHES request when a detected CC field is focused", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
        entries: [{ id: "cc-1", title: "Card", username: "Alice", urlHost: "", entryType: "CREDIT_CARD" }],
        vaultLocked: false,
        suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    registerDestroy(initCreditCardDetector());

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    const ccRequests = matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL);
    expect(ccRequests).toHaveLength(1);
    // C7: the background derives the page URL from MessageSender, not from
    // this message — url/topUrl must not be sent.
    expect(ccRequests[0].msg).toEqual({ type: EXT_MSG.GET_CC_MATCHES_FOR_URL });
    expect(showDropdownMock).toHaveBeenCalledTimes(1);
    expect(showDropdownMock.mock.calls[0][0].entryType).toBe("CREDIT_CARD");
  });

  it("does not request matches when an unrelated field is focused", async () => {
    document.body.innerHTML = `
      <input id="ccnum" autocomplete="cc-number" />
      <input id="search" type="text" name="search" />
    `;
    installChrome({});
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    registerDestroy(initCreditCardDetector());

    const search = document.getElementById("search") as HTMLInputElement;
    search.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(0);
  });

  it("T5: selecting an entry sends AUTOFILL_FROM_CONTENT with the entryId", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
        entries: [{ id: "cc-1", title: "Card", username: "Alice", urlHost: "", entryType: "CREDIT_CARD" }],
        vaultLocked: false,
        suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    registerDestroy(initCreditCardDetector());

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    const opts = showDropdownMock.mock.calls[0][0] as {
      onSelect: (id: string, teamId?: string) => void;
    };
    opts.onSelect("cc-1");

    const fills = matchRequests(EXT_MSG.AUTOFILL_FROM_CONTENT);
    expect(fills).toHaveLength(1);
    expect((fills[0].msg as { entryId?: string }).entryId).toBe("cc-1");
  });

  it("M6: onSelect with NO_CARD_NUMBER response calls showInlineNotice with noCardNumber key", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
        entries: [{ id: "cc-1", title: "Card", username: "Alice", urlHost: "", entryType: "CREDIT_CARD" }],
        vaultLocked: false,
        suppressInline: false,
      },
      [EXT_MSG.AUTOFILL_FROM_CONTENT]: { ok: false, error: "NO_CARD_NUMBER" },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    registerDestroy(initCreditCardDetector());

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Drive onSelect with the captured dropdown options.
    const opts = showDropdownMock.mock.calls[0][0] as {
      onSelect: (id: string, teamId?: string) => void;
    };
    opts.onSelect("cc-1");

    // showInlineNotice must have been called with the noCardNumber i18n key.
    expect(showInlineNoticeMock).toHaveBeenCalledOnce();
    expect(showInlineNoticeMock).toHaveBeenCalledWith(input, "errors.noCardNumber");
  });

  it("T8: destroy() removes the focus listener (no further requests)", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    // destroy() under test is called explicitly here; also registering it
    // means the file-level afterEach's own destroy() is a harmless no-op
    // if an assertion below throws before this point is reached.
    const { destroy } = registerDestroy(initCreditCardDetector());
    destroy();

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(0);
  });

  it("T10 (mock-only): no-op in a cross-origin subframe", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({});
    // Simulate a cross-origin subframe: window.top !== window.self AND
    // accessing window.top.location throws (SecurityError). jsdom cannot model
    // a real cross-origin frame, so we monkey-patch window.top for this test.
    const realTop = window.top;
    const crossOriginTop = {
      get location(): Location {
        throw new Error("cross-origin");
      },
    };
    Object.defineProperty(window, "top", { value: crossOriginTop, configurable: true });
    try {
      const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
      registerDestroy(initCreditCardDetector());
      const input = document.getElementById("ccnum") as HTMLInputElement;
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "top", { value: realTop, configurable: true });
    }
  });
});

describe("initIdentityDetector", () => {
  it("M1 (mock-only): no-op in a cross-origin subframe", async () => {
    document.body.innerHTML = `
      <form>
        <input id="name" autocomplete="name" />
        <input id="addr" autocomplete="address-line1" />
      </form>
    `;
    installChrome({});
    // Simulate a cross-origin subframe: window.top !== window.self AND
    // accessing window.top.location throws (SecurityError). jsdom cannot model
    // a real cross-origin frame, so we monkey-patch window.top for this test.
    const realTop = window.top;
    const crossOriginTop = {
      get location(): Location {
        throw new Error("cross-origin");
      },
    };
    Object.defineProperty(window, "top", { value: crossOriginTop, configurable: true });
    try {
      const { initIdentityDetector } = await import("../../content/identity-form-detector-lib");
      registerDestroy(initIdentityDetector());
      const input = document.getElementById("name") as HTMLInputElement;
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "top", { value: realTop, configurable: true });
    }
  });

  it("issues one GET_IDENTITY_MATCHES request when a detected identity field is focused", async () => {
    document.body.innerHTML = `
      <form>
        <input id="name" autocomplete="name" />
        <input id="addr" autocomplete="address-line1" />
      </form>
    `;
    installChrome({
      [EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
        entries: [{ id: "id-1", title: "Home", username: "Alice Smith", urlHost: "", entryType: "IDENTITY" }],
        vaultLocked: false,
        suppressInline: false,
      },
    });
    const { initIdentityDetector } = await import("../../content/identity-form-detector-lib");
    registerDestroy(initIdentityDetector());

    const input = document.getElementById("name") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    const identityRequests = matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL);
    expect(identityRequests).toHaveLength(1);
    // C7: the background derives the page URL from MessageSender, not from
    // this message — url/topUrl must not be sent.
    expect(identityRequests[0].msg).toEqual({ type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL });
    expect(showDropdownMock.mock.calls[0][0].entryType).toBe("IDENTITY");
  });
});

describe("T7: both forms on one page do not cross-trigger", () => {
  it("CC field → GET_CC only; identity field → GET_IDENTITY only", async () => {
    document.body.innerHTML = `
      <form id="payment">
        <input id="ccnum" autocomplete="cc-number" />
      </form>
      <form id="shipping">
        <input id="name" autocomplete="name" />
        <input id="addr" autocomplete="address-line1" />
      </form>
    `;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
      [EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    const { initIdentityDetector } = await import("../../content/identity-form-detector-lib");
    registerDestroy(initCreditCardDetector());
    registerDestroy(initIdentityDetector());

    (document.getElementById("ccnum") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    (document.getElementById("name") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(1);
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(1);
  });
});

// ── C4/C7: overlap-field race (T7-extension) ──────────────────

describe("T7-extension: CC-claimed overlap field never triggers identity", () => {
  it("focus holder field → GET_CC_MATCHES only, never GET_IDENTITY_MATCHES; focus 住所 → identity still fires", async () => {
    document.body.innerHTML = `
      <form>
        <label for="cno">カード番号</label>
        <input id="cno" name="card_no" type="text" />
        <label for="holder">カード名義人</label>
        <input id="holder" name="holder_name" type="text" />
        <label for="zip">郵便番号</label>
        <input id="zip" name="zip" type="text" />
        <label for="addr">住所</label>
        <input id="addr" name="addr" type="text" />
      </form>
    `;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
      [EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    const { initIdentityDetector } = await import("../../content/identity-form-detector-lib");
    registerDestroy(initCreditCardDetector());
    registerDestroy(initIdentityDetector());

    (document.getElementById("holder") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(1);
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(0);

    (document.getElementById("addr") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(1);
  });
});

describe("C4: fieldCount-boundary fixture", () => {
  it("1 card_no + 1 holder overlap + exactly 1 郵便番号 → detectIdentityFields returns null (post-exclusion fieldCount 1)", async () => {
    document.body.innerHTML = `
      <form>
        <label for="cno">カード番号</label>
        <input id="cno" name="card_no" type="text" />
        <label for="holder">カード名義人</label>
        <input id="holder" name="holder_name" type="text" />
        <label for="zip">郵便番号</label>
        <input id="zip" name="zip" type="text" />
      </form>
    `;
    const { detectIdentityFields } = await import("../../content/identity-form-detector-lib");
    expect(detectIdentityFields(document)).toBeNull();
  });
});

// ── C3 (#875): filtered, rate-bounded attribute rescan ──────────
//
// Both the CC and identity detectors wire the same rescan-scheduler pattern
// (NF1/NF2), so every mechanism below is red-proofed in BOTH files by running
// the same case against both detector profiles. Scans are counted through
// ccClaimedFieldsMock — identity's own rescan calls through to it too (see the
// mock above), so only one live detector exists per counting test.

type DetectorProfile = {
  label: string;
  autocomplete: string;
  messageType: string;
  // A second field some detectors need to clear their own "is this really a
  // form" floor (identity needs fieldCount >= 2); empty for CC.
  extraMarkup: string;
  init: () => Promise<{ destroy: () => void }>;
};

const detectorProfiles: DetectorProfile[] = [
  {
    label: "CC",
    autocomplete: "cc-number",
    messageType: EXT_MSG.GET_CC_MATCHES_FOR_URL,
    extraMarkup: "",
    init: async () => (await import("../../content/cc-form-detector-lib")).initCreditCardDetector(),
  },
  {
    label: "identity",
    autocomplete: "name",
    messageType: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
    extraMarkup: '<input autocomplete="address-line1" />',
    init: async () => (await import("../../content/identity-form-detector-lib")).initIdentityDetector(),
  },
];

function installProfileChrome(profile: DetectorProfile, extra: Record<string, unknown> = {}) {
  installChrome({
    [profile.messageType]: {
      type: profile.messageType,
      entries: [],
      vaultLocked: false,
      suppressInline: false,
    },
    ...extra,
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("C3: filtered, rate-bounded attribute rescan (#875)", () => {
  // cleanups/registerDestroy come from the file-level registry above; this
  // describe destroys WHILE fake timers are still active (scheduler.cancel()
  // clears a timer id the fake clock minted) and only then restores real
  // timers — the file-level afterEach's own destroy pass, which runs after
  // this one, is then a harmless no-op over the same (idempotent) detectors.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    ccClaimedFieldsMock.mockClear();
  });

  afterEach(() => {
    for (const d of cleanups) d.destroy();
    vi.useRealTimers();
  });

  describe("reveal: a field revealed by an attribute change alone gets the dropdown on focus", () => {
    type RevealCase = {
      name: string;
      attrs: string;
      styleTag?: string;
      reveal: (el: HTMLInputElement) => void;
    };

    const cases: RevealCase[] = [
      { name: "hidden attribute", attrs: "hidden", reveal: (el) => el.removeAttribute("hidden") },
      {
        name: 'style="display:none"',
        attrs: 'style="display:none"',
        reveal: (el) => el.removeAttribute("style"),
      },
      {
        name: "class with a <style> rule",
        attrs: 'class="psso-hidden"',
        styleTag: "<style>.psso-hidden { display: none; }</style>",
        reveal: (el) => el.classList.remove("psso-hidden"),
      },
      { name: "disabled", attrs: "disabled", reveal: (el) => el.removeAttribute("disabled") },
      { name: "readonly", attrs: "readonly", reveal: (el) => el.removeAttribute("readonly") },
      {
        name: 'type="hidden"',
        attrs: 'type="hidden"',
        reveal: (el) => {
          el.type = "text";
        },
      },
    ];

    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        it.each(cases)("$name: 0 requests before reveal, 1 after reveal + delay", async ({ attrs, styleTag, reveal }) => {
          document.body.innerHTML = `${styleTag ?? ""}<input id="target" autocomplete="${profile.autocomplete}" ${attrs} />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          expect(matchRequests(profile.messageType)).toHaveLength(0);

          reveal(input);
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          expect(matchRequests(profile.messageType)).toHaveLength(1);
        });

        it("reveal, then focus after one microtask but before the delay: 1 request", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" hidden />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          input.removeAttribute("hidden");
          await flushMicrotasks(); // arms the trailing timer; delay not yet elapsed
          input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(matchRequests(profile.messageType)).toHaveLength(1);
        });

        it("same task: reveal + .focus(), field hidden in the initial markup, no earlier attribute change: 1 request", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" hidden />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          input.removeAttribute("hidden");
          input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(matchRequests(profile.messageType)).toHaveLength(1);
        });
      });
    }
  });

  describe("focus matrix", () => {
    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        function fixture() {
          document.body.innerHTML = `<input id="member" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}<input id="other" type="text" name="other" />`;
        }

        it("member with a rescan pending: 0 scans, and the timer stays armed", async () => {
          fixture();
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const member = document.getElementById("member") as HTMLInputElement;

          member.classList.add("marker"); // qualifying attribute mutation, no visibility change
          await flushMicrotasks();
          expect(vi.getTimerCount()).toBe(1);

          const before = documentScans(ccClaimedFieldsMock);
          member.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(0);
          expect(vi.getTimerCount()).toBe(1);
        });

        it("non-member with a rescan pending: 1 scan", async () => {
          fixture();
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const member = document.getElementById("member") as HTMLInputElement;
          const other = document.getElementById("other") as HTMLInputElement;

          member.classList.add("marker");
          await flushMicrotasks();
          expect(vi.getTimerCount()).toBe(1);

          const before = documentScans(ccClaimedFieldsMock);
          other.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });

        it("non-member with nothing pending or recent: 0 scans", async () => {
          fixture();
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const other = document.getElementById("other") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          other.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(0);
        });

        it("non-member within ATTR_RECENT_MS after the timer fired: 1 scan", async () => {
          fixture();
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const member = document.getElementById("member") as HTMLInputElement;
          const other = document.getElementById("other") as HTMLInputElement;

          member.classList.add("marker");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS); // trailing rescan fires; timer clears
          vi.advanceTimersByTime(ATTR_RECENT_MS - ATTR_RESCAN_DELAY_MS - 1); // still inside the recent window

          const before = documentScans(ccClaimedFieldsMock);
          other.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });

        it("a batch whose first target has no input still counts a later field target", async () => {
          document.body.innerHTML = `<div id="d"></div><input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const div = document.getElementById("d") as HTMLDivElement;
          const target = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          div.classList.add("x");
          target.classList.add("y");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });
      });
    }
  });

  describe("rate: at most one trailing rescan per ATTR_RESCAN_DELAY_MS window", () => {
    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        it("mutations spread over several microtasks in one window give exactly 1 scan", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          for (let i = 0; i < 5; i++) {
            input.classList.toggle(`m${i}`);
            await flushMicrotasks();
          }
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });

        it("one scan is 1 + document.forms.length ccClaimedFields calls", async () => {
          document.body.innerHTML = `<form><input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}</form><form><input autocomplete="${profile.autocomplete}" />${profile.extraMarkup}</form>`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const scansBefore = documentScans(ccClaimedFieldsMock);
          const callsBefore = ccClaimedFieldsMock.mock.calls.length;
          input.classList.toggle("multiplier");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - scansBefore).toBe(1);
          expect(ccClaimedFieldsMock.mock.calls.length - callsBefore).toBe(1 + document.forms.length);
        });

        it("two windows give 2 scans", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          input.classList.toggle("w1");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
          input.classList.toggle("w2");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(2);
        });

        it("one mutation every 50ms for 500ms gives at least 4 scans", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          for (let i = 0; i < 10; i++) {
            input.classList.toggle(`r${i}`);
            await flushMicrotasks();
            vi.advanceTimersByTime(50);
          }

          expect(documentScans(ccClaimedFieldsMock) - before).toBeGreaterThanOrEqual(4);
        });

        it("99ms gives 0 scans, 1ms more gives 1", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          input.classList.toggle("boundary");
          await flushMicrotasks();
          vi.advanceTimersByTime(99);
          expect(documentScans(ccClaimedFieldsMock) - before).toBe(0);

          vi.advanceTimersByTime(1);
          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });
      });
    }
  });

  describe("filter: attribute-only mutations only count when their target is, or contains, an input/select", () => {
    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        it("a class mutation on an element with no input inside makes 0 scans", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}<div id="empty"></div>`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const empty = document.getElementById("empty") as HTMLDivElement;

          const before = documentScans(ccClaimedFieldsMock);
          empty.classList.add("marker");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(0);
        });

        it("the same mutation on a form container (containing an input) makes 1 scan", async () => {
          document.body.innerHTML = `<form id="form"><input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}</form>`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const form = document.getElementById("form") as HTMLFormElement;

          const before = documentScans(ccClaimedFieldsMock);
          form.classList.add("marker");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);
        });
      });
    }
  });

  describe("added nodes run the scan immediately; attribute-only changes wait for the debounce (CR2)", () => {
    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        it("inserting a field scans before any timer fires; an attribute-only change on it still waits", async () => {
          document.body.innerHTML = profile.extraMarkup;
          installProfileChrome(profile);
          registerDestroy(await profile.init());

          const before = documentScans(ccClaimedFieldsMock);
          const input = document.createElement("input");
          input.setAttribute("autocomplete", profile.autocomplete);
          document.body.appendChild(input);
          await flushMicrotasks();
          vi.advanceTimersByTime(0);
          expect(documentScans(ccClaimedFieldsMock) - before).toBe(1);

          const afterInsert = documentScans(ccClaimedFieldsMock);
          input.classList.add("marker");
          await flushMicrotasks();
          expect(documentScans(ccClaimedFieldsMock) - afterInsert).toBe(0);
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS - 1);
          expect(documentScans(ccClaimedFieldsMock) - afterInsert).toBe(0);
          vi.advanceTimersByTime(1);
          expect(documentScans(ccClaimedFieldsMock) - afterInsert).toBe(1);
        });
      });
    }
  });

  describe("attributeFilter excludes attributes outside OBSERVED_ATTRIBUTES (CR2)", () => {
    for (const profile of detectorProfiles) {
      describe(profile.label, () => {
        it("a data-x attribute mutation makes 0 scans; a class mutation on the same field still makes 1", async () => {
          document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
          installProfileChrome(profile);
          registerDestroy(await profile.init());
          const input = document.getElementById("target") as HTMLInputElement;

          const before = documentScans(ccClaimedFieldsMock);
          input.setAttribute("data-x", "1");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
          expect(documentScans(ccClaimedFieldsMock) - before).toBe(0);

          const afterDataX = documentScans(ccClaimedFieldsMock);
          input.classList.add("marker");
          await flushMicrotasks();
          vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);
          expect(documentScans(ccClaimedFieldsMock) - afterDataX).toBe(1);
        });
      });
    }
  });

  describe("destroy", () => {
    for (const profile of detectorProfiles) {
      it(`${profile.label}: 1 timer before destroy(), 0 after`, async () => {
        document.body.innerHTML = `<input id="target" autocomplete="${profile.autocomplete}" />${profile.extraMarkup}`;
        installProfileChrome(profile);
        const detector = registerDestroy(await profile.init());
        const input = document.getElementById("target") as HTMLInputElement;

        input.classList.add("marker");
        await flushMicrotasks();
        expect(vi.getTimerCount()).toBe(1);

        detector.destroy();
        expect(vi.getTimerCount()).toBe(0);
      });
    }
  });
});
