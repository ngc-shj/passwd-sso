import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";

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
