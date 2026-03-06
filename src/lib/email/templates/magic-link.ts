import { emailLayout, escapeHtml } from "./layout";

const LABELS = {
  ja: {
    subject: "サインインリンク",
    heading: "サインインリンク",
    body: "以下のボタンをクリックしてサインインしてください。",
    button: "サインイン",
    expires: "このリンクは24時間有効です。",
    ignore: "このメールに心当たりがない場合は、無視してください。",
    fallback: "ボタンが動作しない場合は、以下のURLをブラウザに貼り付けてください:",
    textBody: "以下のリンクからサインインしてください:",
    textExpires: "このリンクは24時間有効です。",
    textIgnore: "このメールに心当たりがない場合は、無視してください。",
  },
  en: {
    subject: "Sign-in link",
    heading: "Sign-in link",
    body: "Click the button below to sign in.",
    button: "Sign in",
    expires: "This link is valid for 24 hours.",
    ignore: "If you did not request this email, you can safely ignore it.",
    fallback: "If the button doesn't work, paste this URL into your browser:",
    textBody: "Sign in using the link below:",
    textExpires: "This link is valid for 24 hours.",
    textIgnore: "If you did not request this email, you can safely ignore it.",
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function magicLinkEmail(
  url: string,
  locale: string = "ja",
): { subject: string; html: string; text: string } {
  const l = getLabels(locale);
  const safeUrl = escapeHtml(url);

  const html = emailLayout(
    `
    <h2 style="margin:0 0 16px;font-size:20px;color:#18181b;">${l.heading}</h2>
    <p style="margin:0 0 24px;color:#3f3f46;line-height:1.6;">${l.body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#18181b;border-radius:6px;padding:12px 32px;">
        <a href="${safeUrl}" style="color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;">${l.button}</a>
      </td></tr>
    </table>
    <p style="margin:0 0 8px;color:#71717a;font-size:13px;">${l.expires}</p>
    <p style="margin:0 0 16px;color:#71717a;font-size:13px;">${l.ignore}</p>
    <p style="margin:0 0 4px;color:#a1a1aa;font-size:12px;">${l.fallback}</p>
    <p style="margin:0;word-break:break-all;color:#a1a1aa;font-size:12px;">
      <a href="${safeUrl}" style="color:#a1a1aa;">${safeUrl}</a>
    </p>
    `,
    locale,
  );

  const text = [
    l.textBody,
    url,
    "",
    l.textExpires,
    l.textIgnore,
  ].join("\n");

  return { subject: l.subject, html, text };
}
