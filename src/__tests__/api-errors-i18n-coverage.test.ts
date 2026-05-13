import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";

function readApiErrors(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, "ApiErrors.json"),
      "utf8",
    ),
  ) as Record<string, string>;
}

describe("ApiErrors i18n coverage", () => {
  const enMessages = readApiErrors("en");
  const jaMessages = readApiErrors("ja");
  const enKeys = new Set(Object.keys(enMessages));
  const jaKeys = new Set(Object.keys(jaMessages));

  // Resolve every API_ERROR code to its i18n key via the public API
  // (apiErrorToI18nKey). This indirectly exercises API_ERROR_I18N without
  // exporting it from the module under test.
  const i18nKeys = Array.from(
    new Set(Object.values(API_ERROR).map((code) => apiErrorToI18nKey(code))),
  );

  it("every API_ERROR i18n key exists in en/ApiErrors.json", () => {
    const missing = i18nKeys.filter((k) => !enKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("every API_ERROR i18n key exists in ja/ApiErrors.json", () => {
    const missing = i18nKeys.filter((k) => !jaKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("en and ja have the same set of keys", () => {
    expect(Object.keys(enMessages).sort()).toEqual(
      Object.keys(jaMessages).sort(),
    );
  });
});
