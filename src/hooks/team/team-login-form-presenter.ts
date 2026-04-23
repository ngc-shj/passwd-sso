import type { TeamEntryFormEditData } from "@/components/team/forms/team-entry-form-types";
import type { TeamTagData } from "@/components/team/forms/team-tag-input";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import type { useTeamPolicy } from "@/hooks/team/use-team-policy";
import { buildTeamLoginFormDerived } from "@/hooks/team/team-login-form-derived";
import { buildTeamLoginFieldsProps } from "@/hooks/team/team-login-fields-props";
import { buildTeamLoginFieldTextProps } from "@/hooks/team/team-login-fields-text-props";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

interface BuildTeamLoginFormPresenterArgs {
  editData?: TeamEntryFormEditData | null;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
  title: string;
  setTitle: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  username: string;
  setUsername: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  selectedTags: TeamTagData[];
  teamFolderId: string | null;
  requireReprompt: boolean;
  travelSafe: boolean;
  expiresAt: string | null;
  generatorSettings: GeneratorSettings;
  setGeneratorSettings: (value: GeneratorSettings) => void;
  showPassword: boolean;
  setShowPassword: (value: boolean) => void;
  showGenerator: boolean;
  setShowGenerator: (value: boolean) => void;
  titleLabel: string;
  titlePlaceholder: string;
  notesLabel: string;
  notesPlaceholder: string;
  teamPolicy: TeamPolicy;
  t: PasswordFormTranslator;
  tGen: (key: "modePassphrase" | "modePassword") => string;
}

export function buildTeamLoginFormPresenter({
  editData,
  defaultFolderId,
  defaultTags,
  title,
  setTitle,
  notes,
  setNotes,
  username,
  setUsername,
  password,
  setPassword,
  url,
  setUrl,
  customFields,
  totp,
  selectedTags,
  teamFolderId,
  requireReprompt,
  travelSafe,
  expiresAt,
  generatorSettings,
  setGeneratorSettings,
  showPassword,
  setShowPassword,
  showGenerator,
  setShowGenerator,
  titleLabel,
  titlePlaceholder,
  notesLabel,
  notesPlaceholder,
  teamPolicy,
  t,
  tGen,
}: BuildTeamLoginFormPresenterArgs) {
  const { hasChanges, generatorSummary } = buildTeamLoginFormDerived({
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
  });

  const textProps = buildTeamLoginFieldTextProps(t, teamPolicy);

  const loginMainFieldsProps = buildTeamLoginFieldsProps({
    values: {
      title,
      username,
      password,
      showPassword,
      showGenerator,
      generatorSettings,
      url,
      notes,
    },
    setters: {
      setTitle,
      setUsername,
      setPassword,
      setShowPassword,
      setShowGenerator,
      setGeneratorSettings,
      setUrl,
      setNotes,
    },
    generatorSummary,
    textProps: {
      ...textProps,
      titleLabel,
      titlePlaceholder,
      notesLabel,
      notesPlaceholder,
    },
  });

  return {
    hasChanges,
    generatorSummary,
    loginMainFieldsProps,
  };
}
