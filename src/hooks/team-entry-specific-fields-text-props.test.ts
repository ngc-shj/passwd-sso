import { describe, expect, it } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type {
  PasswordFormTranslator,
  SecureNoteFormTranslator,
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasskeyFormTranslator,
  BankAccountFormTranslator,
  SoftwareLicenseFormTranslator,
} from "@/lib/translation-types";
import { buildTeamEntrySpecificTextProps } from "@/hooks/team-entry-specific-fields-text-props";

describe("buildTeamEntrySpecificTextProps", () => {
  it("maps translation namespaces and entry copy values", () => {
    const props = buildTeamEntrySpecificTextProps(
      {
        t: mockTranslator<PasswordFormTranslator>((k) => `t.${k}`),
        tn: mockTranslator<SecureNoteFormTranslator>((k) => `tn.${k}`),
        tcc: mockTranslator<CreditCardFormTranslator>((k: string, values?: Record<string, unknown>) => `tcc.${k}${values ? `:${JSON.stringify(values)}` : ""}`),
        ti: mockTranslator<IdentityFormTranslator>((k) => `ti.${k}`),
        tpk: mockTranslator<PasskeyFormTranslator>((k) => `tpk.${k}`),
        tba: mockTranslator<BankAccountFormTranslator>((k) => `tba.${k}`),
        tsl: mockTranslator<SoftwareLicenseFormTranslator>((k) => `tsl.${k}`),
      },
      {
        notesLabel: "notes.label",
        notesPlaceholder: "notes.placeholder",
      },
      "16,19",
    );

    expect(props.notesLabel).toBe("notes.label");
    expect(props.notesPlaceholder).toBe("notes.placeholder");
    expect(props.titleLabel).toBe("t.title");
    expect(props.contentLabel).toBe("tn.content");
    expect(props.lengthHintLabel).toContain("16,19");
    expect(props.creditCardLabels.cardNumber).toBe("tcc.cardNumber");
    expect(props.identityLabels.fullName).toBe("ti.fullName");
    expect(props.passkeyLabels.credentialId).toBe("tpk.credentialId");
    expect(props.bankAccountLabels.bankName).toBe("tba.bankName");
    expect(props.bankAccountLabels.accountNumber).toBe("tba.accountNumber");
    expect(props.softwareLicenseLabels.softwareName).toBe("tsl.softwareName");
    expect(props.softwareLicenseLabels.licenseKey).toBe("tsl.licenseKey");
  });
});
