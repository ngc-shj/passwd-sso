import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOKEN_ELEMENT_ID, TOKEN_READY_EVENT } from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded DOM/event literals aligned with shared constants", () => {
    const file = readFileSync(
      resolve(process.cwd(), "src/content/token-bridge.js"),
      "utf8"
    );

    expect(file).toContain(`"${TOKEN_ELEMENT_ID}"`);
    expect(file).toContain(`"${TOKEN_READY_EVENT}"`);
  });
});

