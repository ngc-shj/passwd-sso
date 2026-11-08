import { describe, it, expect } from "vitest";
import { passkeyRevokedByAdminEmail } from "./passkey-revoked-by-admin";

describe("passkeyRevokedByAdminEmail", () => {
  it.each([
    ["en", "one", "Your passkey was revoked", "revoked one of your passkeys"],
    ["ja", "one", "パスキーが失効されました", "パスキーを1つ失効し"],
    ["en", "all", "All your passkeys were revoked", "revoked all of your passkeys"],
    ["ja", "all", "パスキーがすべて失効されました", "パスキーをすべて失効し"],
  ] as const)("%s, %s: subject, what was revoked and the admin name in both bodies", (locale, extent, subject, what) => {
    const result = passkeyRevokedByAdminEmail(locale, "Alice Admin", extent);
    expect(result.subject).toBe(subject);
    expect(result.html).toContain(what);
    expect(result.text).toContain(what);
    expect(result.html).toContain("Alice Admin");
    expect(result.text).toContain("Alice Admin");
  });

  it("escapes HTML in the admin name", () => {
    const result = passkeyRevokedByAdminEmail("en", "<script>xss</script>", "one");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});
