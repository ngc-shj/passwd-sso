import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryPasswordHistory, EntryTotp } from "@/lib/vault/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";

export interface PersonalLoginFormInitialData {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  tags: TagData[];
  generatorSettings?: GeneratorSettings;
  passwordHistory?: EntryPasswordHistory[];
  customFields?: EntryCustomField[];
  totp?: EntryTotp;
  requireReprompt?: boolean;
  expiresAt?: string | null;
  folderId?: string | null;
  travelSafe?: boolean;
}

export interface PersonalLoginFormProps {
  mode: "create" | "edit";
  initialData?: PersonalLoginFormInitialData;
  variant?: "page" | "dialog";
  onSaved?: () => void;
  onCancel?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}
