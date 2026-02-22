const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "passwd-sso";

const FOOTER: Record<string, string> = {
  ja: "このメールはシステムにより自動送信されています。",
  en: "This email was sent automatically by the system.",
};

export function emailLayout(
  body: string,
  locale: string = "ja",
): string {
  const footer = FOOTER[locale] ?? FOOTER.en;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;font-family:sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#18181b;padding:20px 24px;">
          <span style="color:#ffffff;font-size:18px;font-weight:bold;">${appName}</span>
        </td></tr>
        <tr><td style="padding:24px;">${body}</td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;">
          ${footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
