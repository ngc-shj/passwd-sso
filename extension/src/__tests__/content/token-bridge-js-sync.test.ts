import { describe, expect, it } from "vitest";
import { BRIDGE_CODE_MSG_TYPE } from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded bridge code MSG_TYPE aligned with shared constants", async () => {
    // token-bridge.js is a hand-maintained plain JS content script (no import
    // support). When BRIDGE_CODE_MSG_TYPE changes in constants.ts, this test
    // fails unless token-bridge.js is updated in lock-step.
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${BRIDGE_CODE_MSG_TYPE}"`);
  });

  it("references the exchange endpoint path", async () => {
    // Guards against accidental removal of the exchange code path.
    // Must match src/lib/constants/api-path.ts EXTENSION_TOKEN_EXCHANGE.
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain("/api/extension/token/exchange");
  });
});
