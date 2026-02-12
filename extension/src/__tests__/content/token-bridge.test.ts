/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryReadToken } from "../../content/token-bridge-lib";

describe("token bridge", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(),
      },
    });
  });

  it("reads token from DOM and sends SET_TOKEN", () => {
    const el = document.createElement("div");
    el.id = "passwd-sso-ext-token";
    el.setAttribute("data-token", "tkn");
    el.setAttribute("data-expires-at", "123");
    document.body.appendChild(el);

    const ok = tryReadToken();
    expect(ok).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_TOKEN",
      token: "tkn",
      expiresAt: 123,
    });
  });

  it("returns false when token is missing/invalid", () => {
    const el = document.createElement("div");
    el.id = "passwd-sso-ext-token";
    el.setAttribute("data-token", "");
    el.setAttribute("data-expires-at", "NaN");
    document.body.appendChild(el);

    const ok = tryReadToken();
    expect(ok).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
