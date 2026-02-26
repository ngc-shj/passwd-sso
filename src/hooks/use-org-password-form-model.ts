"use client";

import { ENTRY_TYPE } from "@/lib/constants";
import { getOrgEntryKindState } from "@/components/team/team-entry-kind";
import type { OrgPasswordFormProps } from "@/components/team/team-password-form-types";
import { useOrgAttachments } from "@/hooks/use-org-attachments";
import { useOrgFolders } from "@/hooks/use-org-folders";
import { useOrgPasswordFormController } from "@/hooks/use-org-password-form-controller";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";
import {
  toOrgPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";
import {
  type OrgPasswordFormLifecycleSetters,
  useOrgPasswordFormState,
} from "@/hooks/use-org-password-form-state";

type OrgPasswordFormModelInput = Pick<
  OrgPasswordFormProps,
  "orgId" | "open" | "onOpenChange" | "onSaved" | "entryType" | "editData"
>;

type TeamPasswordFormModelInput = Omit<OrgPasswordFormModelInput, "orgId"> & {
  teamId?: OrgPasswordFormProps["orgId"];
  orgId?: OrgPasswordFormProps["orgId"];
};

export function useOrgPasswordFormModel({
  orgId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = ENTRY_TYPE.LOGIN,
  editData,
}: OrgPasswordFormModelInput) {
  const translationBundle = useEntryFormTranslations();
  const { t, tc } = translationBundle;
  const translations = toOrgPasswordFormTranslations(translationBundle);

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const entryKindState = getOrgEntryKindState(effectiveEntryType);
  const { isLoginEntry } = entryKindState;
  const isEdit = !!editData;

  const formState = useOrgPasswordFormState(editData);

  const { attachments, setAttachments } = useOrgAttachments(open, orgId, editData?.id);
  const { folders: orgFolders } = useOrgFolders(open, orgId);

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
      entryKindState,
      translations,
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

export function useTeamPasswordFormModel({
  teamId,
  orgId,
  ...rest
}: TeamPasswordFormModelInput) {
  const scopedTeamId = teamId ?? orgId;
  if (!scopedTeamId) {
    throw new Error("useTeamPasswordFormModel requires teamId or orgId");
  }
  return useOrgPasswordFormModel({
    orgId: scopedTeamId,
    ...rest,
  });
}
