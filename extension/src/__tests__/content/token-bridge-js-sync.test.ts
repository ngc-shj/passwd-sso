import { describe, expect, it } from "vitest";
import {
  EXT_CONNECT_REQUEST_MSG_TYPE,
  EXT_CONNECT_READY_MSG_TYPE,
} from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded EXT_CONNECT_REQUEST_MSG_TYPE aligned with shared constants", async () => {
    // token-bridge.js is a hand-maintained plain JS content script (no import
    // support). When EXT_CONNECT_REQUEST_MSG_TYPE changes in constants.ts,
    // this test fails unless token-bridge.js is updated in lock-step.
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${EXT_CONNECT_REQUEST_MSG_TYPE}"`);
  });

  it("keeps hardcoded EXT_CONNECT_READY_MSG_TYPE aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${EXT_CONNECT_READY_MSG_TYPE}"`);
  });

  it("uses the START_CONNECT runtime message name", async () => {
    // The .js file hardcodes the string "START_CONNECT" (no import); a rename
    // in EXT_MSG.START_CONNECT must be mirrored here.
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"START_CONNECT"`);
  });
});
