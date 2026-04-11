import { describe, expect, it } from "vitest";
import {
  TOKEN_BRIDGE_MSG_TYPE,
  BRIDGE_CODE_MSG_TYPE,
} from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded MSG_TYPE aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${TOKEN_BRIDGE_MSG_TYPE}"`);
  });

  it("imports the bridge code constants from the shared module (compile-time guard)", () => {
    // This test fails at TypeScript compilation if BRIDGE_CODE_MSG_TYPE is not
    // exported from ../../lib/constants. The actual numeric/string sync between
    // web app and extension is verified by the cross-repo test in
    // src/__tests__/i18n/extension-constants-sync.test.ts on the web app side.
    expect(typeof BRIDGE_CODE_MSG_TYPE).toBe("string");
    expect(BRIDGE_CODE_MSG_TYPE.length).toBeGreaterThan(0);
  });
});
