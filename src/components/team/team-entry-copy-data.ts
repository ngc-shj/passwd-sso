import type { EntryLocaleCopy } from "@/components/team/team-entry-copy";
import type { TeamEntryKind } from "@/components/team/team-password-form-types";
import type {
  BankAccountFormTranslator,
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
  SoftwareLicenseFormTranslator,
} from "@/lib/translation-types";

interface BuildTeamEntryCopyDataArgs {
  t: PasswordFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
  tba: BankAccountFormTranslator;
  tsl: SoftwareLicenseFormTranslator;
}

export function buildTeamEntryCopyData({
  t,
  tn,
  tcc,
  ti,
  tpk,
  tba,
  tsl,
}: BuildTeamEntryCopyDataArgs): Record<TeamEntryKind, EntryLocaleCopy> {
  return {
    passkey: {
      edit: tpk("editPasskey"),
      create: tpk("newPasskey"),
      titleLabel: tpk("title"),
      titlePlaceholder: tpk("titlePlaceholder"),
      notesLabel: tpk("notes"),
      notesPlaceholder: tpk("notesPlaceholder"),
      tagsTitle: tpk("tags"),
    },
    identity: {
      edit: ti("editIdentity"),
      create: ti("newIdentity"),
      titleLabel: ti("title"),
      titlePlaceholder: ti("titlePlaceholder"),
      notesLabel: ti("notes"),
      notesPlaceholder: ti("notesPlaceholder"),
      tagsTitle: ti("tags"),
    },
    creditCard: {
      edit: tcc("editCard"),
      create: tcc("newCard"),
      titleLabel: tcc("title"),
      titlePlaceholder: tcc("titlePlaceholder"),
      notesLabel: tcc("notes"),
      notesPlaceholder: tcc("notesPlaceholder"),
      tagsTitle: tcc("tags"),
    },
    secureNote: {
      edit: tn("editNote"),
      create: tn("newNote"),
      titleLabel: tn("title"),
      titlePlaceholder: tn("titlePlaceholder"),
      notesLabel: tn("notes"),
      notesPlaceholder: tn("notesPlaceholder"),
      tagsTitle: tn("tags"),
    },
    password: {
      edit: t("editPassword"),
      create: t("newPassword"),
      titleLabel: t("title"),
      titlePlaceholder: t("titlePlaceholder"),
      notesLabel: t("notes"),
      notesPlaceholder: t("notesPlaceholder"),
      tagsTitle: t("tags"),
    },
    bankAccount: {
      edit: tba("editBankAccount"),
      create: tba("newBankAccount"),
      titleLabel: tba("title"),
      titlePlaceholder: tba("titlePlaceholder"),
      notesLabel: tba("notes"),
      notesPlaceholder: tba("notesPlaceholder"),
      tagsTitle: tba("tags"),
    },
    softwareLicense: {
      edit: tsl("editLicense"),
      create: tsl("newLicense"),
      titleLabel: tsl("title"),
      titlePlaceholder: tsl("titlePlaceholder"),
      notesLabel: tsl("notes"),
      notesPlaceholder: tsl("notesPlaceholder"),
      tagsTitle: tsl("tags"),
    },
  };
}
