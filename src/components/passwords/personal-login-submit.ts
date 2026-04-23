import { extractTagIds } from "@/lib/vault/entry-form-helpers";
import {
  buildPasswordHistory,
  buildPersonalEntryPayload,
} from "@/lib/vault/personal-entry-payload";
import { executePersonalEntrySubmit } from "@/components/passwords/personal-entry-submit";
import type { PersonalLoginFormInitialData } from "@/components/passwords/personal-login-form-types";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { PasswordSubmitRouter } from "@/hooks/password-form-router";

export interface SubmitPersonalLoginFormArgs {
  mode: "create" | "edit";
  initialData?: PersonalLoginFormInitialData;
  encryptionKey: CryptoKey | null;
  userId: string | null;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  selectedTags: TagData[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  requireReprompt: boolean;
  travelSafe: boolean;
  expiresAt: string | null;
  folderId: string | null;
  setSubmitting: (value: boolean) => void;
  t: PasswordFormTranslator;
  router: PasswordSubmitRouter;
  onSaved?: () => void;
}

export async function submitPersonalLoginForm({
  mode,
  initialData,
  encryptionKey,
  userId,
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
  setSubmitting,
  t,
  router,
  onSaved,
}: SubmitPersonalLoginFormArgs): Promise<void> {
  if (!encryptionKey || !userId) return;

  const existingHistory = buildPasswordHistory(
    mode === "edit" && initialData ? initialData.password : "",
    password,
    initialData?.passwordHistory ?? [],
    new Date().toISOString(),
  );
  const { fullBlob, overviewBlob } = buildPersonalEntryPayload({
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
    existingHistory,
  });

  await executePersonalEntrySubmit({
    mode,
    initialId: initialData?.id,
    encryptionKey,
    userId,
    fullBlob,
    overviewBlob,
    tagIds: extractTagIds(selectedTags),
    requireReprompt,
    expiresAt,
    folderId: folderId ?? null,
    setSubmitting,
    t,
    router,
    onSaved,
  });
}
