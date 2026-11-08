import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

/** One passkey revoked, or all of them. */
export type PasskeyRevokeExtent = "one" | "all";

const LABELS = {
  ja: {
    subject: { one: "パスキーが失効されました", all: "パスキーがすべて失効されました" },
    what: { one: "あなたのパスキーを1つ失効し", all: "あなたのパスキーをすべて失効し" },
    body: (adminName: string, what: string) =>
      `<p>テナント管理者 <strong>${adminName}</strong> が${what}、すべてのセッションを終了しました。</p>
       <p>心当たりがない場合は、テナント管理者に確認してください。別の方法でサインインし、新しいパスキーを登録できます。</p>`,
    text: (adminName: string, what: string) =>
      `テナント管理者「${adminName}」が${what}、すべてのセッションを終了しました。心当たりがない場合は、テナント管理者に確認してください。別の方法でサインインし、新しいパスキーを登録できます。`,
  },
  en: {
    subject: { one: "Your passkey was revoked", all: "All your passkeys were revoked" },
    what: { one: "revoked one of your passkeys", all: "revoked all of your passkeys" },
    body: (adminName: string, what: string) =>
      `<p><strong>${adminName}</strong> (a tenant admin) ${what} and ended all your sessions.</p>
       <p>If you did not expect this, contact your tenant admin. You can sign in another way and register a new passkey.</p>`,
    text: (adminName: string, what: string) =>
      `${adminName} (a tenant admin) ${what} and ended all your sessions. If you did not expect this, contact your tenant admin. You can sign in another way and register a new passkey.`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function passkeyRevokedByAdminEmail(
  locale: string,
  adminName: string,
  extent: PasskeyRevokeExtent,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.subject[extent],
    html: emailLayout(l.body(escapeHtml(adminName), l.what[extent]), locale),
    text: l.text(adminName, l.what[extent]),
  };
}
