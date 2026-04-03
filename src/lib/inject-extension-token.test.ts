// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TOKEN_BRIDGE_EVENT } from "@/lib/constants";
import { injectExtensionToken } from "./inject-extension-token";

describe("injectExtensionToken", () => {
  it("dispatches TOKEN_BRIDGE_EVENT with token detail", () => {
    const handler = vi.fn();
    document.addEventListener(TOKEN_BRIDGE_EVENT, handler);

    injectExtensionToken("my-token", 1234567890);

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event.detail).toEqual({ token: "my-token", expiresAt: 1234567890 });

    document.removeEventListener(TOKEN_BRIDGE_EVENT, handler);
  });

  it("does not create any DOM element", () => {
    injectExtensionToken("tok", 999);
    expect(document.getElementById("passwd-sso-ext-token")).toBeNull();
  });

  it("does not set a removal timeout", () => {
    vi.useFakeTimers();
    injectExtensionToken("tok", 999);
    // No setTimeout should be registered
    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    // If we got here without errors, no timer was set
  });
});
