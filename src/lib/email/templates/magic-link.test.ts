import { describe, it, expect } from "vitest";
import { magicLinkEmail } from "./magic-link";

describe("magicLinkEmail", () => {
  const testUrl = "https://example.com/auth/verify?token=abc123";

  it("returns subject, html, and text for ja locale (default)", () => {
    const result = magicLinkEmail(testUrl);
    expect(result.subject).toBe("サインインリンク");
    expect(result.html).toContain(testUrl);
    expect(result.text).toContain(testUrl);
  });

  it("returns English content for en locale", () => {
    const result = magicLinkEmail(testUrl, "en");
    expect(result.subject).toBe("Sign-in link");
    expect(result.html).toContain("Sign in");
    expect(result.text).toContain("Sign in using the link below:");
  });

  it("defaults to ja locale", () => {
    const result = magicLinkEmail(testUrl);
    expect(result.html).toContain("サインイン");
  });

  it("falls back to en for unknown locale", () => {
    const result = magicLinkEmail(testUrl, "fr");
    expect(result.subject).toBe("Sign-in link");
  });

  it("escapes HTML special characters in URL", () => {
    const dangerousUrl = 'https://example.com?a=1&b=<script>alert("xss")</script>';
    const result = magicLinkEmail(dangerousUrl);
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("includes expiry notice in text body", () => {
    const result = magicLinkEmail(testUrl, "en");
    expect(result.text).toContain("24 hours");
  });

  it("includes ignore notice in text body", () => {
    const result = magicLinkEmail(testUrl, "en");
    expect(result.text).toContain("safely ignore");
  });
});
