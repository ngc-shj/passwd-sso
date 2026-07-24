/**
 * @vitest-environment jsdom
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EXT_MSG } from "../../lib/constants";

// Capture showDropdown options so we can drive onSelect.
const showDropdownMock = vi.fn();
const hideDropdownMock = vi.fn();

vi.mock("../../content/ui/suggestion-dropdown", () => ({
  showDropdown: (opts: unknown) => showDropdownMock(opts),
  hideDropdown: (...a: unknown[]) => hideDropdownMock(...a),
  isDropdownVisible: () => false,
  handleDropdownKeydown: () => false,
}));

vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

// M6: spy on showInlineNotice; stub the guard helpers with jsdom-safe defaults
// (no layout in jsdom → hit-test always passes, elements always visible).
const showInlineNoticeMock = vi.hoisted(() => vi.fn());
// Keep the real field predicates (isUsableInput / isUsableFieldOfType) so the
// fillable-type gate is exercised as production does — only the layout-dependent
// visibility/hit-test helpers are stubbed to pass under jsdom (no layout).
vi.mock("../../content/form-detector-lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../content/form-detector-lib")>()),
  showInlineNotice: showInlineNoticeMock,
  isElementVisuallySafe: () => true,
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

beforeEach(() => {
  showDropdownMock.mockReset();
  hideDropdownMock.mockReset();
  showInlineNoticeMock.mockReset();
  document.body.innerHTML = "";
});

afterEach(() => {
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
    const { destroy } = initCreditCardDetector();

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(1);
    expect(showDropdownMock).toHaveBeenCalledTimes(1);
    expect(showDropdownMock.mock.calls[0][0].entryType).toBe("CREDIT_CARD");
    destroy();
  });

  it("does not request matches when an unrelated field is focused", async () => {
    document.body.innerHTML = `
      <input id="ccnum" autocomplete="cc-number" />
      <input id="search" type="text" name="search" />
    `;
    installChrome({});
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    const { destroy } = initCreditCardDetector();

    const search = document.getElementById("search") as HTMLInputElement;
    search.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(0);
    destroy();
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
    const { destroy } = initCreditCardDetector();

    const input = document.getElementById("ccnum") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    const opts = showDropdownMock.mock.calls[0][0] as {
      onSelect: (id: string, teamId?: string) => void;
    };
    opts.onSelect("cc-1");

    const fills = matchRequests(EXT_MSG.AUTOFILL_FROM_CONTENT);
    expect(fills).toHaveLength(1);
    expect((fills[0].msg as { entryId?: string }).entryId).toBe("cc-1");
    destroy();
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
    const { destroy } = initCreditCardDetector();

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
    destroy();
  });

  it("T8: destroy() removes the focus listener (no further requests)", async () => {
    document.body.innerHTML = `<input id="ccnum" autocomplete="cc-number" />`;
    installChrome({
      [EXT_MSG.GET_CC_MATCHES_FOR_URL]: {
        type: EXT_MSG.GET_CC_MATCHES_FOR_URL, entries: [], vaultLocked: false, suppressInline: false,
      },
    });
    const { initCreditCardDetector } = await import("../../content/cc-form-detector-lib");
    const { destroy } = initCreditCardDetector();
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
      const { destroy } = initCreditCardDetector();
      const input = document.getElementById("ccnum") as HTMLInputElement;
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(0);
      destroy();
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
      const { destroy } = initIdentityDetector();
      const input = document.getElementById("name") as HTMLInputElement;
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(0);
      destroy();
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
    const { destroy } = initIdentityDetector();

    const input = document.getElementById("name") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(1);
    expect(showDropdownMock.mock.calls[0][0].entryType).toBe("IDENTITY");
    destroy();
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
    const cc = initCreditCardDetector();
    const id = initIdentityDetector();

    (document.getElementById("ccnum") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    (document.getElementById("name") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(1);
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(1);
    cc.destroy();
    id.destroy();
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
    const cc = initCreditCardDetector();
    const id = initIdentityDetector();

    (document.getElementById("holder") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );

    expect(matchRequests(EXT_MSG.GET_CC_MATCHES_FOR_URL)).toHaveLength(1);
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(0);

    (document.getElementById("addr") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    expect(matchRequests(EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL)).toHaveLength(1);

    cc.destroy();
    id.destroy();
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
