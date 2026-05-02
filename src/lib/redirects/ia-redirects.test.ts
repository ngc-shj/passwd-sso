import { describe, it, expect } from "vitest";
import { LOCALES } from "@/i18n/locales";
import { IA_REDIRECTS, buildLocaleRedirects } from "./ia-redirects";

describe("IA_REDIRECTS constant", () => {
  it("has every `from` map to exactly one `to`", () => {
    const seenFrom = new Set<string>();
    for (const { from } of IA_REDIRECTS) {
      expect(seenFrom.has(from), `duplicate from: ${from}`).toBe(false);
      seenFrom.add(from);
    }
  });

  it("has every `from` and `to` start with /dashboard/", () => {
    for (const { from, to } of IA_REDIRECTS) {
      expect(from.startsWith("/dashboard/"), `from must be under /dashboard/: ${from}`).toBe(true);
      expect(to.startsWith("/dashboard/"), `to must be under /dashboard/: ${to}`).toBe(true);
    }
  });

  it("has no protocol-relative or absolute URLs", () => {
    for (const { from, to } of IA_REDIRECTS) {
      // No path may contain `//` (protocol-relative) anywhere except a single
      // leading slash. Search for `//` after position 0.
      expect(from.indexOf("//", 1)).toBe(-1);
      expect(to.indexOf("//", 1)).toBe(-1);
      // No path may start with a scheme.
      expect(from).not.toMatch(/^https?:/);
      expect(to).not.toMatch(/^https?:/);
      // No backslashes or whitespace.
      expect(from).not.toMatch(/[\s\\]/);
      expect(to).not.toMatch(/[\s\\]/);
    }
  });

  it("has no `to` that maps to a removed prefix (sanity guard against accidental loop)", () => {
    const removedPrefixes = ["/dashboard/settings/security", "/dashboard/settings/mcp"];
    for (const { to } of IA_REDIRECTS) {
      for (const prefix of removedPrefixes) {
        expect(
          to === prefix || to.startsWith(`${prefix}/`),
          `to must not point back into removed prefix ${prefix}: ${to}`,
        ).toBe(false);
      }
    }
  });
});

describe("buildLocaleRedirects()", () => {
  const generated = buildLocaleRedirects();

  it("produces IA_REDIRECTS.length × LOCALES.length entries", () => {
    expect(generated.length).toBe(IA_REDIRECTS.length * LOCALES.length);
  });

  it("emits every (locale, from→to) combination with the expected source/destination shape", () => {
    for (const { from, to } of IA_REDIRECTS) {
      for (const locale of LOCALES) {
        const expectedSource = `/${locale}${from}`;
        const expectedDest = `/${locale}${to}`;
        const match = generated.find(
          (entry) => entry.source === expectedSource && entry.destination === expectedDest,
        );
        expect(
          match,
          `missing redirect: ${expectedSource} -> ${expectedDest}`,
        ).toBeDefined();
        expect(match?.permanent).toBe(true);
      }
    }
  });

  it("never emits a bare (un-localised) source", () => {
    for (const entry of generated) {
      expect(entry.source.startsWith("/dashboard/"), `bare source detected: ${entry.source}`).toBe(false);
    }
  });
});
