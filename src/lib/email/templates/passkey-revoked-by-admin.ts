import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    subject: "パスキーが失効されました",
    body: (adminName: string) =>
      `<p>テナント管理者 <strong>${adminName}</strong> があなたのパスキーを1つ失効し、すべてのセッションを終了しました。</p>
       <p>心当たりがない場合は、テナント管理者に確認してください。別の方法でサインインし、新しいパスキーを登録できます。</p>`,
    text: (adminName: string) =>
      `テナント管理者「${adminName}」があなたのパスキーを1つ失効し、すべてのセッションを終了しました。心当たりがない場合は、テナント管理者に確認してください。別の方法でサインインし、新しいパスキーを登録できます。`,
  },
  en: {
    subject: "Your passkey was revoked",
    body: (adminName: string) =>
      `<p><strong>${adminName}</strong> (a tenant admin) revoked one of your passkeys and ended all your sessions.</p>
       <p>If you did not expect this, contact your tenant admin. You can sign in another way and register a new passkey.</p>`,
    text: (adminName: string) =>
      `${adminName} (a tenant admin) revoked one of your passkeys and ended all your sessions. If you did not expect this, contact your tenant admin. You can sign in another way and register a new passkey.`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function passkeyRevokedByAdminEmail(locale: string, adminName: string): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.subject,
    html: emailLayout(l.body(escapeHtml(adminName)), locale),
    text: l.text(adminName),
  };
}
