import { describe, expect, it } from "vitest";
import {
  detectBestLocaleFromAcceptLanguage,
  getLocaleFromPathname,
  stripLocalePrefix,
} from "@/i18n/locale-utils";

describe("locale-utils", () => {
  it("detects locale from pathname", () => {
    expect(getLocaleFromPathname("/ja/dashboard")).toBe("ja");
    expect(getLocaleFromPathname("/en/dashboard")).toBe("en");
    expect(getLocaleFromPathname("/dashboard")).toBe("ja");
  });

  it("strips locale prefix safely", () => {
    expect(stripLocalePrefix("/ja/dashboard")).toBe("/dashboard");
    expect(stripLocalePrefix("/en")).toBe("/");
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
  });
});

