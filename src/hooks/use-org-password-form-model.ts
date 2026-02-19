"use client";

import { useTranslations } from "next-intl";
import { ENTRY_TYPE } from "@/lib/constants";
import { getOrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import { useOrgAttachments } from "@/hooks/use-org-attachments";
import { useOrgFolders } from "@/hooks/use-org-folders";
import { useOrgPasswordFormController } from "@/hooks/use-org-password-form-controller";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";
import {
  type OrgPasswordFormLifecycleSetters,
  useOrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";

type OrgPasswordFormModelInput = Pick<
  OrgPasswordFormProps,
  "orgId" | "open" | "onOpenChange" | "onSaved" | "entryType" | "editData"
>;

export function useOrgPasswordFormModel({
  orgId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = ENTRY_TYPE.LOGIN,
  editData,
}: OrgPasswordFormModelInput) {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");
  const tc = useTranslations("Common");

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const { entryKind, isNote, isCreditCard, isIdentity, isPasskey, isLoginEntry } =
    getOrgEntryKindState(effectiveEntryType);
  const isEdit = !!editData;

  const formState = useOrgPasswordFormState(editData);

  const { attachments, setAttachments } = useOrgAttachments(open, orgId, editData?.id);
  const orgFolders = useOrgFolders(open, orgId);

  const formSetters: OrgPasswordFormLifecycleSetters = { ...formState.setters, setAttachments };
  const { handleOpenChange } = useOrgPasswordFormLifecycle({
    open,
    editData,
    onOpenChange,
    setters: formSetters,
  });

  const { entryCopy, entrySpecificFieldsProps, handleSubmit, hasChanges, submitDisabled } =
    useOrgPasswordFormController({
      orgId,
      onSaved,
      isEdit,
      editData,
      effectiveEntryType,
      entryKind,
      isLoginEntry,
      isNote,
      isCreditCard,
      isIdentity,
      isPasskey,
      t,
      ti,
      tn,
      tcc,
      tpk,
      tGen,
      formState,
      handleOpenChange,
    });

  return {
    t,
    tc,
    isEdit,
    isLoginEntry,
    editData,
    formState,
    attachments,
    setAttachments,
    orgFolders,
    handleOpenChange,
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}
