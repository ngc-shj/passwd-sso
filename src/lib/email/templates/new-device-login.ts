import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

interface NewDeviceParams {
  browserName: string;
  osName: string;
  ipAddress: string;
  timestamp: string;
}

const LABELS = {
  ja: {
    subject: "新しいデバイスからのログインがありました",
    body: (p: NewDeviceParams) =>
      `<p>新しいデバイスからアカウントへのログインが検出されました。</p>
       <table style="border-collapse:collapse;margin:16px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#666;">ブラウザ</td><td style="padding:4px 0;"><strong>${p.browserName}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">OS</td><td style="padding:4px 0;"><strong>${p.osName}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">IPアドレス</td><td style="padding:4px 0;"><strong>${p.ipAddress}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">日時</td><td style="padding:4px 0;"><strong>${p.timestamp}</strong></td></tr>
       </table>
       <p>心当たりがない場合は、すぐにパスワードを変更してください。</p>`,
    text: (p: NewDeviceParams) =>
      `新しいデバイスからアカウントへのログインが検出されました。\n\nブラウザ: ${p.browserName}\nOS: ${p.osName}\nIPアドレス: ${p.ipAddress}\n日時: ${p.timestamp}\n\n心当たりがない場合は、すぐにパスワードを変更してください。`,
  },
  en: {
    subject: "New device login detected",
    body: (p: NewDeviceParams) =>
      `<p>A new device was used to sign in to your account.</p>
       <table style="border-collapse:collapse;margin:16px 0;">
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Browser</td><td style="padding:4px 0;"><strong>${p.browserName}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">OS</td><td style="padding:4px 0;"><strong>${p.osName}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">IP Address</td><td style="padding:4px 0;"><strong>${p.ipAddress}</strong></td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#666;">Time</td><td style="padding:4px 0;"><strong>${p.timestamp}</strong></td></tr>
       </table>
       <p>If this wasn't you, please change your password immediately.</p>`,
    text: (p: NewDeviceParams) =>
      `A new device was used to sign in to your account.\n\nBrowser: ${p.browserName}\nOS: ${p.osName}\nIP Address: ${p.ipAddress}\nTime: ${p.timestamp}\n\nIf this wasn't you, please change your password immediately.`,
  },
};

function getLabels(locale: string) {
  return locale.startsWith("ja") ? LABELS.ja : LABELS.en;
}

export function newDeviceLoginEmail(
  locale: string,
  params: NewDeviceParams,
): TemplateResult {
  const l = getLabels(locale);
  const safe = {
    browserName: escapeHtml(params.browserName),
    osName: escapeHtml(params.osName),
    ipAddress: escapeHtml(params.ipAddress),
    timestamp: escapeHtml(params.timestamp),
  };
  return {
    subject: l.subject,
    html: emailLayout(l.body(safe), locale),
    text: l.text(params),
  };
}
