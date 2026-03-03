"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { useTeamPolicy } from "@/hooks/use-team-policy";
import {
  applyPolicyToGeneratorSettings,
  buildPolicyAwareGeneratorSettings,
} from "@/hooks/team-login-form-initial-values";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

export interface TeamLoginFormValues {
  username: string;
  password: string;
  url: string;
  showPassword: boolean;
  showGenerator: boolean;
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  showTotpInput: boolean;
}

export interface TeamLoginFormSetters {
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  setUrl: (value: string) => void;
  setShowPassword: (value: boolean) => void;
  setShowGenerator: (value: boolean) => void;
  setGeneratorSettings: (value: GeneratorSettings) => void;
  setCustomFields: Dispatch<SetStateAction<EntryCustomField[]>>;
  setTotp: Dispatch<SetStateAction<EntryTotp | null>>;
  setShowTotpInput: Dispatch<SetStateAction<boolean>>;
}

export type TeamLoginFormState = TeamLoginFormValues & TeamLoginFormSetters;

interface UseTeamLoginFormStateArgs {
  editData?: TeamEntryFormEditData | null;
  teamPolicy: TeamPolicy;
}

export function useTeamLoginFormState({
  editData,
  teamPolicy,
}: UseTeamLoginFormStateArgs): TeamLoginFormState {
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [rawGeneratorSettings, setRawGeneratorSettings] = useState<GeneratorSettings>(
    () => buildPolicyAwareGeneratorSettings(teamPolicy),
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(
    editData?.customFields ?? [],
  );
  const [totp, setTotp] = useState<EntryTotp | null>(editData?.totp ?? null);
  const [showTotpInput, setShowTotpInput] = useState(Boolean(editData?.totp));
  const generatorSettings = applyPolicyToGeneratorSettings(
    rawGeneratorSettings,
    teamPolicy,
  );
  const setGeneratorSettings = useCallback((value: GeneratorSettings) => {
    setRawGeneratorSettings(applyPolicyToGeneratorSettings(value, teamPolicy));
  }, [teamPolicy]);

  return {
    username,
    setUsername,
    password,
    setPassword,
    url,
    setUrl,
    showPassword,
    setShowPassword,
    showGenerator,
    setShowGenerator,
    generatorSettings,
    setGeneratorSettings,
    customFields,
    setCustomFields,
    totp,
    setTotp,
    showTotpInput,
    setShowTotpInput,
  };
}
