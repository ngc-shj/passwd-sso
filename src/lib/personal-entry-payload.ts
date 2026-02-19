import {
  filterNonEmptyCustomFields,
  parseUrlHost,
  toTagNameColor,
} from "@/lib/entry-form-helpers";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotp,
} from "@/lib/entry-form-types";
import type { GeneratorSettings } from "@/lib/generator-prefs";

interface BuildPersonalEntryPayloadInput {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  selectedTags: EntryTagNameColor[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  requireReprompt: boolean;
  existingHistory: EntryPasswordHistory[];
}

export function buildPasswordHistory(
  previousPassword: string,
  nextPassword: string,
  existingHistory: EntryPasswordHistory[],
  nowIso: string
): EntryPasswordHistory[] {
  if (!previousPassword || previousPassword === nextPassword) return existingHistory;
  return [
    { password: previousPassword, changedAt: nowIso },
    ...existingHistory,
  ].slice(0, 10);
}

export function buildPersonalEntryPayload(
  input: BuildPersonalEntryPayloadInput
): { fullBlob: string; overviewBlob: string } {
  const tags = toTagNameColor(input.selectedTags);
  const validCustomFields = filterNonEmptyCustomFields(input.customFields);
  const urlHost = parseUrlHost(input.url);

  const fullBlob = JSON.stringify({
    title: input.title,
    username: input.username || null,
    password: input.password,
    url: input.url || null,
    notes: input.notes || null,
    tags,
    generatorSettings: input.generatorSettings,
    ...(input.existingHistory.length > 0 && { passwordHistory: input.existingHistory }),
    ...(validCustomFields.length > 0 && { customFields: validCustomFields }),
    ...(input.totp && { totp: input.totp }),
  });

  const overviewBlob = JSON.stringify({
    title: input.title,
    username: input.username || null,
    urlHost,
    tags,
    requireReprompt: input.requireReprompt,
  });

  return { fullBlob, overviewBlob };
}
