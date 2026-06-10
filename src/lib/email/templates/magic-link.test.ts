import { describe, it, expect } from "vitest";
import { magicLinkEmail } from "./magic-link";
import { MAGIC_LINK_TTL_MINUTES } from "@/lib/constants/auth/magic-link";

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

  it("includes expiry notice in text body derived from MAGIC_LINK_TTL_MINUTES constant", () => {
    const result = magicLinkEmail(testUrl, "en");
    expect(result.text).toContain(`${MAGIC_LINK_TTL_MINUTES} minutes`);
    expect(result.text).not.toContain("24 hours");
  });

  it("includes expiry notice in ja text body derived from MAGIC_LINK_TTL_MINUTES constant", () => {
    const result = magicLinkEmail(testUrl, "ja");
    expect(result.text).toContain(`${MAGIC_LINK_TTL_MINUTES}分間有効`);
    expect(result.text).not.toContain("24時間有効");
  });

  it("includes ignore notice in text body", () => {
    const result = magicLinkEmail(testUrl, "en");
    expect(result.text).toContain("safely ignore");
  });
});
