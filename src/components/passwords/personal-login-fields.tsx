"use client";

import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { GeneratorSettings } from "@/lib/generator-prefs";

interface PersonalLoginFieldsProps {
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
}

export function PersonalLoginFields({
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
}: PersonalLoginFieldsProps) {
  return (
    <EntryLoginMainFields
      title={title}
      onTitleChange={onTitleChange}
      titleLabel={titleLabel}
      titlePlaceholder={titlePlaceholder}
      titleRequired
      username={username}
      onUsernameChange={onUsernameChange}
      usernameLabel={usernameLabel}
      usernamePlaceholder={usernamePlaceholder}
      password={password}
      onPasswordChange={onPasswordChange}
      passwordLabel={passwordLabel}
      passwordPlaceholder={passwordPlaceholder}
      passwordRequired
      showPassword={showPassword}
      onToggleShowPassword={onToggleShowPassword}
      generatorSummary={generatorSummary}
      showGenerator={showGenerator}
      onToggleGenerator={onToggleGenerator}
      closeGeneratorLabel={closeGeneratorLabel}
      openGeneratorLabel={openGeneratorLabel}
      generatorSettings={generatorSettings}
      onGeneratorUse={onGeneratorUse}
      url={url}
      onUrlChange={onUrlChange}
      urlLabel={urlLabel}
      notes={notes}
      onNotesChange={onNotesChange}
      notesLabel={notesLabel}
      notesPlaceholder={notesPlaceholder}
    />
  );
}
