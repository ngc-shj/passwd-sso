// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TOKEN_BRIDGE_MSG_TYPE } from "@/lib/constants";
import { injectExtensionToken } from "./inject-extension-token";

describe("injectExtensionToken", () => {
  it("sends postMessage with token data", async () => {
    const received = new Promise<MessageEvent>((resolve) => {
      window.addEventListener("message", (e) => {
        // jsdom sets event.origin to "" instead of window.location.origin
        if (e.origin !== window.location.origin && e.origin !== "") return;
        resolve(e);
      }, { once: true });
    });

    injectExtensionToken("my-token", 1234567890);

    const event = await received;
    expect(event.data).toEqual({
      type: TOKEN_BRIDGE_MSG_TYPE,
      token: "my-token",
      expiresAt: 1234567890,
    });
  });

  it("does not create any DOM element", () => {
    injectExtensionToken("tok", 999);
    expect(document.getElementById("passwd-sso-ext-token")).toBeNull();
  });
});
