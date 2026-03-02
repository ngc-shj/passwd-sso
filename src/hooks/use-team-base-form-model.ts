"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { getTeamEntryKindState } from "@/components/team/team-entry-kind";
import { buildTeamEntryCopy } from "@/components/team/team-entry-copy";
import { buildTeamEntryCopyData } from "@/components/team/team-entry-copy-data";
import type {
  TeamPasswordFormEditData,
} from "@/components/team/team-password-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { useTeamAttachments } from "@/hooks/use-team-attachments";
import { useTeamFolders } from "@/hooks/use-team-folders";
import { useTeamPolicy } from "@/hooks/use-team-policy";
import { useTeamVault } from "@/lib/team-vault-context";
import {
  useEntryFormTranslations,
  toTeamPasswordFormTranslations,
} from "@/hooks/use-entry-form-translations";
import {
  buildTeamEntryPayload,
  type BuildTeamEntryPayloadInput,
} from "@/lib/team-entry-payload";
import { executeTeamEntrySubmit } from "@/components/team/team-entry-submit";
import { extractTagIds } from "@/lib/entry-form-helpers";

export interface UseTeamBaseFormModelInput {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  entryType?: EntryTypeValue;
  editData?: TeamPasswordFormEditData | null;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
}

export function useTeamBaseFormModel({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = ENTRY_TYPE.LOGIN,
  editData,
  defaultFolderId,
  defaultTags,
}: UseTeamBaseFormModelInput) {
  const translationBundle = useEntryFormTranslations();
  const { t, tc } = translationBundle;
  const translations = toTeamPasswordFormTranslations(translationBundle);

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const entryKindState = getTeamEntryKindState(effectiveEntryType);
  const isEdit = !!editData;

  const { policy: teamPolicy } = useTeamPolicy(open, teamId);
  const { attachments, setAttachments } = useTeamAttachments(
    open,
    teamId,
    editData?.id,
  );
  const { folders: teamFolders } = useTeamFolders(open, teamId);
  const { getTeamKeyInfo } = useTeamVault();

  const entryCopy = useMemo(
    () =>
      buildTeamEntryCopy({
        isEdit,
        entryKind: entryKindState.entryKind,
        copyByKind: buildTeamEntryCopyData(translations),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isEdit, entryKindState.entryKind, translations.t, translations.tn, translations.tcc, translations.ti, translations.tpk, translations.tba, translations.tsl],
  );

  // Common state shared by all entry types
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(editData?.title ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TeamTagData[]>(
    editData?.tags ?? defaultTags ?? [],
  );
  const [teamFolderId, setTeamFolderId] = useState<string | null>(
    editData?.teamFolderId ?? defaultFolderId ?? null,
  );
  const [requireReprompt, setRequireReprompt] = useState(
    editData?.requireReprompt ?? teamPolicy?.requireRepromptForAll ?? false,
  );
  const [expiresAt, setExpiresAt] = useState<string | null>(
    editData?.expiresAt ?? null,
  );

  /**
   * Submit an entry. Each form builds the BuildTeamEntryPayloadInput
   * with its entry-specific fields plus common fields (title, notes, tags).
   */
  const submitEntry = async (
    payloadInput: BuildTeamEntryPayloadInput,
  ): Promise<void> => {
    const keyInfo = await getTeamKeyInfo(teamId);
    if (!keyInfo) {
      toast.error(t("failedToSave"));
      return;
    }

    const tagIds = extractTagIds(selectedTags);
    const { fullBlob, overviewBlob } = buildTeamEntryPayload(payloadInput);

    await executeTeamEntrySubmit({
      teamId,
      isEdit,
      editData,
      teamEncryptionKey: keyInfo.key,
      teamKeyVersion: keyInfo.keyVersion,
      fullBlob,
      overviewBlob,
      entryType: effectiveEntryType,
      tagIds,
      teamFolderId,
      requireReprompt,
      expiresAt,
      t,
      setSaving,
      handleOpenChange: onOpenChange,
      onSaved,
    });
  };

  return {
    // Translations
    t,
    tc,
    translations,
    translationBundle,

    // Derived
    isEdit,
    effectiveEntryType,
    entryKindState,

    // Data
    teamPolicy,
    teamFolders,
    attachments,
    setAttachments,
    entryCopy,

    // Dialog
    handleOpenChange: onOpenChange,

    // Common state
    saving,
    title,
    setTitle,
    notes,
    setNotes,
    selectedTags,
    setSelectedTags,
    teamFolderId,
    setTeamFolderId,
    requireReprompt,
    setRequireReprompt,
    expiresAt,
    setExpiresAt,

    // Submit
    submitEntry,
  };
}
