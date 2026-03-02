import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryPasswordHistory, EntryTotp } from "@/lib/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";

export interface PersonalPasswordFormInitialData {
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
}

export interface PasswordFormProps {
  mode: "create" | "edit";
  initialData?: PersonalPasswordFormInitialData;
  variant?: "page" | "dialog";
  onSaved?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}
