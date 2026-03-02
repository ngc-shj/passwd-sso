"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamLoginFormEditData } from "@/components/team/team-login-form-types";
import type { useTeamPolicy } from "@/hooks/use-team-policy";
import {
  applyPolicyToGeneratorSettings,
  buildPolicyAwareGeneratorSettings,
} from "@/hooks/team-login-form-initial-values";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

export interface TeamLoginFormState {
  username: string;
  setUsername: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
  showPassword: boolean;
  setShowPassword: (value: boolean) => void;
  showGenerator: boolean;
  setShowGenerator: (value: boolean) => void;
  generatorSettings: GeneratorSettings;
  setGeneratorSettings: (value: GeneratorSettings) => void;
  customFields: EntryCustomField[];
  setCustomFields: Dispatch<SetStateAction<EntryCustomField[]>>;
  totp: EntryTotp | null;
  setTotp: Dispatch<SetStateAction<EntryTotp | null>>;
  showTotpInput: boolean;
  setShowTotpInput: Dispatch<SetStateAction<boolean>>;
}

interface UseTeamLoginFormStateArgs {
  editData?: TeamLoginFormEditData | null;
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
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    () => buildPolicyAwareGeneratorSettings(teamPolicy),
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(
    editData?.customFields ?? [],
  );
  const [totp, setTotp] = useState<EntryTotp | null>(editData?.totp ?? null);
  const [showTotpInput, setShowTotpInput] = useState(Boolean(editData?.totp));

  useEffect(() => {
    setGeneratorSettings((current) =>
      applyPolicyToGeneratorSettings(current, teamPolicy),
    );
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
