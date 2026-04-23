import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { BuildTeamEntryPayloadInput } from "@/lib/team-entry-payload";

interface CreateTeamLoginSubmitHandlerArgs {
  submitDisabled: boolean;
  submitEntry: (payloadInput: BuildTeamEntryPayloadInput) => Promise<void>;
  title: string;
  notes: string;
  selectedTags: TeamTagData[];
  username: string;
  password: string;
  url: string;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
}

export function createTeamLoginSubmitHandler({
  submitDisabled,
  submitEntry,
  title,
  notes,
  selectedTags,
  username,
  password,
  url,
  customFields,
  totp,
}: CreateTeamLoginSubmitHandlerArgs) {
  return async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    const tagNames = selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await submitEntry({
      entryType: ENTRY_TYPE.LOGIN,
      title,
      notes,
      tagNames,
      username,
      password,
      url,
      customFields,
      totp,
    });
  };
}
