import type { EntryLocaleCopy } from "@/components/team/team-entry-copy";
import type { TeamEntryKind } from "@/components/team/team-password-form-types";
import type {
  CreditCardFormTranslator,
  IdentityFormTranslator,
  PasswordFormTranslator,
  PasskeyFormTranslator,
  SecureNoteFormTranslator,
} from "@/lib/translation-types";

interface BuildOrgEntryCopyDataArgs {
  t: PasswordFormTranslator;
  tn: SecureNoteFormTranslator;
  tcc: CreditCardFormTranslator;
  ti: IdentityFormTranslator;
  tpk: PasskeyFormTranslator;
}

export function buildOrgEntryCopyData({
  t,
  tn,
  tcc,
  ti,
  tpk,
}: BuildOrgEntryCopyDataArgs): Record<TeamEntryKind, EntryLocaleCopy> {
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
  };
}
