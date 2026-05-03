import { describe, it, expect } from "vitest";
import { routing } from "./routing";
import { LOCALES, DEFAULT_LOCALE } from "./locales";

describe("i18n/routing", () => {
  it("exposes the configured locale list", () => {
    expect(routing.locales).toEqual(LOCALES);
  });

  it("uses the canonical default locale", () => {
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
  });

  it("locks localePrefix to 'always' (URLs always carry locale segment)", () => {
    expect(routing.localePrefix).toBe("always");
  });

  it("defaultLocale is included in the locales list", () => {
    expect(routing.locales).toContain(routing.defaultLocale);
  });
});
