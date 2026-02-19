"use client";

import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

interface PersonalFormSnapshotInitialData {
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  tags?: TagData[];
  generatorSettings?: GeneratorSettings;
  customFields?: EntryCustomField[];
  totp?: EntryTotp | null;
  requireReprompt?: boolean;
  folderId?: string | null;
}

interface BuildPersonalCurrentSnapshotArgs {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  tags: TagData[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  requireReprompt: boolean;
  folderId: string | null;
}

export function buildPersonalInitialSnapshot(
  initialData?: PersonalFormSnapshotInitialData,
): string {
  return JSON.stringify({
    title: initialData?.title ?? "",
    username: initialData?.username ?? "",
    password: initialData?.password ?? "",
    url: initialData?.url ?? "",
    notes: initialData?.notes ?? "",
    tags: initialData?.tags ?? [],
    generatorSettings: initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: initialData?.customFields ?? [],
    totp: initialData?.totp ?? null,
    requireReprompt: initialData?.requireReprompt ?? false,
    folderId: initialData?.folderId ?? null,
  });
}

export function buildPersonalCurrentSnapshot({
  title,
  username,
  password,
  url,
  notes,
  tags,
  generatorSettings,
  customFields,
  totp,
  requireReprompt,
  folderId,
}: BuildPersonalCurrentSnapshotArgs): string {
  return JSON.stringify({
    title,
    username,
    password,
    url,
    notes,
    tags,
    generatorSettings,
    customFields,
    totp,
    requireReprompt,
    folderId,
  });
}

export type PersonalPasswordFormDerivedArgs = {
  initialData?: PersonalPasswordFormInitialData;
  values: PersonalPasswordFormEntryValues;
  translations: PersonalPasswordFormTranslations;
};

export function usePersonalPasswordFormDerived({
  initialData,
  values,
  translations,
}: PersonalPasswordFormDerivedArgs) {
  const { tGen } = translations;
  const initialSnapshot = buildPersonalInitialSnapshot(initialData);
  const currentSnapshot = buildPersonalCurrentSnapshot({
    title: values.title,
    username: values.username,
    password: values.password,
    url: values.url,
    notes: values.notes,
    tags: values.selectedTags,
    generatorSettings: values.generatorSettings,
    customFields: values.customFields,
    totp: values.totp,
    requireReprompt: values.requireReprompt,
    folderId: values.folderId,
  });
  const hasChanges = currentSnapshot !== initialSnapshot;

  const generatorSummary = buildGeneratorSummary(values.generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  return { hasChanges, generatorSummary };
}
