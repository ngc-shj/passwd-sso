import { buildGeneratorSummary } from "@/lib/generator-summary";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";

type PersonalFormSnapshotInitialData = PersonalPasswordFormInitialData;
type BuildPersonalCurrentSnapshotArgs = PersonalPasswordFormEntryValues;

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
    expiresAt: initialData?.expiresAt ?? null,
    folderId: initialData?.folderId ?? null,
  });
}

export function buildPersonalCurrentSnapshot({
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
  expiresAt,
  folderId,
}: BuildPersonalCurrentSnapshotArgs): string {
  return JSON.stringify({
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
    expiresAt,
    folderId,
  });
}

export type PersonalPasswordFormDerivedArgs = {
  initialData?: PersonalPasswordFormInitialData;
  values: PersonalPasswordFormEntryValues;
  translations: PersonalPasswordFormTranslations;
};

export function buildPersonalPasswordFormDerived({
  initialData,
  values,
  translations,
}: PersonalPasswordFormDerivedArgs) {
  const { tGen } = translations;
  const initialSnapshot = buildPersonalInitialSnapshot(initialData);
  const currentSnapshot = buildPersonalCurrentSnapshot({
    ...values,
  });
  const hasChanges = currentSnapshot !== initialSnapshot;

  const generatorSummary = buildGeneratorSummary(values.generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  return { hasChanges, generatorSummary };
}
