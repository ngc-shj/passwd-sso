import { emailLayout, escapeHtml } from "./layout";

const LABELS = {
  ja: {
    subject: "新しいパスキーが登録されました",
    heading: "新しいパスキーが登録されました",
    body: "お使いのアカウントに新しいパスキーが登録されました。",
    device: "デバイス",
    registeredAt: "登録日時",
    warning: "この操作に心当たりがない場合は、直ちにアカウント設定からパスキーを削除してください。",
    textBody: "お使いのアカウントに新しいパスキーが登録されました。",
    textWarning: "この操作に心当たりがない場合は、直ちにアカウント設定からパスキーを削除してください。",
  },
  en: {
    subject: "New passkey registered",
    heading: "New passkey registered",
    body: "A new passkey has been registered to your account.",
    device: "Device",
    registeredAt: "Registered at",
    warning: "If you did not perform this action, please remove the passkey from your account settings immediately.",
    textBody: "A new passkey has been registered to your account.",
    textWarning: "If you did not perform this action, please remove the passkey from your account settings immediately.",
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function passkeyRegisteredEmail(
  deviceName: string,
  registeredAt: Date,
  locale: string = "ja",
): { subject: string; html: string; text: string } {
  const l = getLabels(locale);
  const safeDevice = escapeHtml(deviceName || "Unknown");
  const dateStr = registeredAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

  const html = emailLayout(
    `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">${l.heading}</h2>
    <p style="margin:0 0 16px;color:#3f3f46;line-height:1.6;">${l.body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;border:1px solid #e4e4e7;border-radius:6px;">
      <tr>
        <td style="padding:12px 16px;color:#71717a;font-size:13px;border-bottom:1px solid #e4e4e7;">${l.device}</td>
        <td style="padding:12px 16px;color:#18181b;font-size:13px;border-bottom:1px solid #e4e4e7;">${safeDevice}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;color:#71717a;font-size:13px;">${l.registeredAt}</td>
        <td style="padding:12px 16px;color:#18181b;font-size:13px;">${dateStr}</td>
      </tr>
    </table>
    <p style="margin:0;color:#dc2626;font-size:13px;line-height:1.6;">${l.warning}</p>
    `,
    locale,
  );

  const text = [
    l.textBody,
    "",
    `${l.device}: ${deviceName || "Unknown"}`,
    `${l.registeredAt}: ${dateStr}`,
    "",
    l.textWarning,
  ].join("\n");

  return { subject: l.subject, html, text };
}
