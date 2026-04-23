"use client";

import { buildTeamLoginFieldCallbacks } from "@/hooks/team/team-login-fields-callbacks";
import type {
  EntryLoginMainFieldsProps,
  TeamLoginFieldTextProps,
} from "@/hooks/team/team-login-fields-types";

type TeamLoginFieldCallbacks = ReturnType<typeof buildTeamLoginFieldCallbacks>;

interface BuildTeamLoginFieldsPropsArgs {
  values: {
    title: string;
    username: string;
    password: string;
    showPassword: boolean;
    showGenerator: boolean;
    generatorSettings: EntryLoginMainFieldsProps["generatorSettings"];
    url: string;
    notes: string;
  };
  setters: {
    setTitle: (value: string) => void;
    setUsername: (value: string) => void;
    setPassword: (value: string) => void;
    setShowPassword: (value: boolean) => void;
    setShowGenerator: (value: boolean) => void;
    setGeneratorSettings: (value: EntryLoginMainFieldsProps["generatorSettings"]) => void;
    setUrl: (value: string) => void;
    setNotes: (value: string) => void;
  };
  generatorSummary: string;
  textProps: TeamLoginFieldTextProps;
}

function buildTeamLoginFieldPropsFromState({
  values,
  setters,
  generatorSummary,
  textProps,
}: BuildTeamLoginFieldsPropsArgs): EntryLoginMainFieldsProps {
  const callbacks: TeamLoginFieldCallbacks = buildTeamLoginFieldCallbacks(
    values,
    setters,
  );

  return {
    idPrefix: "team-",
    hideTitle: true,
    ...textProps,
    title: values.title,
    onTitleChange: setters.setTitle,
    username: values.username,
    onUsernameChange: callbacks.onUsernameChange,
    password: values.password,
    onPasswordChange: callbacks.onPasswordChange,
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
    onNotesChange: setters.setNotes,
  };
}

export function buildTeamLoginFieldsProps(args: BuildTeamLoginFieldsPropsArgs) {
  return buildTeamLoginFieldPropsFromState(args);
}
