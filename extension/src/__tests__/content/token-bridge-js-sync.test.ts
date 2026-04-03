import { describe, expect, it } from "vitest";
import { TOKEN_BRIDGE_MSG_TYPE } from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded MSG_TYPE aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${TOKEN_BRIDGE_MSG_TYPE}"`);
  });
});

describe("token-bridge-relay.js sync", () => {
  it("keeps hardcoded event name and MSG_TYPE aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge-relay.js?raw");
    expect(file).toContain(`"passwd-sso-token-bridge"`);
    expect(file).toContain(`"${TOKEN_BRIDGE_MSG_TYPE}"`);
  });
});
