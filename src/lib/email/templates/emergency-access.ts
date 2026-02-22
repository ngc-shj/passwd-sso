import { emailLayout } from "./layout";

interface TemplateResult {
  subject: string;
  html: string;
  text: string;
}

const LABELS = {
  ja: {
    invite: {
      subject: "緊急アクセスの招待を受けました",
      body: (ownerName: string) =>
        `<p><strong>${ownerName}</strong> さんがあなたを緊急アクセスの連絡先として指定しました。</p>
         <p>アプリにログインして招待を確認してください。</p>`,
      text: (ownerName: string) =>
        `${ownerName} さんがあなたを緊急アクセスの連絡先として指定しました。アプリにログインして招待を確認してください。`,
    },
    accepted: {
      subject: "緊急アクセスの招待が承諾されました",
      body: (granteeName: string) =>
        `<p><strong>${granteeName}</strong> さんが緊急アクセスの招待を承諾しました。</p>`,
      text: (granteeName: string) =>
        `${granteeName} さんが緊急アクセスの招待を承諾しました。`,
    },
    declined: {
      subject: "緊急アクセスの招待が辞退されました",
      body: (granteeName: string) =>
        `<p><strong>${granteeName}</strong> さんが緊急アクセスの招待を辞退しました。</p>`,
      text: (granteeName: string) =>
        `${granteeName} さんが緊急アクセスの招待を辞退しました。`,
    },
    requested: {
      subject: "緊急アクセスがリクエストされました",
      body: (granteeName: string, waitDays: number) =>
        `<p><strong>${granteeName}</strong> さんが緊急アクセスをリクエストしました。</p>
         <p>待機期間: <strong>${waitDays} 日</strong></p>
         <p>待機期間が経過すると、自動的にアクセスが有効になります。すぐに承認することもできます。</p>`,
      text: (granteeName: string, waitDays: number) =>
        `${granteeName} さんが緊急アクセスをリクエストしました。待機期間: ${waitDays} 日。待機期間が経過すると、自動的にアクセスが有効になります。`,
    },
    approved: {
      subject: "緊急アクセスが承認されました",
      body: (ownerName: string) =>
        `<p><strong>${ownerName}</strong> さんの保管庫への緊急アクセスが承認されました。</p>
         <p>アプリにログインして保管庫にアクセスしてください。</p>`,
      text: (ownerName: string) =>
        `${ownerName} さんの保管庫への緊急アクセスが承認されました。アプリにログインして保管庫にアクセスしてください。`,
    },
    revoked: {
      subject: "緊急アクセスが取り消されました",
      body: (ownerName: string) =>
        `<p><strong>${ownerName}</strong> さんが緊急アクセスを取り消しました。</p>`,
      text: (ownerName: string) =>
        `${ownerName} さんが緊急アクセスを取り消しました。`,
    },
  },
  en: {
    invite: {
      subject: "You've been invited as an emergency contact",
      body: (ownerName: string) =>
        `<p><strong>${ownerName}</strong> has designated you as an emergency access contact.</p>
         <p>Please log in to the app to review the invitation.</p>`,
      text: (ownerName: string) =>
        `${ownerName} has designated you as an emergency access contact. Please log in to the app to review the invitation.`,
    },
    accepted: {
      subject: "Emergency access invitation accepted",
      body: (granteeName: string) =>
        `<p><strong>${granteeName}</strong> has accepted your emergency access invitation.</p>`,
      text: (granteeName: string) =>
        `${granteeName} has accepted your emergency access invitation.`,
    },
    declined: {
      subject: "Emergency access invitation declined",
      body: (granteeName: string) =>
        `<p><strong>${granteeName}</strong> has declined your emergency access invitation.</p>`,
      text: (granteeName: string) =>
        `${granteeName} has declined your emergency access invitation.`,
    },
    requested: {
      subject: "Emergency access has been requested",
      body: (granteeName: string, waitDays: number) =>
        `<p><strong>${granteeName}</strong> has requested emergency access to your vault.</p>
         <p>Wait period: <strong>${waitDays} day(s)</strong></p>
         <p>Access will be granted automatically after the wait period. You can also approve it immediately.</p>`,
      text: (granteeName: string, waitDays: number) =>
        `${granteeName} has requested emergency access to your vault. Wait period: ${waitDays} day(s). Access will be granted automatically after the wait period.`,
    },
    approved: {
      subject: "Emergency access approved",
      body: (ownerName: string) =>
        `<p>Emergency access to <strong>${ownerName}</strong>'s vault has been approved.</p>
         <p>Please log in to the app to access the vault.</p>`,
      text: (ownerName: string) =>
        `Emergency access to ${ownerName}'s vault has been approved. Please log in to the app to access the vault.`,
    },
    revoked: {
      subject: "Emergency access revoked",
      body: (ownerName: string) =>
        `<p><strong>${ownerName}</strong> has revoked your emergency access.</p>`,
      text: (ownerName: string) =>
        `${ownerName} has revoked your emergency access.`,
    },
  },
} as const;

function getLabels(locale: string) {
  return locale === "ja" ? LABELS.ja : LABELS.en;
}

/** Sent to grantee when owner creates a new grant */
export function emergencyInviteEmail(
  locale: string,
  ownerName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.invite.subject,
    html: emailLayout(l.invite.body(ownerName), locale),
    text: l.invite.text(ownerName),
  };
}

/** Sent to owner when grantee accepts invitation */
export function emergencyGrantAcceptedEmail(
  locale: string,
  granteeName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.accepted.subject,
    html: emailLayout(l.accepted.body(granteeName), locale),
    text: l.accepted.text(granteeName),
  };
}

/** Sent to owner when grantee declines/rejects invitation */
export function emergencyGrantDeclinedEmail(
  locale: string,
  granteeName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.declined.subject,
    html: emailLayout(l.declined.body(granteeName), locale),
    text: l.declined.text(granteeName),
  };
}

/** Sent to owner when grantee requests emergency access */
export function emergencyAccessRequestedEmail(
  locale: string,
  granteeName: string,
  waitDays: number,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.requested.subject,
    html: emailLayout(l.requested.body(granteeName, waitDays), locale),
    text: l.requested.text(granteeName, waitDays),
  };
}

/** Sent to grantee when owner approves or when wait period expires */
export function emergencyAccessApprovedEmail(
  locale: string,
  ownerName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.approved.subject,
    html: emailLayout(l.approved.body(ownerName), locale),
    text: l.approved.text(ownerName),
  };
}

/** Sent to grantee when owner revokes access */
export function emergencyAccessRevokedEmail(
  locale: string,
  ownerName: string,
): TemplateResult {
  const l = getLabels(locale);
  return {
    subject: l.revoked.subject,
    html: emailLayout(l.revoked.body(ownerName), locale),
    text: l.revoked.text(ownerName),
  };
}
