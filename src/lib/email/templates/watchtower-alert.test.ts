import { describe, expect, it } from "vitest";
import { watchtowerAlertEmail } from "./watchtower-alert";

describe("watchtowerAlertEmail", () => {
  const appUrl = "https://app.example.com";

  describe("English", () => {
    it("generates correct subject", () => {
      const result = watchtowerAlertEmail("en", 3, appUrl);
      expect(result.subject).toBe("New data breach detected");
    });

    it("includes breach count in html body", () => {
      const result = watchtowerAlertEmail("en", 5, appUrl);
      expect(result.html).toContain("<strong>5</strong>");
      expect(result.html).toContain("entry(ies)");
    });

    it("includes watchtower link in html", () => {
      const result = watchtowerAlertEmail("en", 1, appUrl);
      expect(result.html).toContain(
        "https://app.example.com/en/dashboard/watchtower",
      );
    });

    it("includes breach count in text body", () => {
      const result = watchtowerAlertEmail("en", 2, appUrl);
      expect(result.text).toContain("2 entry(ies)");
      expect(result.text).toContain(
        "https://app.example.com/en/dashboard/watchtower",
      );
    });

    it("wraps in email layout", () => {
      const result = watchtowerAlertEmail("en", 1, appUrl);
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain('lang="en"');
    });
  });

  describe("Japanese", () => {
    it("generates correct subject", () => {
      const result = watchtowerAlertEmail("ja", 3, appUrl);
      expect(result.subject).toBe("新しいデータ漏洩が検出されました");
    });

    it("includes breach count in html body", () => {
      const result = watchtowerAlertEmail("ja", 5, appUrl);
      expect(result.html).toContain("<strong>5</strong>");
      expect(result.html).toContain("件のエントリ");
    });

    it("includes watchtower link for ja locale", () => {
      const result = watchtowerAlertEmail("ja", 1, appUrl);
      expect(result.html).toContain(
        "https://app.example.com/ja/dashboard/watchtower",
      );
    });

    it("wraps in email layout with ja locale", () => {
      const result = watchtowerAlertEmail("ja", 1, appUrl);
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain('lang="ja"');
    });
  });

  describe("validation", () => {
    it("throws on invalid appUrl scheme", () => {
      expect(() => watchtowerAlertEmail("en", 1, "javascript:alert(1)")).toThrow(
        "Invalid appUrl scheme",
      );
    });
  });
});
