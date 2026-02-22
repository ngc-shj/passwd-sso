import { describe, it, expect } from "vitest";
import {
  emergencyInviteEmail,
  emergencyGrantAcceptedEmail,
  emergencyGrantDeclinedEmail,
  emergencyAccessRequestedEmail,
  emergencyAccessApprovedEmail,
  emergencyAccessRevokedEmail,
} from "./emergency-access";

describe("emergency access email templates", () => {
  const templates = [
    {
      name: "emergencyInviteEmail",
      fn: (locale: string) => emergencyInviteEmail(locale, "Alice"),
      ja: { subjectIncludes: "緊急アクセスの招待", bodyIncludes: "Alice" },
      en: { subjectIncludes: "emergency contact", bodyIncludes: "Alice" },
    },
    {
      name: "emergencyGrantAcceptedEmail",
      fn: (locale: string) => emergencyGrantAcceptedEmail(locale, "Bob"),
      ja: { subjectIncludes: "承諾", bodyIncludes: "Bob" },
      en: { subjectIncludes: "accepted", bodyIncludes: "Bob" },
    },
    {
      name: "emergencyGrantDeclinedEmail",
      fn: (locale: string) => emergencyGrantDeclinedEmail(locale, "Charlie"),
      ja: { subjectIncludes: "辞退", bodyIncludes: "Charlie" },
      en: { subjectIncludes: "declined", bodyIncludes: "Charlie" },
    },
    {
      name: "emergencyAccessRequestedEmail",
      fn: (locale: string) =>
        emergencyAccessRequestedEmail(locale, "Dave", 3),
      ja: { subjectIncludes: "リクエスト", bodyIncludes: "3" },
      en: { subjectIncludes: "requested", bodyIncludes: "3 day" },
    },
    {
      name: "emergencyAccessApprovedEmail",
      fn: (locale: string) => emergencyAccessApprovedEmail(locale, "Eve"),
      ja: { subjectIncludes: "承認", bodyIncludes: "Eve" },
      en: { subjectIncludes: "approved", bodyIncludes: "Eve" },
    },
    {
      name: "emergencyAccessRevokedEmail",
      fn: (locale: string) => emergencyAccessRevokedEmail(locale, "Frank"),
      ja: { subjectIncludes: "取り消", bodyIncludes: "Frank" },
      en: { subjectIncludes: "revoked", bodyIncludes: "Frank" },
    },
  ];

  for (const t of templates) {
    describe(t.name, () => {
      it("generates ja template with correct content", () => {
        const result = t.fn("ja");
        expect(result.subject).toContain(t.ja.subjectIncludes);
        expect(result.html).toContain(t.ja.bodyIncludes);
        expect(result.html).toContain('lang="ja"');
        expect(result.text).toContain(t.ja.bodyIncludes);
      });

      it("generates en template with correct content", () => {
        const result = t.fn("en");
        expect(result.subject).toContain(t.en.subjectIncludes);
        expect(result.html).toContain(t.en.bodyIncludes);
        expect(result.html).toContain('lang="en"');
        expect(result.text).toContain(t.en.bodyIncludes);
      });
    });
  }
});
