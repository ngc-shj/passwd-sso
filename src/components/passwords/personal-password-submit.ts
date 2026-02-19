import { extractTagIds } from "@/lib/entry-form-helpers";
import {
  buildPasswordHistory,
  buildPersonalEntryPayload,
} from "@/lib/personal-entry-payload";
import { executePersonalEntrySubmit } from "@/components/passwords/personal-entry-submit";
import type { PersonalPasswordFormInitialData } from "@/components/passwords/password-form-types";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TagData } from "@/components/tags/tag-input";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { PasswordSubmitRouter } from "@/hooks/password-form-router";

export interface SubmitPersonalPasswordFormArgs {
  mode: "create" | "edit";
  initialData?: PersonalPasswordFormInitialData;
  encryptionKey: CryptoKey | null;
  userId?: string;
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
  folderId: string | null;
  setSubmitting: (value: boolean) => void;
  t: PasswordFormTranslator;
  router: PasswordSubmitRouter;
  onSaved?: () => void;
}

export async function submitPersonalPasswordForm({
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
  folderId,
  setSubmitting,
  t,
  router,
  onSaved,
}: SubmitPersonalPasswordFormArgs): Promise<void> {
  if (!encryptionKey) return;

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
    existingHistory,
  });

  await executePersonalEntrySubmit({
    mode,
    initialId: initialData?.id,
    encryptionKey,
    userId: userId ?? undefined,
    fullBlob,
    overviewBlob,
    tagIds: extractTagIds(selectedTags),
    requireReprompt,
    folderId: folderId ?? null,
    setSubmitting,
    t,
    router,
    onSaved,
  });
}
