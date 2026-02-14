import { describe, expect, it } from "vitest";
import {
  detectBestLocaleFromAcceptLanguage,
  getLocaleFromPathname,
  isAppLocale,
  stripLocalePrefix,
} from "@/i18n/locale-utils";
import { routing } from "@/i18n/routing";

describe("locale-utils", () => {
  it("detects locale from pathname", () => {
    expect(getLocaleFromPathname("/ja/dashboard")).toBe("ja");
    expect(getLocaleFromPathname("/en/dashboard")).toBe("en");
    expect(getLocaleFromPathname("/fr/dashboard")).toBe(routing.defaultLocale);
    expect(getLocaleFromPathname("/dashboard")).toBe("ja");
  });

  it("strips locale prefix safely", () => {
    expect(stripLocalePrefix("/ja/dashboard")).toBe("/dashboard");
    expect(stripLocalePrefix("/en")).toBe("/");
    expect(stripLocalePrefix("/fr/dashboard")).toBe("/fr/dashboard");
    expect(stripLocalePrefix("/dashboard")).toBe("/dashboard");
  });

  it("detects best locale from accept-language", () => {
    expect(detectBestLocaleFromAcceptLanguage("en-US,en;q=0.9,ja;q=0.8")).toBe(
      "en"
    );
    expect(detectBestLocaleFromAcceptLanguage("ja-JP,ja;q=0.9,en;q=0.8")).toBe(
      "ja"
    );
    expect(detectBestLocaleFromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("ja");
    expect(detectBestLocaleFromAcceptLanguage("")).toBe("ja");
    expect(detectBestLocaleFromAcceptLanguage(null)).toBe("ja");
  });

  it("validates supported locale values", () => {
    expect(isAppLocale("ja")).toBe(true);
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("fr")).toBe(false);
  });
});
