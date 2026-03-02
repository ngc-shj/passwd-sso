import type { TeamLoginFormEditData } from "@/components/team/team-login-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { useTeamPolicy } from "@/hooks/use-team-policy";
import { buildTeamLoginFormDerived } from "@/hooks/team-login-form-derived";
import { buildTeamLoginFieldsProps } from "@/hooks/team-login-fields-props";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

interface BuildTeamLoginFormPresenterArgs {
  editData?: TeamLoginFormEditData | null;
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
  t: (key: string) => string;
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
    expiresAt,
    generatorSettings,
    tGen,
  });

  const loginMainFieldsProps = buildTeamLoginFieldsProps({
    title,
    onTitleChange: setTitle,
    titleLabel,
    titlePlaceholder,
    username,
    onUsernameChange: setUsername,
    usernameLabel: t("usernameEmail"),
    usernamePlaceholder: t("usernamePlaceholder"),
    password,
    onPasswordChange: setPassword,
    passwordLabel: t("password"),
    passwordPlaceholder: t("passwordPlaceholder"),
    showPassword,
    onToggleShowPassword: () => setShowPassword(!showPassword),
    generatorSummary,
    showGenerator,
    onToggleGenerator: () => setShowGenerator(!showGenerator),
    closeGeneratorLabel: t("closeGenerator"),
    openGeneratorLabel: t("openGenerator"),
    generatorSettings,
    onGeneratorUse: (pw, settings) => {
      setPassword(pw);
      setGeneratorSettings(settings);
    },
    url,
    onUrlChange: setUrl,
    urlLabel: t("url"),
    notes,
    onNotesChange: setNotes,
    notesLabel,
    notesPlaceholder,
    teamPolicy,
  });

  return {
    hasChanges,
    generatorSummary,
    loginMainFieldsProps,
  };
}
