/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const showDropdownMock = vi.fn();
const hideDropdownMock = vi.fn();

vi.mock("../../content/ui/suggestion-dropdown", () => ({
  showDropdown: (...args: unknown[]) => showDropdownMock(...args),
  hideDropdown: (...args: unknown[]) => hideDropdownMock(...args),
  isDropdownVisible: () => false,
  handleDropdownKeydown: () => false,
  MESSAGE_AUTO_DISMISS_MS: 5000,
}));

vi.mock("../../lib/i18n", () => ({
  t: (key: string) => key,
}));

// NF3: wraps the real ccFormFields in a spy so the "no scan on a non-trigger
// path" assertions below have something to assert zero calls against,
// without changing any detection behavior (importOriginal).
vi.mock("../../content/cc-field-detection-lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../content/cc-field-detection-lib")>();
  return { ...actual, ccFormFields: vi.fn(actual.ccFormFields) };
});
import { ccFormFields } from "../../content/cc-field-detection-lib";

let sentMessages: unknown[] = [];

describe("form-detector suppressInline", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="pw" type="password" />`;
    showDropdownMock.mockReset();
    hideDropdownMock.mockReset();
    sentMessages = [];

    vi.stubGlobal("chrome", {
      runtime: {
        id: "ext-test-id",
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
          sentMessages.push(msg);
          const req = msg as { type?: string };
          if (req.type === "GET_MATCHES_FOR_URL") {
            cb?.({
              type: "GET_MATCHES_FOR_URL",
              entries: [{ id: "1", title: "x", username: "u", urlHost: "h", entryType: "LOGIN" }],
              vaultLocked: false,
              suppressInline: true,
            });
            return;
          }
          cb?.({ ok: true });
        }),
        lastError: null,
      },
      i18n: {
        getUILanguage: () => "en",
      },
    });
  });

  it("does not render dropdown when suppressInline=true", async () => {
    const { initFormDetector } = await import("../../content/form-detector-lib");
    const { destroy } = initFormDetector();

    const input = document.getElementById("pw") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();

    expect(showDropdownMock).not.toHaveBeenCalled();
    expect(hideDropdownMock).toHaveBeenCalled();

    destroy();
  });

  // C7: the background derives the page URL from MessageSender, not from this
  // message — url/topUrl must not be sent.
  it("sends GET_MATCHES_FOR_URL with no url/topUrl", async () => {
    const { initFormDetector } = await import("../../content/form-detector-lib");
    const { destroy } = initFormDetector();

    const input = document.getElementById("pw") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();

    expect(sentMessages).toEqual([{ type: "GET_MATCHES_FOR_URL" }]);

    destroy();
  });
});

describe("form-detector CC field exclusion (inline trigger, C4)", () => {
  beforeEach(() => {
    showDropdownMock.mockReset();
    hideDropdownMock.mockReset();
    sentMessages = [];
    vi.mocked(ccFormFields).mockClear();

    vi.stubGlobal("chrome", {
      runtime: {
        id: "ext-test-id",
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
          sentMessages.push(msg);
          const req = msg as { type?: string };
          if (req.type === "GET_MATCHES_FOR_URL") {
            cb?.({
              type: "GET_MATCHES_FOR_URL",
              entries: [{ id: "1", title: "x", username: "u", urlHost: "h", entryType: "LOGIN" }],
              vaultLocked: false,
              suppressInline: false,
            });
            return;
          }
          cb?.({ ok: true });
        }),
        lastError: null,
      },
      i18n: { getUILanguage: () => "en" },
    });
  });

  it("focusing the login password sends GET_MATCHES_FOR_URL (control, first); focusing the card-form CVV sends none", async () => {
    document.body.innerHTML = `
      <input id="pw" type="password" />
      <div id="card">
        <input name="cardNumber" />
        <input id="cvv" type="password" name="cvv" />
      </div>
    `;
    const { initFormDetector } = await import("../../content/form-detector-lib");
    const { destroy } = initFormDetector();

    (document.getElementById("pw") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    await Promise.resolve();
    expect(sentMessages).toEqual([{ type: "GET_MATCHES_FOR_URL" }]);

    (document.getElementById("cvv") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    await Promise.resolve();
    // Still just the one message from the login password — the card CVV
    // never triggers the LOGIN dropdown.
    expect(sentMessages).toEqual([{ type: "GET_MATCHES_FOR_URL" }]);

    destroy();
  });

  it("NF3: ccFormFields is reachable via focus (control, first); a mutation batch adding a card-form CVV does not call it", async () => {
    document.body.innerHTML = `<div id="root"><input id="pw0" type="password" /></div>`;
    const { initFormDetector } = await import("../../content/form-detector-lib");
    const { destroy } = initFormDetector();

    (document.getElementById("pw0") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    await Promise.resolve();
    expect(ccFormFields).toHaveBeenCalled();
    vi.mocked(ccFormFields).mockClear();

    // scanInputs (the MutationObserver callback) only tracks inputs via
    // rawPasswordInputs — it must not scan the card form on DOM churn.
    const root = document.getElementById("root") as HTMLElement;
    root.insertAdjacentHTML(
      "beforeend",
      `<input name="cardNumber" /><input id="cvv" type="password" name="cvv" />`,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ccFormFields).not.toHaveBeenCalled();

    destroy();
  });

  it("NF3: focusing a candidate calls ccFormFields (control, first); focusing a non-candidate does not", async () => {
    document.body.innerHTML = `<input id="pw" type="password" />`;
    const { initFormDetector } = await import("../../content/form-detector-lib");
    const { destroy } = initFormDetector();

    (document.getElementById("pw") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    await Promise.resolve();
    expect(ccFormFields).toHaveBeenCalled();
    destroy();

    vi.mocked(ccFormFields).mockClear();

    // No password anywhere on the page: the per-field OR chain in
    // shouldTriggerForInput is false for every clause (not a password, not
    // username-/OTP-shaped, and findAssociatedPasswordInput short-circuits
    // on an empty rawPasswordInputs scan), so the `&&` never reaches
    // isLoginEligible / ccForm() at all.
    document.body.innerHTML = `<input id="other" type="text" />`;
    const detector2 = initFormDetector();
    (document.getElementById("other") as HTMLInputElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    await Promise.resolve();
    expect(ccFormFields).not.toHaveBeenCalled();
    detector2.destroy();
  });
});
