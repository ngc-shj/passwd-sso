import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { buildLoginFormDerived, buildSnapshot } from "@/hooks/form/login-form-derived";

interface BuildTeamLoginFormDerivedArgs {
  editData?: TeamEntryFormEditData | null;
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
  travelSafe: boolean;
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
  travelSafe,
  expiresAt,
  generatorSettings,
  tGen,
}: BuildTeamLoginFormDerivedArgs) {
  const initialSnapshot = buildSnapshot("team", {
    title: editData?.title ?? "",
    notes: editData?.notes ?? "",
    username: editData?.username ?? "",
    password: editData?.password ?? "",
    url: editData?.url ?? "",
    tags: editData?.tags ?? defaultTags ?? [],
    customFields: editData?.customFields ?? [],
    totp: editData?.totp ?? null,
    folderId: editData?.teamFolderId ?? defaultFolderId ?? null,
    requireReprompt: editData?.requireReprompt ?? false,
    travelSafe: editData?.travelSafe ?? true,
    expiresAt: editData?.expiresAt ?? null,
    generatorSettings,
  });

  return buildLoginFormDerived({
    scope: "team",
    title,
    notes,
    username,
    password,
    url,
    tags: selectedTags,
    customFields,
    totp,
    folderId: teamFolderId,
    requireReprompt,
    travelSafe,
    expiresAt,
    generatorSettings,
    tGen,
    initialSnapshot,
  });
}
