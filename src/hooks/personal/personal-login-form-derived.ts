import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import type { PersonalLoginFormInitialData } from "@/components/passwords/personal/personal-login-form-types";
import type { PersonalLoginFormTranslations } from "@/hooks/form/entry-form-translations";
import type { PersonalLoginFormEntryValues } from "@/hooks/personal/use-personal-login-form-state";
import type { TagData } from "@/components/tags/tag-input";
import { buildLoginFormDerived, buildSnapshot } from "@/hooks/form/login-form-derived";

type PersonalFormSnapshotInitialData = PersonalLoginFormInitialData;
type BuildPersonalCurrentSnapshotArgs = PersonalLoginFormEntryValues;

export function buildPersonalInitialSnapshot(
  initialData?: PersonalFormSnapshotInitialData,
  defaults?: { defaultFolderId?: string | null; defaultTags?: TagData[] },
): string {
  return buildSnapshot("personal", {
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
    travelSafe: initialData?.travelSafe ?? true,
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
  travelSafe,
  expiresAt,
  folderId,
}: BuildPersonalCurrentSnapshotArgs): string {
  return buildSnapshot("personal", {
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
    travelSafe,
    expiresAt,
    folderId,
  });
}

export type PersonalLoginFormDerivedArgs = {
  initialData?: PersonalLoginFormInitialData;
  values: PersonalLoginFormEntryValues;
  translations: PersonalLoginFormTranslations;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
};

export function buildPersonalLoginFormDerived({
  initialData,
  values,
  translations,
  defaultFolderId,
  defaultTags,
}: PersonalLoginFormDerivedArgs) {
  const { tGen } = translations;
  const initialSnapshot = buildPersonalInitialSnapshot(initialData, { defaultFolderId, defaultTags });

  return buildLoginFormDerived({
    scope: "personal",
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
    travelSafe: values.travelSafe,
    expiresAt: values.expiresAt,
    folderId: values.folderId,
    tGen,
    initialSnapshot,
  });
}
