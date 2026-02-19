"use client";

import type { ComponentProps } from "react";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import type { PersonalPasswordFormTranslations } from "@/hooks/use-entry-form-translations";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";
import { buildPersonalEntryLoginFieldCallbacks } from "@/hooks/personal-entry-login-fields-callbacks";
import { buildPersonalEntryLoginFieldTextProps } from "@/hooks/personal-entry-login-fields-text-props";

type EntryLoginMainFieldsProps = ComponentProps<typeof EntryLoginMainFields>;

interface UsePersonalEntryLoginFieldsPropsArgs {
  formState: PersonalPasswordFormState;
  generatorSummary: string;
  translations: Pick<PersonalPasswordFormTranslations, "t">;
}

export function usePersonalEntryLoginFieldsProps({
  formState,
  generatorSummary,
  translations,
}: UsePersonalEntryLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  const { values, setters } = formState;
  const { t } = translations;
  const callbacks = buildPersonalEntryLoginFieldCallbacks(values, setters);
  const textProps = buildPersonalEntryLoginFieldTextProps(t);

  return {
    ...textProps,
    title: values.title,
    onTitleChange: callbacks.onTitleChange,
    titleRequired: true,
    username: values.username,
    onUsernameChange: callbacks.onUsernameChange,
    password: values.password,
    onPasswordChange: callbacks.onPasswordChange,
    passwordRequired: true,
    showPassword: values.showPassword,
    onToggleShowPassword: callbacks.onToggleShowPassword,
    generatorSummary,
    showGenerator: values.showGenerator,
    onToggleGenerator: callbacks.onToggleGenerator,
    generatorSettings: values.generatorSettings,
    onGeneratorUse: callbacks.onGeneratorUse,
    url: values.url,
    onUrlChange: callbacks.onUrlChange,
    notes: values.notes,
    onNotesChange: callbacks.onNotesChange,
  };
}
