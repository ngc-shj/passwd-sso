import { describe, expect, it } from "vitest";
import { TOKEN_ELEMENT_ID, TOKEN_READY_EVENT } from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded DOM/event literals aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge.js?raw");

    expect(file).toContain(`"${TOKEN_ELEMENT_ID}"`);
    expect(file).toContain(`"${TOKEN_READY_EVENT}"`);
  });
});
