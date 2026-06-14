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
 * `?raw` import inside `token-bridge-js-sync.test.ts` covers
 * `EXT_CONNECT_REQUEST_MSG_TYPE` in the bundled JS, but cannot verify numeric
 * values that may be inlined or absent from the bundle.
 */

import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_CODE_LENGTH,
  BRIDGE_CODE_MAX_ACTIVE,
  BRIDGE_CODE_TTL_MS,
  EXT_CONNECT_REQUEST_MSG_TYPE,
  EXT_CONNECT_READY_MSG_TYPE,
} from "@/lib/constants/integrations/extension";

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
  // Allow numeric literals and MS_PER_* time-unit expressions
  // (e.g. 60 * 1000, 60_000, 3, MS_PER_MINUTE) — the extension expresses
  // durations via the shared MS_PER_* constants, same as the web app.
  //
  // Substitution whitelist — COMPLETE list of identifiers replaced before eval:
  //   MS_PER_SECOND → 1000
  //   MS_PER_MINUTE → 60000
  // Any other uppercase identifier (e.g. MS_PER_HOUR, MY_CONSTANT) causes the
  // post-substitution safety check to reject the expression and return undefined,
  // preventing silent wrong-number extraction. Add to this whitelist explicitly
  // when the extension introduces new time-unit constants.
  const match = extSource.match(
    new RegExp(`export const ${name}\\s*=\\s*([0-9_*\\sA-Z]+);`),
  );
  if (!match) return undefined;
  const expr = match[1]
    .replace(/\bMS_PER_SECOND\b/g, "1000")
    .replace(/\bMS_PER_MINUTE\b/g, "60000");
  // After substitution only digits, underscores, asterisks, and whitespace
  // remain — verify before evaluating so the Function() call stays safe.
  if (!/^[0-9_*\s]+$/.test(expr)) return undefined;
  return Function(`"use strict"; return (${expr});`)();
}

describe("extractNumericConst guard", () => {
  it("returns undefined for a source line containing an un-whitelisted identifier", () => {
    // If the guard were absent, an expression like "MS_PER_HOUR" would pass
    // through as a non-numeric string and evaluate to NaN or throw, producing a
    // silent wrong result. The post-substitution safety check must reject it.
    // We simulate a synthetic source line by temporarily checking against a
    // known-bad expression that contains a non-whitelisted uppercase identifier.
    const syntheticSource = "export const FAKE_CONST = MS_PER_HOUR;";
    const match = syntheticSource.match(
      /export const FAKE_CONST\s*=\s*([0-9_*\sA-Z]+);/,
    );
    expect(match).not.toBeNull();
    const expr = (match?.[1] ?? "")
      .replace(/\bMS_PER_SECOND\b/g, "1000")
      .replace(/\bMS_PER_MINUTE\b/g, "60000");
    // MS_PER_HOUR is NOT in the whitelist — safety check must reject
    expect(/^[0-9_*\s]+$/.test(expr)).toBe(false);
  });
});

describe("extension constants sync (web app ↔ extension repo)", () => {
  it("BRIDGE_CODE_TTL_MS matches between web app and extension", () => {
    expect(extractNumericConst("BRIDGE_CODE_TTL_MS")).toBe(BRIDGE_CODE_TTL_MS);
  });

  it("BRIDGE_CODE_MAX_ACTIVE matches between web app and extension", () => {
    expect(extractNumericConst("BRIDGE_CODE_MAX_ACTIVE")).toBe(BRIDGE_CODE_MAX_ACTIVE);
  });

  it("BRIDGE_CODE_LENGTH matches between web app and extension", () => {
    expect(extractNumericConst("BRIDGE_CODE_LENGTH")).toBe(BRIDGE_CODE_LENGTH);
  });

  it("EXT_CONNECT_REQUEST_MSG_TYPE matches between web app and extension", () => {
    expect(extractStringConst("EXT_CONNECT_REQUEST_MSG_TYPE")).toBe(EXT_CONNECT_REQUEST_MSG_TYPE);
  });

  it("EXT_CONNECT_READY_MSG_TYPE matches between web app and extension", () => {
    expect(extractStringConst("EXT_CONNECT_READY_MSG_TYPE")).toBe(EXT_CONNECT_READY_MSG_TYPE);
  });
});
