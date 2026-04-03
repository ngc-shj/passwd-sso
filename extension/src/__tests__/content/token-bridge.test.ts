/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handlePostMessage } from "../../content/token-bridge-lib";
import { TOKEN_BRIDGE_MSG_TYPE } from "../../lib/constants";

describe("token bridge (postMessage)", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        sendMessage: vi.fn(),
      },
    });
  });

  function makeEvent(data: unknown, source: unknown = window): MessageEvent {
    return { data, source, origin: "https://app.example.com" } as unknown as MessageEvent;
  }

  it("forwards valid relay message to background", () => {
    const ok = handlePostMessage(
      makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: 123 }),
    );
    expect(ok).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_TOKEN",
      token: "tkn",
      expiresAt: 123,
    });
  });

  it("rejects message from different source (iframe)", () => {
    const ok = handlePostMessage(
      makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: 123 }, {}),
    );
    expect(ok).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects message with wrong type", () => {
    const ok = handlePostMessage(
      makeEvent({ type: "OTHER_MSG", token: "tkn", expiresAt: 123 }),
    );
    expect(ok).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects message with missing token", () => {
    const ok = handlePostMessage(
      makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, expiresAt: 123 }),
    );
    expect(ok).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects message with NaN expiresAt", () => {
    const ok = handlePostMessage(
      makeEvent({ type: TOKEN_BRIDGE_MSG_TYPE, token: "tkn", expiresAt: NaN }),
    );
    expect(ok).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send error response on invalid messages (oracle prevention)", () => {
    handlePostMessage(makeEvent({ type: "WRONG" }, {}));
    // No sendMessage call, no error response — silent rejection
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
