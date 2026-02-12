import { describe, it, expect } from "vitest";
import {
  extractHost,
  isHostMatch,
  sortByUrlMatch,
} from "../../lib/url-matching";

describe("extractHost", () => {
  it("extracts hostname from full URL", () => {
    expect(extractHost("https://mail.google.com/inbox")).toBe("mail.google.com");
  });

  it("returns null for invalid URL", () => {
    expect(extractHost("not-a-url")).toBeNull();
  });

  it("returns null for non-http(s) scheme", () => {
    expect(extractHost("edge://extensions")).toBeNull();
  });

  it("handles localhost with port", () => {
    expect(extractHost("http://localhost:3000/")).toBe("localhost");
  });
});

describe("isHostMatch", () => {
  it("matches exact hostname", () => {
    expect(isHostMatch("example.com", "example.com")).toBe(true);
  });

  it("matches with www prefix normalization", () => {
    expect(isHostMatch("example.com", "www.example.com")).toBe(true);
  });

  it("matches subdomain", () => {
    expect(isHostMatch("google.com", "mail.google.com")).toBe(true);
  });

  it("does not match unrelated domains", () => {
    expect(isHostMatch("example.com", "google.com")).toBe(false);
  });

  it("does not match partial suffix", () => {
    expect(isHostMatch("example.com", "notexample.com")).toBe(false);
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
});
