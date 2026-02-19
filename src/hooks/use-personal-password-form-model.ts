"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  buildPersonalCurrentSnapshot,
  buildPersonalInitialSnapshot,
} from "@/components/passwords/personal-password-form-snapshot";
import { submitPersonalPasswordForm } from "@/components/passwords/personal-password-submit";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

type PersonalPasswordFormModelInput = Pick<PasswordFormProps, "mode" | "initialData" | "onSaved">;

export function usePersonalPasswordFormModel({
  mode,
  initialData,
  onSaved,
}: PersonalPasswordFormModelInput) {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();

  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(initialData?.title ?? "");
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [password, setPassword] = useState(initialData?.password ?? "");
  const [url, setUrl] = useState(initialData?.url ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(initialData?.tags ?? []);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(initialData?.customFields ?? []);
  const [totp, setTotp] = useState<EntryTotp | null>(initialData?.totp ?? null);
  const [showTotpInput, setShowTotpInput] = useState(!!initialData?.totp);
  const [requireReprompt, setRequireReprompt] = useState(initialData?.requireReprompt ?? false);
  const [folderId, setFolderId] = useState<string | null>(initialData?.folderId ?? null);
  const folders = usePersonalFolders();

  const initialSnapshot = buildPersonalInitialSnapshot(initialData);
  const currentSnapshot = buildPersonalCurrentSnapshot({
    title,
    username,
    password,
    url,
    notes,
    tags: selectedTags,
    generatorSettings,
    customFields,
    totp,
    requireReprompt,
    folderId,
  });
  const hasChanges = currentSnapshot !== initialSnapshot;

  const generatorSummary = buildGeneratorSummary(generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPersonalPasswordForm({
      mode,
      initialData,
      encryptionKey,
      userId: userId ?? undefined,
      title,
      username,
      password,
      url,
      notes,
      selectedTags,
      generatorSettings,
      customFields,
      totp,
      requireReprompt,
      folderId,
      setSubmitting,
      t,
      router,
      onSaved,
    });
  };

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
      return;
    }
    router.back();
  };

  const handleBack = () => {
    router.back();
  };

  return {
    t,
    tc,
    mode,
    submitting,
    title,
    username,
    password,
    url,
    notes,
    selectedTags,
    generatorSettings,
    customFields,
    totp,
    showTotpInput,
    requireReprompt,
    folderId,
    folders,
    showPassword,
    showGenerator,
    hasChanges,
    generatorSummary,
    setTitle,
    setUsername,
    setPassword,
    setUrl,
    setNotes,
    setSelectedTags,
    setGeneratorSettings,
    setCustomFields,
    setTotp,
    setShowTotpInput,
    setRequireReprompt,
    setFolderId,
    setShowPassword,
    setShowGenerator,
    handleSubmit,
    handleCancel,
    handleBack,
  };
}
