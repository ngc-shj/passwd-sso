import { describe, it, expect } from "vitest";
import { passkeyRevokedByAdminEmail } from "./passkey-revoked-by-admin";

describe("passkeyRevokedByAdminEmail", () => {
  it.each([
    ["en", "Your passkey was revoked"],
    ["ja", "パスキーが失効されました"],
  ])("%s: subject, and the admin name in both bodies", (locale, subject) => {
    const result = passkeyRevokedByAdminEmail(locale, "Alice Admin");
    expect(result.subject).toBe(subject);
    expect(result.html).toContain("Alice Admin");
    expect(result.text).toContain("Alice Admin");
  });

  it("escapes HTML in the admin name", () => {
    const result = passkeyRevokedByAdminEmail("en", "<script>xss</script>");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});
