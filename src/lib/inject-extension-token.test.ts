// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TOKEN_ELEMENT_ID, TOKEN_READY_EVENT } from "@/lib/constants";
import { injectExtensionToken } from "./inject-extension-token";

describe("injectExtensionToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clean up any existing token elements
    document.getElementById(TOKEN_ELEMENT_ID)?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getElementById(TOKEN_ELEMENT_ID)?.remove();
  });

  it("creates a hidden div with token data attributes", () => {
    injectExtensionToken("my-token", 1234567890);

    const el = document.getElementById(TOKEN_ELEMENT_ID);
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-token")).toBe("my-token");
    expect(el!.getAttribute("data-expires-at")).toBe("1234567890");
    expect(el!.style.display).toBe("none");
  });

  it("removes existing element before creating new one", () => {
    injectExtensionToken("token-1", 100);
    injectExtensionToken("token-2", 200);

    const els = document.querySelectorAll(`#${TOKEN_ELEMENT_ID}`);
    expect(els.length).toBe(1);
    expect(els[0].getAttribute("data-token")).toBe("token-2");
  });

  it("dispatches TOKEN_READY_EVENT custom event", () => {
    const handler = vi.fn();
    document.addEventListener(TOKEN_READY_EVENT, handler);

    injectExtensionToken("tok", 999);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBeInstanceOf(CustomEvent);

    document.removeEventListener(TOKEN_READY_EVENT, handler);
  });

  it("auto-removes element after 10 seconds", () => {
    injectExtensionToken("tok", 999);
    expect(document.getElementById(TOKEN_ELEMENT_ID)).not.toBeNull();

    vi.advanceTimersByTime(10_000);

    expect(document.getElementById(TOKEN_ELEMENT_ID)).toBeNull();
  });

  it("appends element to document.body", () => {
    injectExtensionToken("tok", 999);
    const el = document.getElementById(TOKEN_ELEMENT_ID);
    expect(el!.parentElement).toBe(document.body);
  });
});
