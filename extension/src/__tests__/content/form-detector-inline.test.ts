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
