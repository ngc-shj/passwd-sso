"use client";

import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";
import type { GeneratorSettings } from "@/lib/generator-prefs";

type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

interface UsePersonalEntryLoginFieldsPropsArgs {
  values: PersonalPasswordFormState["values"];
  setters: PersonalPasswordFormState["setters"];
  generatorSummary: string;
  translations: Pick<PersonalPasswordFormTranslations, "t">;
}

export function usePersonalEntryLoginFieldsProps({
  values,
  setters,
  generatorSummary,
  translations,
}: UsePersonalEntryLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  const { t } = translations;

  return {
    title: values.title,
    onTitleChange: setters.setTitle,
    titleLabel: t("title"),
    titlePlaceholder: t("titlePlaceholder"),
    titleRequired: true,
    username: values.username,
    onUsernameChange: setters.setUsername,
    usernameLabel: t("usernameEmail"),
    usernamePlaceholder: t("usernamePlaceholder"),
    password: values.password,
    onPasswordChange: setters.setPassword,
    passwordLabel: t("password"),
    passwordPlaceholder: t("passwordPlaceholder"),
    passwordRequired: true,
    showPassword: values.showPassword,
    onToggleShowPassword: () => setters.setShowPassword(!values.showPassword),
    generatorSummary,
    showGenerator: values.showGenerator,
    onToggleGenerator: () => setters.setShowGenerator(!values.showGenerator),
    closeGeneratorLabel: t("closeGenerator"),
    openGeneratorLabel: t("openGenerator"),
    generatorSettings: values.generatorSettings,
    onGeneratorUse: (pw: string, settings: GeneratorSettings) => {
      setters.setPassword(pw);
      setters.setShowPassword(true);
      setters.setGeneratorSettings(settings);
    },
    url: values.url,
    onUrlChange: setters.setUrl,
    urlLabel: t("url"),
    notes: values.notes,
    onNotesChange: setters.setNotes,
    notesLabel: t("notes"),
    notesPlaceholder: t("notesPlaceholder"),
  };
}
