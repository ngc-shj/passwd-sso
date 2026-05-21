import { describe, it, expect } from "vitest";
import { isSafeHref } from "./safe-href";

describe("isSafeHref", () => {
  it("accepts http/https/mailto", () => {
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("https://example.com/path?q=1")).toBe(true);
    expect(isSafeHref("mailto:user@example.com")).toBe(true);
  });

  it("rejects javascript: scheme (self-XSS vector)", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
  });

  it("rejects data: scheme", () => {
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects file: / ftp: / chrome: / about:", () => {
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("ftp://example.com")).toBe(false);
    expect(isSafeHref("chrome://settings")).toBe(false);
    expect(isSafeHref("about:blank")).toBe(false);
  });

  it("rejects unparseable strings (relative URLs, garbage)", () => {
    expect(isSafeHref("not a url")).toBe(false);
    expect(isSafeHref("/relative/path")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});
