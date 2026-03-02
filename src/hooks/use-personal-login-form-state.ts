"use client";

import { type Dispatch, type SetStateAction } from "react";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/personal-password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { usePersonalLoginFormUiState } from "@/hooks/use-personal-login-form-ui-state";
import { usePersonalLoginFormValueState } from "@/hooks/use-personal-login-form-value-state";
import { buildPersonalLoginFormInitialValues } from "@/hooks/personal-login-form-initial-values";

export interface PersonalLoginFormValues {
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
  expiresAt: string | null;
  folderId: string | null;
}

export interface PersonalLoginFormEntryValues {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  selectedTags: TagData[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  requireReprompt: boolean;
  expiresAt: string | null;
  folderId: string | null;
}

export interface PersonalLoginFormSetters {
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
  setExpiresAt: (value: string | null) => void;
  setFolderId: (value: string | null) => void;
}

export interface PersonalLoginFormState {
  values: PersonalLoginFormValues;
  setters: PersonalLoginFormSetters;
}

export function usePersonalLoginFormState(
  initialData?: PersonalPasswordFormInitialData,
  defaults?: { defaultFolderId?: string | null; defaultTags?: TagData[] },
): PersonalLoginFormState {
  const initial = buildPersonalLoginFormInitialValues(initialData, defaults);
  const uiState = usePersonalLoginFormUiState();
  const valueState = usePersonalLoginFormValueState(initial);

  return {
    values: {
      ...uiState.values,
      ...valueState.values,
    },
    setters: {
      ...uiState.setters,
      ...valueState.setters,
    },
  };
}

export function selectPersonalEntryValues(
  values: PersonalLoginFormValues,
): PersonalLoginFormEntryValues {
  return {
    title: values.title,
    username: values.username,
    password: values.password,
    url: values.url,
    notes: values.notes,
    selectedTags: values.selectedTags,
    generatorSettings: values.generatorSettings,
    customFields: values.customFields,
    totp: values.totp,
    requireReprompt: values.requireReprompt,
    expiresAt: values.expiresAt,
    folderId: values.folderId,
  };
}
