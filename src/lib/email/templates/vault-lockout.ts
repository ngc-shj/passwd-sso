import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

interface VaultLockoutParams {
  userEmail: string;
  attempts: number;
  lockMinutes: number;
  ipAddress: string;
  timestamp: string;
}

const LABELS = {
  ja: {
    subject: "保管庫のロックアウトが発生しました",
    body: (p: VaultLockoutParams) =>
      `<p>以下のユーザーの保管庫がロックアウトされました。</p>
       <table style="border-collapse:collapse;margin:16px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#666;">対象ユーザー</td><td style="padding:4px 0;"><strong>${p.userEmail}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">試行回数</td><td style="padding:4px 0;"><strong>${p.attempts}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">ロック時間</td><td style="padding:4px 0;"><strong>${p.lockMinutes} 分</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">IPアドレス</td><td style="padding:4px 0;"><strong>${p.ipAddress}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">日時</td><td style="padding:4px 0;"><strong>${p.timestamp}</strong></td></tr>
       </table>
       <p>不正なアクセスの試みである可能性があります。確認してください。</p>`,
    text: (p: VaultLockoutParams) =>
      `以下のユーザーの保管庫がロックアウトされました。\n\n対象ユーザー: ${p.userEmail}\n試行回数: ${p.attempts}\nロック時間: ${p.lockMinutes} 分\nIPアドレス: ${p.ipAddress}\n日時: ${p.timestamp}\n\n不正なアクセスの試みである可能性があります。確認してください。`,
  },
  en: {
    subject: "Vault lockout triggered",
    body: (p: VaultLockoutParams) =>
      `<p>A vault lockout has been triggered for the following user.</p>
       <table style="border-collapse:collapse;margin:16px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Affected user</td><td style="padding:4px 0;"><strong>${p.userEmail}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Attempts</td><td style="padding:4px 0;"><strong>${p.attempts}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Lock duration</td><td style="padding:4px 0;"><strong>${p.lockMinutes} minutes</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">IP Address</td><td style="padding:4px 0;"><strong>${p.ipAddress}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Time</td><td style="padding:4px 0;"><strong>${p.timestamp}</strong></td></tr>
       </table>
       <p>This may indicate an unauthorized access attempt. Please investigate.</p>`,
    text: (p: VaultLockoutParams) =>
      `A vault lockout has been triggered for the following user.\n\nAffected user: ${p.userEmail}\nAttempts: ${p.attempts}\nLock duration: ${p.lockMinutes} minutes\nIP Address: ${p.ipAddress}\nTime: ${p.timestamp}\n\nThis may indicate an unauthorized access attempt. Please investigate.`,
  },
};

function getLabels(locale: string) {
  return locale.startsWith("ja") ? LABELS.ja : LABELS.en;
}

export function vaultLockoutEmail(
  locale: string,
  params: VaultLockoutParams,
): TemplateResult {
  const l = getLabels(locale);
  const safe: VaultLockoutParams = {
    userEmail: escapeHtml(params.userEmail),
    attempts: params.attempts,
    lockMinutes: params.lockMinutes,
    ipAddress: escapeHtml(params.ipAddress),
    timestamp: escapeHtml(params.timestamp),
  };
  // attempts and lockMinutes are numbers; escapeHtml is applied via String() conversion
  // in the body template they render as numeric literals — safe without escaping
  return {
    subject: l.subject,
    html: emailLayout(l.body(safe), locale),
    text: l.text(params),
  };
}
