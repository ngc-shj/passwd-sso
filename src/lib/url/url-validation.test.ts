import { describe, it, expect } from "vitest";
import {
  isSsrfSafeWebhookUrl,
  SSRF_URL_VALIDATION_MESSAGE,
} from "./url-validation";

describe("isSsrfSafeWebhookUrl", () => {
  describe("accepts safe public HTTPS URLs", () => {
    it.each([
      ["https://example.com/webhook"],
      ["https://api.example.com/v1/hook"],
      ["https://sub.domain.example.org/path?qs=1"],
      ["https://hooks.slack.com/services/T0/B0/abc"],
    ])("accepts %s", (url) => {
      expect(isSsrfSafeWebhookUrl(url)).toBe(true);
    });
  });

  describe("rejects non-HTTPS schemes", () => {
    it.each([
      ["http://example.com/"],
      ["ftp://example.com/"],
      ["javascript:alert(1)"],
      ["file:///etc/passwd"],
      ["data:text/plain,xss"],
    ])("rejects %s", (url) => {
      expect(isSsrfSafeWebhookUrl(url)).toBe(false);
    });
  });

  describe("rejects loopback / localhost hosts", () => {
    it.each([
      ["https://localhost/"],
      ["https://LOCALHOST/"],
      ["https://127.0.0.1/"],
      ["https://[::1]/"],
      ["https://0.0.0.0/"],
    ])("rejects %s", (url) => {
      expect(isSsrfSafeWebhookUrl(url)).toBe(false);
    });
  });

  describe("rejects internal TLDs", () => {
    it("rejects .local TLD", () => {
      expect(isSsrfSafeWebhookUrl("https://printer.local/")).toBe(false);
    });

    it("rejects .internal TLD", () => {
      expect(isSsrfSafeWebhookUrl("https://service.internal/")).toBe(false);
    });
  });

  describe("rejects IP literal hostnames", () => {
    it("rejects IPv4 literal", () => {
      expect(isSsrfSafeWebhookUrl("https://10.0.0.1/")).toBe(false);
    });

    it("rejects another IPv4 literal", () => {
      expect(isSsrfSafeWebhookUrl("https://192.168.1.1/")).toBe(false);
    });

    it("rejects IPv6 literal", () => {
      expect(isSsrfSafeWebhookUrl("https://[2001:db8::1]/")).toBe(false);
    });
  });

  describe("rejects malformed input", () => {
    it("rejects empty string", () => {
      expect(isSsrfSafeWebhookUrl("")).toBe(false);
    });

    it("rejects unparseable URL", () => {
      expect(isSsrfSafeWebhookUrl("not a url")).toBe(false);
    });
  });

  it("exposes a stable validation message constant", () => {
    expect(typeof SSRF_URL_VALIDATION_MESSAGE).toBe("string");
    expect(SSRF_URL_VALIDATION_MESSAGE).toMatch(/HTTPS/i);
  });
});
