import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";

/**
 * messages-consistency.test.ts compares KEY NAMES across locales, so it is green
 * when a key is missing from both. And every component test echo-mocks
 * useTranslations, so `t("copyEmpty")` returns the literal "copyEmpty" whether
 * or not the JSON was ever touched. Neither can tell whether these strings
 * exist, and the outcomes they name are exactly the failure paths this change
 * exists to make visible.
 */
function readNamespace(locale: string): Record<string, string> {
  // readFileSync + JSON.parse, not a dynamic import: a missing file must throw
  // ENOENT rather than resolve to {} and trivially satisfy every assertion.
  const file = path.resolve(process.cwd(), "messages", locale, "CopyButton.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

const LOCALES = ["en", "ja"] as const;

const OUTCOME_KEYS = [
  "copyEmpty",
  "copyUnavailable",
  "copyWriteFailed",
  "copySourceFailed",
] as const;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("CopyButton messages", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      it("defines a non-empty string for every copy outcome", () => {
        const messages = readNamespace(locale);
        for (const key of OUTCOME_KEYS) {
          expect(typeof messages[key], `${locale}.${key}`).toBe("string");
          expect(messages[key]?.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        }
      });

      it("keeps the pre-existing keys, including the interpolating one", () => {
        // The allow side of the pair: a parity test alone can be satisfied by
        // emptying both locales, so assert what must survive.
        const messages = readNamespace(locale);
        expect(placeholders(messages.copyNamed ?? "")).toEqual(["name"]);
        expect(typeof messages.copy).toBe("string");
      });
    });
  }

  it("interpolates the clear interval rather than hardcoding it", () => {
    // The success toast now states how long the clipboard will hold the secret,
    // at 58 call sites. A literal here would silently go stale the moment
    // CLIPBOARD_CLEAR_TIMEOUT_MS changes.
    const seconds = String(CLIPBOARD_CLEAR_TIMEOUT_MS / MS_PER_SECOND);
    for (const locale of LOCALES) {
      const copied = readNamespace(locale).copied ?? "";
      expect(placeholders(copied), `${locale}.copied`).toEqual(["seconds"]);
      expect(copied, `${locale}.copied`).not.toContain(seconds);
    }
  });

  it("agrees on placeholders across locales for every key", () => {
    // messages-consistency.test.ts compares key names only, so `en` carrying
    // {seconds} while `ja` carries {sec} — or nothing — stays green there and
    // renders a raw key path in production.
    const [en, ja] = LOCALES.map(readNamespace);
    for (const key of Object.keys(en)) {
      expect(placeholders(ja[key] ?? ""), `ja.${key} placeholders`).toEqual(
        placeholders(en[key]),
      );
    }
  });
});
