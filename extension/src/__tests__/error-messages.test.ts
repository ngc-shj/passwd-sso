import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { humanizeError } from "../lib/error-messages";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

/**
 * humanizeError falls through to `return code` for an unmapped code, so an
 * unmapped value reaches the user as a raw identifier like
 * "AUTOFILL_INJECT_FAILED". That was invisible while the only consumers were
 * views that happened to cover their own codes; the context-menu fill path now
 * routes whatever performAutofillForEntry returns into the toolbar tooltip, so
 * every code that function can produce has to be mapped.
 *
 * This derives the code set from the source rather than restating it, so a new
 * `error: "..."` added to the fill path fails here instead of shipping as a raw
 * identifier.
 */
const INDEX_SRC = readFileSync(
  fileURLToPath(new URL("../background/index.ts", import.meta.url)),
  "utf8",
);

function fillPathErrorCodes(): string[] {
  const start = INDEX_SRC.indexOf("async function performAutofillForEntry");
  expect(start).toBeGreaterThan(-1);
  // Bounded by the next top-level function so the scan cannot silently widen.
  const rest = INDEX_SRC.slice(start + 1);
  const end = rest.indexOf("\nasync function ");
  expect(end).toBeGreaterThan(-1);
  const body = rest.slice(0, end);
  const codes = [...body.matchAll(/error:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  return [...new Set(codes)];
}

describe("humanizeError", () => {
  it("maps every error code the autofill path can return", () => {
    const codes = fillPathErrorCodes();
    // Fail loudly if the scan matched nothing: an empty set would satisfy the
    // per-code assertion vacuously.
    expect(codes.length).toBeGreaterThan(3);

    for (const code of codes) {
      expect(humanizeError(code), `${code} is unmapped`).not.toBe(code);
    }
  });

  it("maps the codes the context-menu click path emits itself", () => {
    for (const code of ["UNKNOWN_ORIGIN", "FILL_FAILED"]) {
      expect(humanizeError(code), `${code} is unmapped`).not.toBe(code);
    }
  });

  it("returns the raw code when there is genuinely no mapping", () => {
    // The fallback is deliberate — pinned so the test above cannot pass merely
    // because humanizeError stopped returning the code for everything.
    expect(humanizeError("NOT_A_REAL_CODE")).toBe("NOT_A_REAL_CODE");
  });

  it("has every mapped key present in all shipped locales", () => {
    // Asserted on the KEY, not on the resolved string: t() falls back to en, so
    // a comparison of resolved text would pass for a ja key that does not exist.
    const mapSrc = readFileSync(
      fileURLToPath(new URL("../lib/error-messages.ts", import.meta.url)),
      "utf8",
    );
    const mapped = [...mapSrc.matchAll(/^\s+[A-Z_]+:\s*"errors\.(\w+)"/gm)].map(
      (m) => m[1],
    );
    expect(mapped.length).toBeGreaterThan(3);

    const locales: Array<[string, Record<string, string>]> = [
      ["en", (en as { errors: Record<string, string> }).errors],
      ["ja", (ja as { errors: Record<string, string> }).errors],
    ];
    for (const key of mapped) {
      for (const [name, errors] of locales) {
        expect(errors[key], `errors.${key} missing from ${name}`).toBeTruthy();
      }
    }
  });
});
