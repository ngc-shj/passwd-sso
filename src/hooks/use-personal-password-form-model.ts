"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { usePersonalFolders } from "@/hooks/use-personal-folders";
import type { PasswordFormProps } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { usePersonalPasswordFormController } from "@/hooks/use-personal-password-form-controller";

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

  const values = {
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
  };
  const { hasChanges, generatorSummary, handleSubmit, handleCancel, handleBack } =
    usePersonalPasswordFormController({
      mode,
      initialData,
      onSaved,
      encryptionKey,
      userId: userId ?? undefined,
      values,
      setSubmitting,
      t,
      tGen,
      router,
    });

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
