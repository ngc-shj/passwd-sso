"use client";

import { buildGeneratorSummary } from "@/lib/generator-summary";
import {
  buildPersonalCurrentSnapshot,
  buildPersonalInitialSnapshot,
} from "@/components/passwords/personal-password-form-snapshot";
import type { PersonalPasswordFormDerivedArgs } from "@/hooks/personal-password-form-derived-args";

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
