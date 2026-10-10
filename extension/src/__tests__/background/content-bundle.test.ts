import { describe, expect, it } from "vitest";
import { matchesPattern } from "../../background/content-bundle";

describe("matchesPattern", () => {
  it.each([
    ["https://shop.example/checkout?x=1", "https://*/*", true],
    ["http://shop.example/checkout", "https://*/*", false],
    ["http://localhost:3000/login", "http://localhost/*", true],
    ["http://localhost.evil.example/login", "http://localhost/*", false],
    ["https://a.example.com/", "https://*.example.com/*", true],
    ["https://example.com/", "https://*.example.com/*", true],
    ["https://badexample.com/", "https://*.example.com/*", false],
    ["https://shop.example/app/x", "https://*/app/*", true],
    ["https://shop.example/other", "https://*/app/*", false],
    ["about:blank", "https://*/*", false],
    ["not a url", "https://*/*", false],
  ])("%s against %s: %s", (url, pattern, expected) => {
    expect(matchesPattern(url, pattern)).toBe(expected);
  });

  it.each(["<all_urls>", "*://*/*", "file:///*", "https://*"])(
    "matches nothing for a pattern form it does not parse (%s)",
    (pattern) => {
      expect(matchesPattern("https://shop.example/", pattern)).toBe(false);
    },
  );
});
