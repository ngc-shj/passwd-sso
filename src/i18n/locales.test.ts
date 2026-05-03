import { describe, it, expect } from "vitest";
import { LOCALES, DEFAULT_LOCALE } from "./locales";

describe("locales constants", () => {
  it("LOCALES exports a non-empty readonly tuple", () => {
    expect(Array.isArray(LOCALES)).toBe(true);
    expect(LOCALES.length).toBeGreaterThan(0);
  });

  it("LOCALES contains the expected codes", () => {
    expect(LOCALES).toEqual(["ja", "en"]);
  });

  it("LOCALES contains no duplicate locales", () => {
    const unique = new Set(LOCALES);
    expect(unique.size).toBe(LOCALES.length);
  });

  it("DEFAULT_LOCALE is a member of LOCALES", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("DEFAULT_LOCALE is 'ja' (project policy)", () => {
    expect(DEFAULT_LOCALE).toBe("ja");
  });

  it("every locale is a non-empty lowercase BCP-47 primary subtag", () => {
    for (const code of LOCALES) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
      expect(code).toBe(code.toLowerCase());
      expect(code).toMatch(/^[a-z]{2,3}$/);
    }
  });
});
