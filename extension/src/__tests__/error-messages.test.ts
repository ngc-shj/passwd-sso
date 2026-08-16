import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { humanizeError } from "../lib/error-messages";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

/**
 * humanizeError falls through to `return code` for an unmapped code, so an
 * unmapped value reaches the user as a raw identifier like
 * "AUTOFILL_INJECT_FAILED".
 *
 * Note what this can and cannot guarantee. normalizeErrorCode passes through any
 * SCREAMING_SNAKE message (`^[A-Z][A-Z0-9_]{1,63}$`), so the set of codes that
 * can reach a rendered surface is open — enumerating it exhaustively is not
 * possible, and the real defence for the tail is that every display site supplies
 * a mapped fallback. What IS closed, and what these tests pin, are the two sets
 * that are written down in the source: the codes the autofill path returns, and
 * the literals the popup/options views name themselves.
 *
 * Both are derived from the source rather than restated here, so a new code added
 * on either side fails this test instead of shipping as a raw identifier.
 */
const SRC_ROOT = new URL("..", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, SRC_ROOT)), "utf8");
}

const INDEX_SRC = read("background/index.ts");

/**
 * Literals the popup and options views pass to humanizeError, including the
 * `res.error || "FALLBACK"` form — the fallback is what renders when the
 * background returns no code, so it is a display literal like any other.
 */
const UI_DISPLAY_SOURCES = [
  "popup/components/MatchList.tsx",
  "popup/components/VaultUnlock.tsx",
  "options/App.tsx",
] as const;

function uiDisplayedCodes(): string[] {
  const codes: string[] = [];
  for (const relative of UI_DISPLAY_SOURCES) {
    const src = read(relative);
    for (const m of src.matchAll(
      /(?:humanizeError\(|setError\()[^)\n]*?"([A-Z][A-Z0-9_]{2,})"/g,
    )) {
      codes.push(m[1]);
    }
  }
  return [...new Set(codes)];
}

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

/**
 * Codes returned by the background handlers the popup actually invokes. These
 * reach a rendered surface through `res.error`, which the views pass straight to
 * humanizeError — so they are display codes even though no view names them.
 * UNLOCK_FAILED was in exactly this position: emitted only by the UNLOCK_VAULT
 * handler, rendered by VaultUnlock, and invisible to a scan of view sources.
 */
const POPUP_INVOKED_HANDLERS = [
  "UNLOCK_VAULT",
  "COPY_PASSWORD",
  "COPY_TOTP",
  "FETCH_PASSWORDS",
] as const;

function popupReachableCodes(): string[] {
  const codes: string[] = [];
  for (const msg of POPUP_INVOKED_HANDLERS) {
    // Each handler is a `case EXT_MSG.X:` arm; bound the scan to that arm so it
    // cannot silently absorb a neighbouring handler's codes.
    const start = INDEX_SRC.indexOf(`case EXT_MSG.${msg}:`);
    expect(start, `${msg} handler not found`).toBeGreaterThan(-1);
    const rest = INDEX_SRC.slice(start + 1);
    const end = rest.indexOf("\n      case EXT_MSG.");
    const body = end > -1 ? rest.slice(0, end) : rest.slice(0, 4000);
    for (const m of body.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) {
      // Message-type constants and header values are not error codes.
      if (m[1].startsWith("EXT_") || m[1] === msg) continue;
      codes.push(m[1]);
    }
  }
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

  it("maps every literal the popup and options views display", () => {
    // The same defect class as the autofill-path check, one layer out: it lives
    // wherever a view names a code itself. COPY_TOTP_FAILED and UNLOCK_FAILED
    // were both unmapped and would have rendered as raw identifiers.
    const codes = uiDisplayedCodes();
    expect(codes.length).toBeGreaterThan(5);

    for (const code of codes) {
      expect(humanizeError(code), `${code} is unmapped`).not.toBe(code);
    }
  });

  it("maps every code the popup-invoked handlers can return", () => {
    const codes = popupReachableCodes();
    expect(codes.length).toBeGreaterThan(2);

    const unmapped = codes.filter((c) => humanizeError(c) === c);
    expect(unmapped, `unmapped codes reachable from the popup: ${unmapped.join(", ")}`)
      .toEqual([]);
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
