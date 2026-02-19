"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import { type GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";

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

  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState(initial.password);
  const [url, setUrl] = useState(initial.url);
  const [notes, setNotes] = useState(initial.notes);
  const [selectedTags, setSelectedTags] = useState<TagData[]>(initial.selectedTags);
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(initial.generatorSettings);
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(initial.customFields);
  const [totp, setTotp] = useState<EntryTotp | null>(initial.totp);
  const [showTotpInput, setShowTotpInput] = useState(initial.showTotpInput);
  const [requireReprompt, setRequireReprompt] = useState(initial.requireReprompt);
  const [folderId, setFolderId] = useState<string | null>(initial.folderId);

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
