import { emailLayout, escapeHtml } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

/**
 * One passkey revoked, all of them, or — revoke-all on a member with none —
 * only the sessions ended.
 */
export type PasskeyRevokeExtent = "one" | "all" | "sessions";

const LABELS = {
  ja: {
    subject: {
      one: "パスキーが失効されました",
      all: "パスキーがすべて失効されました",
      sessions: "すべてのセッションが終了されました",
    },
    what: {
      one: "あなたのパスキーを1つ失効し、すべてのセッションを終了しました",
      all: "あなたのパスキーをすべて失効し、すべてのセッションを終了しました",
      sessions: "あなたのすべてのセッションを終了しました",
    },
    newPasskey: "別の方法でサインインし、新しいパスキーを登録できます。",
    body: (adminName: string, what: string, newPasskey: string) =>
      `<p>テナント管理者 <strong>${adminName}</strong> が${what}。</p>
       <p>心当たりがない場合は、テナント管理者に確認してください。${newPasskey}</p>`,
    text: (adminName: string, what: string, newPasskey: string) =>
      `テナント管理者「${adminName}」が${what}。心当たりがない場合は、テナント管理者に確認してください。${newPasskey}`,
  },
  en: {
    subject: {
      one: "Your passkey was revoked",
      all: "All your passkeys were revoked",
      sessions: "All your sessions were ended",
    },
    what: {
      one: "revoked one of your passkeys and ended all your sessions",
      all: "revoked all of your passkeys and ended all your sessions",
      sessions: "ended all your sessions",
    },
    newPasskey: " You can sign in another way and register a new passkey.",
    body: (adminName: string, what: string, newPasskey: string) =>
      `<p><strong>${adminName}</strong> (a tenant admin) ${what}.</p>
       <p>If you did not expect this, contact your tenant admin.${newPasskey}</p>`,
    text: (adminName: string, what: string, newPasskey: string) =>
      `${adminName} (a tenant admin) ${what}. If you did not expect this, contact your tenant admin.${newPasskey}`,
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

export function passkeyRevokedByAdminEmail(
  locale: string,
  adminName: string,
  extent: PasskeyRevokeExtent,
): TemplateResult {
  const l = getLabels(locale);
  // The new-passkey line only when a passkey was removed.
  const newPasskey = extent === "sessions" ? "" : l.newPasskey;
  return {
    subject: l.subject[extent],
    html: emailLayout(l.body(escapeHtml(adminName), l.what[extent], newPasskey), locale),
    text: l.text(adminName, l.what[extent], newPasskey),
  };
}
