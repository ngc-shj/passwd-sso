import { describe, it, expect } from "vitest";
import { adminVaultResetRevokedEmail } from "./admin-vault-reset-revoked";

describe("adminVaultResetRevokedEmail", () => {
  const adminName = "Alice Admin";

  describe("en locale", () => {
    it("returns English subject", () => {
      const result = adminVaultResetRevokedEmail("en", adminName);
      expect(result.subject).toBe("Vault reset has been cancelled");
    });

    it("includes admin name in HTML body", () => {
      const result = adminVaultResetRevokedEmail("en", adminName);
      expect(result.html).toContain("Alice Admin");
    });

    it("includes admin name in text body", () => {
      const result = adminVaultResetRevokedEmail("en", adminName);
      expect(result.text).toContain("Alice Admin");
    });
  });

  describe("ja locale", () => {
    it("returns Japanese subject containing 取り消し", () => {
      const result = adminVaultResetRevokedEmail("ja", adminName);
      expect(result.subject).toContain("取り消されました");
    });

    it("includes admin name in HTML body", () => {
      const result = adminVaultResetRevokedEmail("ja", adminName);
      expect(result.html).toContain("Alice Admin");
    });
  });

  it("escapes HTML special characters in admin name", () => {
    const result = adminVaultResetRevokedEmail("en", "<script>xss</script>");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("falls back to English for unknown locale", () => {
    const result = adminVaultResetRevokedEmail("fr", adminName);
    expect(result.subject).toBe("Vault reset has been cancelled");
  });
});
