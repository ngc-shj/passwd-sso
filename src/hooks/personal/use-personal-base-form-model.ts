"use client";

import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonalFolders } from "@/hooks/personal/use-personal-folders";
import { executePersonalEntrySubmit } from "@/components/passwords/personal/personal-entry-submit";
import { createFormNavigationHandlers } from "@/components/passwords/shared/form-navigation";
import { toTagIds } from "@/components/passwords/entry/entry-form-tags";
import type { TagData } from "@/components/tags/tag-input";
import type { EntryTypeValue } from "@/lib/constants";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface UsePersonalBaseFormModelArgs {
  mode: "create" | "edit";
  initialId?: string;
  initialTitle?: string | null;
  initialTags?: TagData[];
  initialFolderId?: string | null;
  initialRequireReprompt?: boolean;
  initialExpiresAt?: string | null;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
  variant?: "page" | "dialog";
  onSaved?: () => void;
  onCancel?: () => void;
}

interface SubmitEntryArgs {
  t: PasswordFormTranslator;
  fullBlob: string;
  overviewBlob: string;
  entryType: EntryTypeValue;
}

export function usePersonalBaseFormModel({
  mode,
  initialId,
  initialTitle,
  initialTags,
  initialFolderId,
  initialRequireReprompt,
  initialExpiresAt,
  defaultFolderId,
  defaultTags,
  variant = "page",
  onSaved,
  onCancel,
}: UsePersonalBaseFormModelArgs) {
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const { folders } = usePersonalFolders();
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialTags ?? defaultTags ?? [],
  );
  const [folderId, setFolderId] = useState<string | null>(
    initialFolderId ?? defaultFolderId ?? null,
  );
  const [requireReprompt, setRequireReprompt] = useState(
    initialRequireReprompt ?? false,
  );
  const [expiresAt, setExpiresAt] = useState<string | null>(
    initialExpiresAt ?? null,
  );

  const { handleCancel, handleBack } = createFormNavigationHandlers({
    onCancel: variant === "dialog" ? onCancel : undefined,
    router,
  });

  const submitEntry = async ({
    t,
    fullBlob,
    overviewBlob,
    entryType,
  }: SubmitEntryArgs): Promise<void> => {
    if (!encryptionKey || !userId) return;

    await executePersonalEntrySubmit({
      mode,
      initialId,
      encryptionKey,
      userId,
      fullBlob,
      overviewBlob,
      tagIds: toTagIds(selectedTags),
      folderId,
      entryType,
      requireReprompt,
      expiresAt,
      setSubmitting,
      t,
      router,
      onSaved,
    });
  };

  return {
    folders,
    submitting,
    title,
    setTitle,
    selectedTags,
    setSelectedTags,
    folderId,
    setFolderId,
    requireReprompt,
    setRequireReprompt,
    expiresAt,
    setExpiresAt,
    handleCancel,
    handleBack,
    submitEntry,
    isDialogVariant: variant === "dialog",
  };
}
