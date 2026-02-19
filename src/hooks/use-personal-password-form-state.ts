"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

export interface PersonalPasswordFormValues {
  showPassword: boolean;
  showGenerator: boolean;
  submitting: boolean;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  selectedTags: TagData[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  showTotpInput: boolean;
  requireReprompt: boolean;
  folderId: string | null;
}

export interface PersonalPasswordFormSetters {
  setShowPassword: (value: boolean) => void;
  setShowGenerator: (value: boolean) => void;
  setSubmitting: (value: boolean) => void;
  setTitle: (value: string) => void;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  setUrl: (value: string) => void;
  setNotes: (value: string) => void;
  setSelectedTags: (value: TagData[]) => void;
  setGeneratorSettings: (value: GeneratorSettings) => void;
  setCustomFields: Dispatch<SetStateAction<EntryCustomField[]>>;
  setTotp: (value: EntryTotp | null) => void;
  setShowTotpInput: (value: boolean) => void;
  setRequireReprompt: (value: boolean) => void;
  setFolderId: (value: string | null) => void;
}

export interface PersonalPasswordFormState {
  values: PersonalPasswordFormValues;
  setters: PersonalPasswordFormSetters;
}

export function usePersonalPasswordFormState(
  initialData?: PersonalPasswordFormInitialData,
): PersonalPasswordFormState {
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

  return {
    values: {
      showPassword,
      showGenerator,
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
    },
    setters: {
      setShowPassword,
      setShowGenerator,
      setSubmitting,
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
    },
  };
}
