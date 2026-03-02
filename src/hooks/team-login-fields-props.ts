import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { useTeamPolicy } from "@/hooks/use-team-policy";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];
type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

interface BuildTeamLoginFieldsPropsArgs {
  title: string;
  onTitleChange: (value: string) => void;
  titleLabel: string;
  titlePlaceholder: string;
  username: string;
  onUsernameChange: (value: string) => void;
  usernameLabel: string;
  usernamePlaceholder: string;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordLabel: string;
  passwordPlaceholder: string;
  showPassword: boolean;
  onToggleShowPassword: () => void;
  generatorSummary: string;
  showGenerator: boolean;
  onToggleGenerator: () => void;
  closeGeneratorLabel: string;
  openGeneratorLabel: string;
  generatorSettings: GeneratorSettings;
  onGeneratorUse: (password: string, settings: GeneratorSettings) => void;
  url: string;
  onUrlChange: (value: string) => void;
  urlLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesLabel: string;
  notesPlaceholder: string;
  teamPolicy: TeamPolicy;
}

export function buildTeamLoginFieldsProps({
  title,
  onTitleChange,
  titleLabel,
  titlePlaceholder,
  username,
  onUsernameChange,
  usernameLabel,
  usernamePlaceholder,
  password,
  onPasswordChange,
  passwordLabel,
  passwordPlaceholder,
  showPassword,
  onToggleShowPassword,
  generatorSummary,
  showGenerator,
  onToggleGenerator,
  closeGeneratorLabel,
  openGeneratorLabel,
  generatorSettings,
  onGeneratorUse,
  url,
  onUrlChange,
  urlLabel,
  notes,
  onNotesChange,
  notesLabel,
  notesPlaceholder,
  teamPolicy,
}: BuildTeamLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  return {
    idPrefix: "team-",
    hideTitle: true,
    title,
    onTitleChange,
    titleLabel,
    titlePlaceholder,
    username,
    onUsernameChange,
    usernameLabel,
    usernamePlaceholder,
    password,
    onPasswordChange,
    passwordLabel,
    passwordPlaceholder,
    showPassword,
    onToggleShowPassword,
    generatorSummary,
    showGenerator,
    onToggleGenerator,
    closeGeneratorLabel,
    openGeneratorLabel,
    generatorSettings,
    onGeneratorUse,
    url,
    onUrlChange,
    urlLabel,
    notes,
    onNotesChange,
    notesLabel,
    notesPlaceholder,
    teamPolicy,
  };
}
