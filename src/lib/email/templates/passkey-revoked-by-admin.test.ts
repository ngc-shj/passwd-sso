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

  it.each([
    ["en", "All your sessions were ended", "ended all your sessions", "register a new passkey"],
    ["ja", "すべてのセッションが終了されました", "すべてのセッションを終了しました", "新しいパスキーを登録"],
  ] as const)("%s, no passkeys: says only that the sessions ended, with no new-passkey line", (locale, subject, what, newPasskey) => {
    const result = passkeyRevokedByAdminEmail(locale, "Alice Admin", "sessions");
    expect(result.subject).toBe(subject);
    expect(result.html).toContain(what);
    expect(result.text).toContain(what);
    expect(result.html).not.toContain(newPasskey);
    expect(result.text).not.toContain(newPasskey);
    expect(result.text).not.toMatch(/passkey|パスキー/i);
  });

  it.each(["one", "all"] as const)("%s: keeps the new-passkey line", (extent) => {
    expect(passkeyRevokedByAdminEmail("en", "Alice Admin", extent).text).toContain("register a new passkey");
    expect(passkeyRevokedByAdminEmail("ja", "Alice Admin", extent).text).toContain("新しいパスキーを登録");
  });

  it("escapes HTML in the admin name", () => {
    const result = passkeyRevokedByAdminEmail("en", "<script>xss</script>", "one");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});
