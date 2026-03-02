import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamLoginFormEditData } from "@/components/team/team-login-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";

interface BuildTeamLoginFormDerivedArgs {
  editData?: TeamLoginFormEditData | null;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
  title: string;
  notes: string;
  username: string;
  password: string;
  url: string;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  selectedTags: TeamTagData[];
  teamFolderId: string | null;
  requireReprompt: boolean;
  expiresAt: string | null;
  generatorSettings: GeneratorSettings;
  tGen: (key: "modePassphrase" | "modePassword") => string;
}

export function buildTeamLoginFormDerived({
  editData,
  defaultFolderId,
  defaultTags,
  title,
  notes,
  username,
  password,
  url,
  customFields,
  totp,
  selectedTags,
  teamFolderId,
  requireReprompt,
  expiresAt,
  generatorSettings,
  tGen,
}: BuildTeamLoginFormDerivedArgs) {
  const baselineSnapshot = JSON.stringify({
    title: editData?.title ?? "",
    notes: editData?.notes ?? "",
    username: editData?.username ?? "",
    password: editData?.password ?? "",
    url: editData?.url ?? "",
    customFields: JSON.stringify(editData?.customFields ?? []),
    totp: JSON.stringify(editData?.totp ?? null),
    selectedTagIds: (editData?.tags ?? defaultTags ?? []).map((tag) => tag.id).sort(),
    teamFolderId: editData?.teamFolderId ?? defaultFolderId ?? null,
    requireReprompt: editData?.requireReprompt ?? false,
    expiresAt: editData?.expiresAt ?? null,
  });

  const currentSnapshot = JSON.stringify({
    title,
    notes,
    username,
    password,
    url,
    customFields: JSON.stringify(customFields),
    totp: JSON.stringify(totp),
    selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
    teamFolderId,
    requireReprompt,
    expiresAt,
  });

  const generatorSummary = buildGeneratorSummary(generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  return {
    hasChanges: currentSnapshot !== baselineSnapshot,
    generatorSummary,
  };
}
