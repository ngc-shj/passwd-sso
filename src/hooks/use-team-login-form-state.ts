"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import { SYMBOL_GROUP_KEYS } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { useTeamPolicy } from "@/hooks/use-team-policy";
import {
  applyPolicyToGeneratorSettings,
  buildPolicyAwareGeneratorSettings,
} from "@/hooks/team-login-form-initial-values";
import { getPolicyViolations, checkPasswordReuse, type PolicyViolation } from "@/lib/password-policy-validation";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

/** Fetch and decrypt the last N history blobs for a team entry, returning plaintext passwords. */
async function fetchDecryptedHistoryPasswords(
  teamId: string,
  entryId: string,
  editData: TeamEntryFormEditData,
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: import("@/lib/team-vault-core").EntryItemKeyData) => Promise<CryptoKey>,
  count: number,
): Promise<string[]> {
  const res = await fetchApi(apiPath.teamPasswordHistory(teamId, entryId));
  if (!res.ok) return [];
  const records: Array<{
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    aadVersion: number;
    teamKeyVersion: number;
    itemKeyVersion: number | null;
  }> = await res.json();

  const passwords: string[] = [];
  const limited = records.slice(0, count);
  const decryptKey = await getEntryDecryptionKey(teamId, entryId, {
    itemKeyVersion: editData.itemKeyVersion,
    encryptedItemKey: editData.encryptedItemKey,
    itemKeyIv: editData.itemKeyIv,
    itemKeyAuthTag: editData.itemKeyAuthTag,
    teamKeyVersion: editData.teamKeyVersion ?? 1,
  });

  for (const record of limited) {
    try {
      const itemKeyVersion = record.itemKeyVersion ?? 0;
      const aad = buildTeamEntryAAD(teamId, entryId, "blob", itemKeyVersion);
      const plaintext = await decryptData(record.encryptedBlob, decryptKey, aad);
      const parsed: { password?: string } = JSON.parse(plaintext);
      if (typeof parsed.password === "string") {
        passwords.push(parsed.password);
      }
    } catch {
      // Skip entries that fail to decrypt
    }
  }
  return passwords;
}

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
  teamId: string;
  editData?: TeamEntryFormEditData | null;
  teamPolicy: TeamPolicy;
  setPolicyViolations?: (violations: PolicyViolation[]) => void;
}

export function useTeamLoginFormState({
  teamId,
  editData,
  teamPolicy,
  setPolicyViolations,
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

  // Lazily fetch and decrypt history passwords for reuse detection.
  // Only runs when editing an existing entry with passwordHistoryCount > 0.
  const { getEntryDecryptionKey } = useTeamVault();
  const decryptedHistoryRef = useRef<string[] | null>(null);
  const historyFetchedRef = useRef(false);

  useEffect(() => {
    const historyCount = teamPolicy?.passwordHistoryCount ?? 0;
    if (!editData?.id || historyCount <= 0 || historyFetchedRef.current) return;
    historyFetchedRef.current = true;

    fetchDecryptedHistoryPasswords(
      teamId,
      editData.id,
      editData,
      getEntryDecryptionKey,
      historyCount,
    ).then((passwords) => {
      decryptedHistoryRef.current = passwords;
    }).catch(() => {
      // Best-effort: leave ref null so reuse check is skipped
    });
  }, [teamId, editData, teamPolicy?.passwordHistoryCount, getEntryDecryptionKey]);

  // Compute policy violations based on current generator settings and password reuse.
  // generatorSettings is derived from rawGeneratorSettings + teamPolicy, so listing
  // those two as deps is sufficient and avoids a circular dependency on generatorSettings.
  const generatorViolations = useMemo(() => {
    if (!teamPolicy) return [];
    const settings = applyPolicyToGeneratorSettings(rawGeneratorSettings, teamPolicy);
    const hasAnySymbolGroup = SYMBOL_GROUP_KEYS.some((key) => settings.symbolGroups[key]);
    return getPolicyViolations({ ...settings, hasAnySymbolGroup }, teamPolicy);
  }, [rawGeneratorSettings, teamPolicy]);

  // Password reuse check runs in effect (not render) because it reads a ref.
  useEffect(() => {
    if (!setPolicyViolations) return;
    const violations = [...generatorViolations];
    if (
      teamPolicy &&
      teamPolicy.passwordHistoryCount > 0 &&
      decryptedHistoryRef.current !== null &&
      password &&
      checkPasswordReuse(password, decryptedHistoryRef.current)
    ) {
      violations.push({ key: "policyPasswordReuse" });
    }
    setPolicyViolations(violations);
  }, [generatorViolations, teamPolicy, password, setPolicyViolations]);

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
