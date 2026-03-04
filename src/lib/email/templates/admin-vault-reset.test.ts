import { describe, it, expect } from "vitest";
import { adminVaultResetEmail } from "./admin-vault-reset";

describe("adminVaultResetEmail", () => {
  const adminName = "Alice Admin";
  const teamName = "Engineering";
  const resetUrl = "https://example.com/en/dashboard/vault-reset#token=abc123";

  describe("en locale", () => {
    it("returns English subject", () => {
      const result = adminVaultResetEmail("en", adminName, teamName, resetUrl);
      expect(result.subject).toBe("Vault reset initiated by your team admin");
    });

    it("includes admin name and team name in HTML body", () => {
      const result = adminVaultResetEmail("en", adminName, teamName, resetUrl);
      expect(result.html).toContain("Alice Admin");
      expect(result.html).toContain("Engineering");
    });

    it("includes reset URL in HTML body", () => {
      const result = adminVaultResetEmail("en", adminName, teamName, resetUrl);
      expect(result.html).toContain(resetUrl);
    });

    it("includes irreversibility warning in text", () => {
      const result = adminVaultResetEmail("en", adminName, teamName, resetUrl);
      expect(result.text).toContain("irreversible");
    });

    it("includes reset URL in text body", () => {
      const result = adminVaultResetEmail("en", adminName, teamName, resetUrl);
      expect(result.text).toContain(resetUrl);
    });
  });

  describe("ja locale", () => {
    it("returns Japanese subject", () => {
      const result = adminVaultResetEmail("ja", adminName, teamName, resetUrl);
      expect(result.subject).toContain("保管庫リセット");
    });

    it("includes admin and team in HTML body", () => {
      const result = adminVaultResetEmail("ja", adminName, teamName, resetUrl);
      expect(result.html).toContain("Alice Admin");
      expect(result.html).toContain("Engineering");
    });

    it("includes warning in text", () => {
      const result = adminVaultResetEmail("ja", adminName, teamName, resetUrl);
      expect(result.text).toContain("不可逆");
    });
  });

  it("escapes HTML special characters in names", () => {
    const result = adminVaultResetEmail("en", "<script>xss</script>", "Team & Co", resetUrl);
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("Team &amp; Co");
  });

  it("falls back to English for unknown locale", () => {
    const result = adminVaultResetEmail("fr", adminName, teamName, resetUrl);
    expect(result.subject).toBe("Vault reset initiated by your team admin");
  });
});
