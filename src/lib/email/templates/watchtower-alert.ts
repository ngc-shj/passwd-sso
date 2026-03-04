import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    subject: "新しいデータ漏洩が検出されました",
    body: (count: number, watchtowerUrl: string) =>
      `<p>Watchtower の自動監視により、保管庫内の <strong>${count}</strong> 件のエントリに関連する新しいデータ漏洩が検出されました。</p>
       <p>影響を受けたエントリのパスワードを速やかに変更することを推奨します。</p>
       <p><a href="${escapeHtml(watchtowerUrl)}" style="display:inline-block;padding:10px 20px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;">Watchtower を確認する</a></p>`,
    text: (count: number, watchtowerUrl: string) =>
      `Watchtower の自動監視により、保管庫内の ${count} 件のエントリに関連する新しいデータ漏洩が検出されました。影響を受けたエントリのパスワードを速やかに変更することを推奨します。確認: ${watchtowerUrl}`,
  },
  en: {
    subject: "New data breach detected",
    body: (count: number, watchtowerUrl: string) =>
      `<p>Watchtower auto-monitoring has detected new data breaches affecting <strong>${count}</strong> entry(ies) in your vault.</p>
       <p>We recommend changing the passwords of affected entries as soon as possible.</p>
       <p><a href="${escapeHtml(watchtowerUrl)}" style="display:inline-block;padding:10px 20px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;">View Watchtower</a></p>`,
    text: (count: number, watchtowerUrl: string) =>
      `Watchtower auto-monitoring has detected new data breaches affecting ${count} entry(ies) in your vault. We recommend changing the passwords of affected entries as soon as possible. View: ${watchtowerUrl}`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function watchtowerAlertEmail(
  locale: string,
  newBreachCount: number,
  appUrl: string,
): TemplateResult {
  const l = getLabels(locale);
  const watchtowerUrl = `${appUrl}/${locale}/dashboard/watchtower`;
  return {
    subject: l.subject,
    html: emailLayout(l.body(newBreachCount, watchtowerUrl), locale),
    text: l.text(newBreachCount, watchtowerUrl),
  };
}
