import { describe, it, expect } from "vitest";
import {
  extractHost,
  isHostMatch,
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
