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

  it("contains the C15-v2 navigator.userActivation gate with fail-closed structure", async () => {
    // The gate is a security control. token-bridge.js is the production
    // artifact loaded into the host page; token-bridge-lib.ts is test-only.
    // A regression that adds the gate to -lib.ts but not .js would silently
    // disable the gate in production while all unit tests pass (RT4 vacuous
    // guard). T6: assert the actual fail-closed SHAPE — not just substring
    // presence — so an inverted gate (e.g. `&&` → `||`, or switching to the
    // sticky `hasBeenActive`) is caught here.
    const { default: file } = await import("../../content/token-bridge.js?raw");
    const normalized = file.replace(/\s+/g, " ");
    // Must bail (return) when transient activation is absent.
    expect(normalized).toMatch(
      /if \( ?!navigator\.userActivation \|\| !navigator\.userActivation\.isActive ?\) return;?/,
    );
    // Must NOT rely on sticky activation, which would let a single past
    // gesture authorize later silent connects. Match the property ACCESS
    // (`.hasBeenActive`), not the bare word — the gate's own comment mentions
    // "isActive-not-hasBeenActive" to document the deliberate choice.
    expect(file).not.toContain(".hasBeenActive");
  });
});
