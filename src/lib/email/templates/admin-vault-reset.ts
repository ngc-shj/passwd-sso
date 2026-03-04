import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    subject: "チーム管理者による保管庫リセットが開始されました",
    body: (adminName: string, teamName: string, resetUrl: string) =>
      `<p>チーム <strong>${teamName}</strong> の管理者 <strong>${adminName}</strong> があなたの保管庫のリセットを開始しました。</p>
       <p><strong>警告:</strong> このリセットは不可逆です。保管庫内のすべてのデータが削除されます。</p>
       <p>このリセットに同意する場合は、下のリンクをクリックして確認してください。リンクの有効期限は24時間です。</p>
       <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 20px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:6px;">保管庫リセットを確認する</a></p>
       <p style="color:#71717a;font-size:12px;">このリセットに心当たりがない場合は、チーム管理者に連絡してください。</p>`,
    text: (adminName: string, teamName: string, resetUrl: string) =>
      `チーム「${teamName}」の管理者「${adminName}」があなたの保管庫のリセットを開始しました。警告: このリセットは不可逆です。保管庫内のすべてのデータが削除されます。同意する場合は次のリンクをクリックしてください（有効期限24時間）: ${resetUrl}`,
  },
  en: {
    subject: "Vault reset initiated by your team admin",
    body: (adminName: string, teamName: string, resetUrl: string) =>
      `<p><strong>${adminName}</strong> (admin of team <strong>${teamName}</strong>) has initiated a reset of your vault.</p>
       <p><strong>Warning:</strong> This reset is irreversible. All data in your vault will be permanently deleted.</p>
       <p>If you agree to this reset, click the link below to confirm. The link expires in 24 hours.</p>
       <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 20px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:6px;">Confirm Vault Reset</a></p>
       <p style="color:#71717a;font-size:12px;">If you did not expect this reset, please contact your team admin.</p>`,
    text: (adminName: string, teamName: string, resetUrl: string) =>
      `${adminName} (admin of team "${teamName}") has initiated a reset of your vault. Warning: This reset is irreversible. All data in your vault will be permanently deleted. If you agree, visit (expires in 24h): ${resetUrl}`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function adminVaultResetEmail(
  locale: string,
  adminName: string,
  teamName: string,
  resetUrl: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.subject,
    html: emailLayout(l.body(escapeHtml(adminName), escapeHtml(teamName), resetUrl), locale),
    text: l.text(adminName, teamName, resetUrl),
  };
}
