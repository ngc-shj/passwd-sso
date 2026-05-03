import { describe, it, expect } from "vitest";
import { adminVaultResetPendingEmail } from "./admin-vault-reset-pending";

describe("adminVaultResetPendingEmail", () => {
  const initiator = "Alice Admin";
  const target = "user@example.com";

  describe("en locale", () => {
    it("returns the English subject", () => {
      const result = adminVaultResetPendingEmail("en", initiator, target);
      expect(result.subject).toBe("Vault reset awaiting approval");
    });

    it("includes the initiator name in the HTML body", () => {
      const result = adminVaultResetPendingEmail("en", initiator, target);
      expect(result.html).toContain("Alice Admin");
    });

    it("includes the target email in the HTML body", () => {
      const result = adminVaultResetPendingEmail("en", initiator, target);
      expect(result.html).toContain("user@example.com");
    });

    it("mentions second admin approval requirement in the text body", () => {
      const result = adminVaultResetPendingEmail("en", initiator, target);
      expect(result.text).toContain("second admin");
    });
  });

  describe("ja locale", () => {
    it("returns the Japanese subject", () => {
      const result = adminVaultResetPendingEmail("ja", initiator, target);
      expect(result.subject).toBe("保管庫リセット承認待ち");
    });

    it("includes the initiator name in the HTML body", () => {
      const result = adminVaultResetPendingEmail("ja", initiator, target);
      expect(result.html).toContain("Alice Admin");
    });

    it("mentions approval requirement in the text body", () => {
      const result = adminVaultResetPendingEmail("ja", initiator, target);
      expect(result.text).toContain("承認");
    });
  });

  it("escapes HTML special characters in the initiator name", () => {
    const result = adminVaultResetPendingEmail(
      "en",
      "<script>xss</script>",
      target,
    );
    expect(result.html).not.toContain("<script>xss</script>");
    expect(result.html).toContain("&lt;script&gt;xss&lt;/script&gt;");
  });

  it("escapes HTML special characters in the target email", () => {
    const result = adminVaultResetPendingEmail(
      "en",
      initiator,
      "<img src=x>@example.com",
    );
    expect(result.html).not.toContain("<img src=x>");
    expect(result.html).toContain("&lt;img src=x&gt;");
  });

  it("does NOT HTML-escape values in the plain text body", () => {
    const result = adminVaultResetPendingEmail(
      "en",
      "<raw>",
      "<raw>@example.com",
    );
    expect(result.text).toContain("<raw>");
    expect(result.text).toContain("<raw>@example.com");
  });

  it("falls back to English for unknown locale", () => {
    const result = adminVaultResetPendingEmail("fr", initiator, target);
    expect(result.subject).toBe("Vault reset awaiting approval");
  });
});
