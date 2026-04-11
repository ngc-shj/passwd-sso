/**
 * Cross-repo constant sync between the web app and the extension.
 *
 * The web app (`src/lib/constants/extension.ts`) and the extension
 * (`extension/src/lib/constants.ts`) duplicate a small set of bridge
 * constants by necessity (the extension is its own Vite project and cannot
 * import from `@/lib/...`). This test catches drift between the two repos
 * by reading both files at runtime and asserting equality of the constants.
 *
 * Why this lives in the web app and not the extension: the web app vitest
 * environment can read sibling repo files via relative path. The extension
 * `?raw` import inside `token-bridge-js-sync.test.ts` covers the legacy
 * string constant in the bundled JS, but cannot verify numeric values that
 * may be inlined or absent from the bundle.
 */

import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_CODE_MAX_ACTIVE,
  BRIDGE_CODE_MSG_TYPE,
  BRIDGE_CODE_TTL_MS,
  TOKEN_BRIDGE_MSG_TYPE,
} from "@/lib/constants/extension";

const EXT_CONSTANTS_PATH = path.join(
  __dirname,
  "../../../extension/src/lib/constants.ts",
);

const extSource = fs.readFileSync(EXT_CONSTANTS_PATH, "utf-8");

function extractStringConst(name: string): string | undefined {
  const match = extSource.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  );
  return match?.[1];
}

function extractNumericConst(name: string): number | undefined {
  // Allow underscore-separated numeric literals (e.g. 60 * 1000, 60_000, 3)
  const match = extSource.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9_*\\s]+);`),
  );
  if (!match) return undefined;
  // Evaluate the numeric expression literally — only digits, underscores,
  // asterisks, and whitespace are allowed by the regex above, so this is safe.
  return Function(`"use strict"; return (${match[1]});`)();
}

describe("extension constants sync (web app ↔ extension repo)", () => {
  it("TOKEN_BRIDGE_MSG_TYPE matches between web app and extension", () => {
    expect(extractStringConst("TOKEN_BRIDGE_MSG_TYPE")).toBe(TOKEN_BRIDGE_MSG_TYPE);
  });

  it("BRIDGE_CODE_MSG_TYPE matches between web app and extension", () => {
    expect(extractStringConst("BRIDGE_CODE_MSG_TYPE")).toBe(BRIDGE_CODE_MSG_TYPE);
  });

  it("BRIDGE_CODE_TTL_MS matches between web app and extension", () => {
    expect(extractNumericConst("BRIDGE_CODE_TTL_MS")).toBe(BRIDGE_CODE_TTL_MS);
  });

  it("BRIDGE_CODE_MAX_ACTIVE matches between web app and extension", () => {
    expect(extractNumericConst("BRIDGE_CODE_MAX_ACTIVE")).toBe(BRIDGE_CODE_MAX_ACTIVE);
  });
});
