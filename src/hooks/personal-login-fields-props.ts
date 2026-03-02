"use client";

import { buildPersonalLoginFieldCallbacks } from "@/hooks/personal-login-fields-callbacks";
import { buildPersonalLoginFieldTextProps } from "@/hooks/personal-login-fields-text-props";
import type {
  EntryLoginMainFieldsProps,
  PersonalLoginFieldTextProps,
  BuildPersonalLoginFieldsPropsArgs,
} from "@/hooks/personal-login-fields-types";

type PersonalLoginFieldCallbacks = ReturnType<typeof buildPersonalLoginFieldCallbacks>;

export function buildPersonalLoginFieldPropsFromState({
  values,
  callbacks,
  generatorSummary,
  textProps,
}: {
  values: BuildPersonalLoginFieldsPropsArgs["formState"]["values"];
  callbacks: PersonalLoginFieldCallbacks;
  generatorSummary: string;
  textProps: PersonalLoginFieldTextProps;
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

export function buildPersonalLoginFieldsProps({
  formState,
  generatorSummary,
  translations,
}: BuildPersonalLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  const { values, setters } = formState;
  const { t } = translations;
  const callbacks = buildPersonalLoginFieldCallbacks(values, setters);
  const textProps = buildPersonalLoginFieldTextProps(t);

  return buildPersonalLoginFieldPropsFromState({
    values,
    callbacks,
    generatorSummary,
    textProps,
  });
}
