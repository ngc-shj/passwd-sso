import { describe, it, expect } from "vitest";
import { adminVaultResetEmail } from "./admin-vault-reset";

describe("adminVaultResetEmail", () => {
  const adminName = "Alice Admin";
  const resetUrl = "https://example.com/en/vault-reset/admin#token=abc123";

  describe("en locale", () => {
    it("returns English subject", () => {
      const result = adminVaultResetEmail("en", adminName, resetUrl);
      expect(result.subject).toBe("Vault reset initiated by an admin");
    });

    it("includes admin name in HTML body", () => {
      const result = adminVaultResetEmail("en", adminName, resetUrl);
      expect(result.html).toContain("Alice Admin");
    });

    it("includes reset URL in HTML body", () => {
      const result = adminVaultResetEmail("en", adminName, resetUrl);
      expect(result.html).toContain(resetUrl);
    });

    it("includes irreversibility warning in text", () => {
      const result = adminVaultResetEmail("en", adminName, resetUrl);
      expect(result.text).toContain("irreversible");
    });

    it("includes reset URL in text body", () => {
      const result = adminVaultResetEmail("en", adminName, resetUrl);
      expect(result.text).toContain(resetUrl);
    });
  });

  describe("ja locale", () => {
    it("returns Japanese subject", () => {
      const result = adminVaultResetEmail("ja", adminName, resetUrl);
      expect(result.subject).toContain("保管庫リセット");
    });

    it("includes admin name in HTML body", () => {
      const result = adminVaultResetEmail("ja", adminName, resetUrl);
      expect(result.html).toContain("Alice Admin");
    });

    it("includes warning in text", () => {
      const result = adminVaultResetEmail("ja", adminName, resetUrl);
      expect(result.text).toContain("不可逆");
    });
  });

  it("escapes HTML special characters in names", () => {
    const result = adminVaultResetEmail("en", "<script>xss</script>", resetUrl);
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("includes raw admin name in text body (no HTML escaping)", () => {
    const result = adminVaultResetEmail("en", "<script>xss</script>", "https://example.com/reset#token=abc");
    expect(result.text).toContain("<script>xss</script>");
  });

  it("falls back to English for unknown locale", () => {
    const result = adminVaultResetEmail("fr", adminName, resetUrl);
    expect(result.subject).toBe("Vault reset initiated by an admin");
  });
});
