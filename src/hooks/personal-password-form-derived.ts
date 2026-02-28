import { buildGeneratorSummary } from "@/lib/generator-summary";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import type { PersonalPasswordFormEntryValues } from "@/hooks/use-personal-password-form-state";
import type { TagData } from "@/components/tags/tag-input";

type PersonalFormSnapshotInitialData = PersonalPasswordFormInitialData;
type BuildPersonalCurrentSnapshotArgs = PersonalPasswordFormEntryValues;

export function buildPersonalInitialSnapshot(
  initialData?: PersonalFormSnapshotInitialData,
  defaults?: { defaultFolderId?: string | null; defaultTags?: TagData[] },
): string {
  return JSON.stringify({
    title: initialData?.title ?? "",
    username: initialData?.username ?? "",
    password: initialData?.password ?? "",
    url: initialData?.url ?? "",
    notes: initialData?.notes ?? "",
    tags: initialData?.tags ?? defaults?.defaultTags ?? [],
    generatorSettings: initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: initialData?.customFields ?? [],
    totp: initialData?.totp ?? null,
    requireReprompt: initialData?.requireReprompt ?? false,
    expiresAt: initialData?.expiresAt ?? null,
    folderId: initialData?.folderId ?? defaults?.defaultFolderId ?? null,
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
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
};

export function buildPersonalPasswordFormDerived({
  initialData,
  values,
  translations,
  defaultFolderId,
  defaultTags,
}: PersonalPasswordFormDerivedArgs) {
  const { tGen } = translations;
  const initialSnapshot = buildPersonalInitialSnapshot(initialData, { defaultFolderId, defaultTags });
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
