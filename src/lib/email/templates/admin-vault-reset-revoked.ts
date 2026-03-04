import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    subject: "保管庫リセットが取り消されました",
    body: (adminName: string) =>
      `<p>テナント管理者 <strong>${adminName}</strong> があなたの保管庫リセットを取り消しました。</p>
       <p>対応は不要です。保管庫のデータに変更はありません。</p>`,
    text: (adminName: string) =>
      `テナント管理者「${adminName}」があなたの保管庫リセットを取り消しました。対応は不要です。保管庫のデータに変更はありません。`,
  },
  en: {
    subject: "Vault reset has been cancelled",
    body: (adminName: string) =>
      `<p><strong>${adminName}</strong> (a tenant admin) has cancelled the vault reset for your account.</p>
       <p>No action is required. Your vault data remains unchanged.</p>`,
    text: (adminName: string) =>
      `${adminName} (a tenant admin) has cancelled the vault reset for your account. No action is required. Your vault data remains unchanged.`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function adminVaultResetRevokedEmail(
  locale: string,
  adminName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.subject,
    html: emailLayout(l.body(escapeHtml(adminName)), locale),
    text: l.text(adminName),
  };
}
