"use client";

import { buildPersonalEntryLoginFieldCallbacks } from "@/hooks/personal-entry-login-fields-callbacks";
import { buildPersonalEntryLoginFieldTextProps } from "@/hooks/personal-entry-login-fields-text-props";
import type {
  EntryLoginMainFieldsProps,
  PersonalEntryLoginFieldTextProps,
  UsePersonalEntryLoginFieldsPropsArgs,
} from "@/hooks/personal-entry-login-fields-types";

type PersonalEntryLoginFieldCallbacks = ReturnType<typeof buildPersonalEntryLoginFieldCallbacks>;

export function buildPersonalEntryLoginFieldPropsFromState({
  values,
  callbacks,
  generatorSummary,
  textProps,
}: {
  values: UsePersonalEntryLoginFieldsPropsArgs["formState"]["values"];
  callbacks: PersonalEntryLoginFieldCallbacks;
  generatorSummary: string;
  textProps: PersonalEntryLoginFieldTextProps;
}): EntryLoginMainFieldsProps {
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

export function usePersonalEntryLoginFieldsProps({
  formState,
  generatorSummary,
  translations,
}: UsePersonalEntryLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  const { values, setters } = formState;
  const { t } = translations;
  const callbacks = buildPersonalEntryLoginFieldCallbacks(values, setters);
  const textProps = buildPersonalEntryLoginFieldTextProps(t);

  return buildPersonalEntryLoginFieldPropsFromState({
    values,
    callbacks,
    generatorSummary,
    textProps,
  });
}
