import type { EntryLocaleCopy } from "@/components/org/org-entry-copy";
import type { OrgEntryKind } from "@/components/org/org-password-form-types";

interface BuildOrgEntryCopyDataArgs {
  t: (key: string) => string;
  tn: (key: string) => string;
  tcc: (key: string) => string;
  ti: (key: string) => string;
  tpk: (key: string) => string;
}

export function buildOrgEntryCopyData({
  t,
  tn,
  tcc,
  ti,
  tpk,
}: BuildOrgEntryCopyDataArgs): Record<OrgEntryKind, EntryLocaleCopy> {
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
