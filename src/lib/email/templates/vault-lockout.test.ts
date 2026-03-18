import { describe, expect, it } from "vitest";
import { vaultLockoutEmail } from "./vault-lockout";

describe("vaultLockoutEmail", () => {
  const baseParams = {
    userEmail: "alice@example.com",
    attempts: 5,
    lockMinutes: 30,
    ipAddress: "203.0.113.42",
    timestamp: "2026-03-17T12:34:56Z",
  };

  describe("English", () => {
    it("generates correct subject", () => {
      const result = vaultLockoutEmail("en", baseParams);
      expect(result.subject).toBe("Vault lockout triggered");
    });

    it("contains all params in HTML body", () => {
      const result = vaultLockoutEmail("en", baseParams);
      expect(result.html).toContain(baseParams.userEmail);
      expect(result.html).toContain(String(baseParams.attempts));
      expect(result.html).toContain(String(baseParams.lockMinutes));
      expect(result.html).toContain(baseParams.ipAddress);
      expect(result.html).toContain(baseParams.timestamp);
    });

    it("contains all params in text body", () => {
      const result = vaultLockoutEmail("en", baseParams);
      expect(result.text).toContain(baseParams.userEmail);
      expect(result.text).toContain(String(baseParams.attempts));
      expect(result.text).toContain(String(baseParams.lockMinutes));
      expect(result.text).toContain(baseParams.ipAddress);
      expect(result.text).toContain(baseParams.timestamp);
    });

    it("wraps HTML in emailLayout", () => {
      const result = vaultLockoutEmail("en", baseParams);
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain('lang="en"');
    });
  });

  describe("Japanese", () => {
    it("generates correct subject", () => {
      const result = vaultLockoutEmail("ja", baseParams);
      expect(result.subject).toBe("保管庫のロックアウトが発生しました");
    });

    it("contains all params in HTML body", () => {
      const result = vaultLockoutEmail("ja", baseParams);
      expect(result.html).toContain(baseParams.userEmail);
      expect(result.html).toContain(String(baseParams.attempts));
      expect(result.html).toContain(String(baseParams.lockMinutes));
      expect(result.html).toContain(baseParams.ipAddress);
      expect(result.html).toContain(baseParams.timestamp);
    });

    it("contains all params in text body", () => {
      const result = vaultLockoutEmail("ja", baseParams);
      expect(result.text).toContain(baseParams.userEmail);
      expect(result.text).toContain(String(baseParams.attempts));
      expect(result.text).toContain(String(baseParams.lockMinutes));
      expect(result.text).toContain(baseParams.ipAddress);
      expect(result.text).toContain(baseParams.timestamp);
    });

    it("wraps HTML in emailLayout with ja locale", () => {
      const result = vaultLockoutEmail("ja", baseParams);
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain('lang="ja"');
    });
  });

  describe("XSS escaping", () => {
    it("escapes HTML special characters in userEmail", () => {
      const result = vaultLockoutEmail("en", {
        ...baseParams,
        userEmail: "<script>alert(1)</script>",
      });
      expect(result.html).toContain("&lt;script&gt;");
      expect(result.html).not.toContain("<script>alert(1)</script>");
    });

    it("escapes HTML special characters in ipAddress", () => {
      const result = vaultLockoutEmail("en", {
        ...baseParams,
        ipAddress: '<img src=x onerror="alert(1)">',
      });
      expect(result.html).toContain("&lt;img");
      expect(result.html).not.toContain("<img");
    });

    it("escapes HTML special characters in timestamp", () => {
      const result = vaultLockoutEmail("en", {
        ...baseParams,
        timestamp: '"><script>xss</script>',
      });
      expect(result.html).toContain("&quot;&gt;&lt;script&gt;");
      expect(result.html).not.toContain("<script>xss</script>");
    });
  });
});
