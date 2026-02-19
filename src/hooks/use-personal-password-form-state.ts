"use client";

import { type Dispatch, type SetStateAction } from "react";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { usePersonalPasswordFormUiState } from "@/hooks/use-personal-password-form-ui-state";
import { usePersonalPasswordFormValueState } from "@/hooks/use-personal-password-form-value-state";
import { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";

export type { PersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";
export { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";

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

export interface PersonalPasswordFormEntryValues {
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
  const initial = buildPersonalPasswordFormInitialValues(initialData);
  const uiState = usePersonalPasswordFormUiState();
  const valueState = usePersonalPasswordFormValueState(initial);

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
  values: PersonalPasswordFormValues,
): PersonalPasswordFormEntryValues {
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
    folderId: values.folderId,
  };
}
