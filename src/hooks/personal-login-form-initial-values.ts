import type { PersonalLoginFormInitialData } from "@/components/passwords/personal-login-form-types";
import type { TagData } from "@/components/tags/tag-input";
import {
  DEFAULT_GENERATOR_SETTINGS,
  type GeneratorSettings,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

export interface PersonalLoginFormInitialValues {
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
  travelSafe: boolean;
  expiresAt: string | null;
  folderId: string | null;
}

export function buildPersonalLoginFormInitialValues(
  initialData?: PersonalLoginFormInitialData,
  defaults?: { defaultFolderId?: string | null; defaultTags?: TagData[] },
): PersonalLoginFormInitialValues {
  return {
    title: initialData?.title ?? "",
    username: initialData?.username ?? "",
    password: initialData?.password ?? "",
    url: initialData?.url ?? "",
    notes: initialData?.notes ?? "",
    selectedTags: initialData?.tags ?? defaults?.defaultTags ?? [],
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS, ...initialData?.generatorSettings },
    customFields: initialData?.customFields ?? [],
    totp: initialData?.totp ?? null,
    showTotpInput: Boolean(initialData?.totp),
    requireReprompt: initialData?.requireReprompt ?? false,
    travelSafe: initialData?.travelSafe ?? true,
    expiresAt: initialData?.expiresAt ?? null,
    folderId: initialData?.folderId ?? defaults?.defaultFolderId ?? null,
  };
}
