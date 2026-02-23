import { describe, it, expect } from "vitest";
import { emailLayout, escapeHtml } from "./layout";

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml('<script>"alert(\'xss\')&"</script>')).toBe(
      "&lt;script&gt;&quot;alert(&#39;xss&#39;)&amp;&quot;&lt;/script&gt;",
    );
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("emailLayout", () => {
  it("renders with ja locale", () => {
    const html = emailLayout("<p>Test</p>", "ja");
    expect(html).toContain('lang="ja"');
    expect(html).toContain("<p>Test</p>");
    expect(html).toContain("自動送信");
  });

  it("renders with en locale", () => {
    const html = emailLayout("<p>Test</p>", "en");
    expect(html).toContain('lang="en"');
    expect(html).toContain("sent automatically");
  });

  it("falls back to ja for unsupported locale", () => {
    const html = emailLayout("<p>Test</p>", "fr");
    expect(html).toContain('lang="ja"');
    expect(html).toContain("自動送信");
  });

  it("sanitizes malicious locale to prevent XSS", () => {
    const malicious = '"><script>alert(1)</script><html lang="';
    const html = emailLayout("<p>Test</p>", malicious);
    // Should fall back to ja, not inject the malicious string
    expect(html).toContain('lang="ja"');
    expect(html).not.toContain("<script>");
  });

  it("defaults to ja when locale is omitted", () => {
    const html = emailLayout("<p>Test</p>");
    expect(html).toContain('lang="ja"');
  });
});
