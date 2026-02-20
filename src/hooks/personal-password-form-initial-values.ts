import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { TagData } from "@/components/tags/tag-input";
import {
  DEFAULT_GENERATOR_SETTINGS,
  type GeneratorSettings,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

export interface PersonalPasswordFormInitialValues {
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

export function buildPersonalPasswordFormInitialValues(
  initialData?: PersonalPasswordFormInitialData,
): PersonalPasswordFormInitialValues {
  return {
    title: initialData?.title ?? "",
    username: initialData?.username ?? "",
    password: initialData?.password ?? "",
    url: initialData?.url ?? "",
    notes: initialData?.notes ?? "",
    selectedTags: initialData?.tags ?? [],
    generatorSettings: initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: initialData?.customFields ?? [],
    totp: initialData?.totp ?? null,
    showTotpInput: Boolean(initialData?.totp),
    requireReprompt: initialData?.requireReprompt ?? false,
    expiresAt: initialData?.expiresAt ?? null,
    folderId: initialData?.folderId ?? null,
  };
}
