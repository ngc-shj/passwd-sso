import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    subject: "保管庫リセット承認待ち",
    body: (initiatorName: string, targetEmail: string) =>
      `<p>管理者 <strong>${initiatorName}</strong> が ${targetEmail} の保管庫リセットを開始しました。</p>
       <p>このリセットを実行するには、別の管理者による承認が必要です。あなたが承認可能な管理者として通知を受け取っています。</p>
       <p>テナント設定の「メンバー」画面から該当ユーザーのリセット履歴を開き、内容を確認のうえ承認してください。</p>
       <p style="color:#71717a;font-size:12px;">心当たりがない場合は、開始した管理者に連絡し、必要に応じてリセットを取り消してください。</p>`,
    text: (initiatorName: string, targetEmail: string) =>
      `管理者「${initiatorName}」が ${targetEmail} の保管庫リセットを開始しました。実行には別の管理者の承認が必要です。テナント設定 > メンバー > リセット履歴から確認・承認してください。`,
  },
  en: {
    subject: "Vault reset awaiting approval",
    body: (initiatorName: string, targetEmail: string) =>
      `<p><strong>${initiatorName}</strong> has initiated a vault reset for ${targetEmail}.</p>
       <p>A second admin must approve this reset before it can be executed. You are receiving this because you are eligible to approve.</p>
       <p>Open Tenant Settings &rarr; Members &rarr; Reset History for the target user, review the request, and approve if appropriate.</p>
       <p style="color:#71717a;font-size:12px;">If you did not expect this, contact the initiator and revoke the reset.</p>`,
    text: (initiatorName: string, targetEmail: string) =>
      `${initiatorName} has initiated a vault reset for ${targetEmail}. A second admin must approve before it can be executed. Review under Tenant Settings > Members > Reset History.`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function adminVaultResetPendingEmail(
  locale: string,
  initiatorName: string,
  targetEmail: string,
): TemplateResult {
  const l = getLabels(locale);
  const safeInitiator = escapeHtml(initiatorName);
  const safeTarget = escapeHtml(targetEmail);
  return {
    subject: l.subject,
    html: emailLayout(l.body(safeInitiator, safeTarget), locale),
    text: l.text(initiatorName, targetEmail),
  };
}
