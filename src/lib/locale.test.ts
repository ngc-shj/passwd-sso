import { describe, it, expect } from "vitest";
import { resolveUserLocale } from "./locale";

describe("resolveUserLocale", () => {
  it("returns stored locale when valid", () => {
    expect(resolveUserLocale("en")).toBe("en");
    expect(resolveUserLocale("ja")).toBe("ja");
  });

  it("ignores invalid stored locale and falls back to Accept-Language", () => {
    expect(resolveUserLocale("fr", "en-US,en;q=0.9")).toBe("en");
  });

  it("ignores null stored locale and uses Accept-Language", () => {
    expect(resolveUserLocale(null, "en-US,en;q=0.9")).toBe("en");
  });

  it("ignores undefined stored locale and uses Accept-Language", () => {
    expect(resolveUserLocale(undefined, "ja,en;q=0.5")).toBe("ja");
  });

  it("returns en when en appears before ja in Accept-Language", () => {
    expect(resolveUserLocale(null, "en-US,en;q=0.9,ja;q=0.8")).toBe("en");
  });

  it("returns ja when ja appears before en in Accept-Language", () => {
    expect(resolveUserLocale(null, "ja,en;q=0.5")).toBe("ja");
  });

  it("returns ja when Accept-Language has only ja", () => {
    expect(resolveUserLocale(null, "ja")).toBe("ja");
  });

  it("returns en when Accept-Language has only en", () => {
    expect(resolveUserLocale(null, "en")).toBe("en");
  });

  it("returns en (default) when Accept-Language has neither en nor ja", () => {
    expect(resolveUserLocale(null, "fr-FR,de;q=0.5")).toBe("en");
  });

  it("returns en (default) when no stored locale and no Accept-Language", () => {
    expect(resolveUserLocale(null, null)).toBe("en");
    expect(resolveUserLocale(undefined, undefined)).toBe("en");
  });

  it("stored locale takes priority over Accept-Language", () => {
    expect(resolveUserLocale("en", "ja,en;q=0.5")).toBe("en");
    expect(resolveUserLocale("ja", "en-US,en;q=0.9")).toBe("ja");
  });
});
