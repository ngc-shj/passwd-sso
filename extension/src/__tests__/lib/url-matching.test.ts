import { describe, it, expect } from "vitest";
import {
  extractHost,
  isHostMatch,
  parseHttpOrigin,
  sortByUrlMatch,
} from "../../lib/url-matching";
import urlMatchCases from "../../../test/fixtures/url-match-cases.json";

describe("extractHost", () => {
  for (const c of urlMatchCases.extractHost) {
    it(c.name, () => {
      expect(extractHost(c.url)).toBe(c.expected);
    });
  }
});

describe("isHostMatch", () => {
  for (const c of urlMatchCases.isHostMatch) {
    it(c.name, () => {
      expect(isHostMatch(c.stored, c.current)).toBe(c.expected);
    });
  }
});

// C5: the background refuses a popup expectedOrigin that is not a bare http(s)
// origin (scheme + host + port only) before any fetch or decrypt. parseHttpOrigin
// is the gate: it must accept a serialized origin and refuse anything a full URL
// (trailing slash, path) would otherwise smuggle through.
describe("parseHttpOrigin", () => {
  it.each([
    "https://example.com",
    "http://localhost:3000",
  ])("accepts %s", (value) => {
    expect(parseHttpOrigin(value)).toBe(value);
  });

  it.each([
    ["https://example.com/", "trailing slash is not a bare origin"],
    ["https://example.com/login", "a path means it is a full URL, not an origin"],
    ["ftp://x", "non-http(s) scheme"],
    ["", "empty string"],
    [123, "non-string"],
    ["null", "the literal string null is not an origin"],
  ] as const)("refuses %s (%s)", (value) => {
    expect(parseHttpOrigin(value)).toBeNull();
  });
});

describe("sortByUrlMatch", () => {
  it("puts matched entries first", () => {
    const entries = [
      { id: "1", urlHost: "foo.com" },
      { id: "2", urlHost: "example.com" },
      { id: "3", urlHost: "bar.com" },
    ];
    const sorted = sortByUrlMatch(entries, "example.com");
    expect(sorted.map((e) => e.id)).toEqual(["2", "1", "3"]);
  });

  it("preserves order within groups", () => {
    const entries = [
      { id: "1", urlHost: "example.com" },
      { id: "2", urlHost: "example.com" },
      { id: "3", urlHost: "other.com" },
      { id: "4", urlHost: "other.com" },
    ];
    const sorted = sortByUrlMatch(entries, "example.com");
    expect(sorted.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("handles null tabHost (no sorting)", () => {
    const entries = [
      { id: "1", urlHost: "a.com" },
      { id: "2", urlHost: "b.com" },
    ];
    const sorted = sortByUrlMatch(entries, null);
    expect(sorted).toBe(entries);
  });

  it("matches entries via additionalUrlHosts", () => {
    const entries = [
      { id: "1", urlHost: "foo.com" },
      { id: "2", urlHost: "bar.com", additionalUrlHosts: ["example.com"] },
      { id: "3", urlHost: "baz.com" },
    ];
    const sorted = sortByUrlMatch(entries, "example.com");
    expect(sorted[0].id).toBe("2");
  });

  it("matches primary urlHost before additionalUrlHosts", () => {
    const entries = [
      { id: "1", urlHost: "", additionalUrlHosts: ["example.com"] },
      { id: "2", urlHost: "example.com" },
    ];
    const sorted = sortByUrlMatch(entries, "example.com");
    expect(sorted.map((e) => e.id)).toEqual(["1", "2"]);
  });
});
