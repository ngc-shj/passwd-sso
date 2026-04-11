// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BRIDGE_CODE_MSG_TYPE } from "@/lib/constants";
import { injectExtensionBridgeCode } from "./inject-extension-bridge-code";

describe("injectExtensionBridgeCode", () => {
  it("sends postMessage with bridge code data", async () => {
    const received = new Promise<MessageEvent>((resolve) => {
      window.addEventListener(
        "message",
        (e) => {
          // jsdom sets event.origin to "" instead of window.location.origin
          if (e.origin !== window.location.origin && e.origin !== "") return;
          resolve(e);
        },
        { once: true },
      );
    });

    injectExtensionBridgeCode("a".repeat(64), 1234567890);

    const event = await received;
    expect(event.data).toEqual({
      type: BRIDGE_CODE_MSG_TYPE,
      code: "a".repeat(64),
      expiresAt: 1234567890,
    });
  });

  it("does not include a bearer token field in the payload (regression guard)", async () => {
    const received = new Promise<MessageEvent>((resolve) => {
      window.addEventListener(
        "message",
        (e) => {
          if (e.origin !== window.location.origin && e.origin !== "") return;
          resolve(e);
        },
        { once: true },
      );
    });

    injectExtensionBridgeCode("a".repeat(64), 1);

    const event = await received;
    // The whole point of this change: the payload must NOT contain a bearer token.
    expect(event.data).not.toHaveProperty("token");
    expect(event.data.type).toBe(BRIDGE_CODE_MSG_TYPE);
  });

  it("does not create any DOM element", () => {
    injectExtensionBridgeCode("a".repeat(64), 999);
    expect(document.getElementById("passwd-sso-ext-token")).toBeNull();
  });
});
