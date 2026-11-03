"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";
import { SYMBOL_GROUP_KEYS } from "@/lib/generator/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import type { TeamEntryFormEditData } from "@/components/team/forms/team-entry-form-types";
import type { useTeamPolicy } from "@/hooks/team/use-team-policy";
import {
  applyPolicyToGeneratorSettings,
  buildPolicyAwareGeneratorSettings,
} from "@/hooks/team/team-login-form-initial-values";
import { getPolicyViolations, checkPasswordReuse, type PolicyViolation } from "@/lib/security/password-policy-validation";
import { useTeamVault, type EntryItemKeyData } from "@/lib/team/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { itemKeyIdsMatch, teamEntryAadFor } from "@/lib/team/team-key-resolution";
import { historyRowKeyData, type TeamHistoryRowDto } from "@/lib/team/team-history-restore";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

type TeamPolicy = ReturnType<typeof useTeamPolicy>["policy"];

interface TeamHistoryListRow {
  id: string;
  encryptedBlob: { ciphertext: string; iv: string; authTag: string };
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number | null;
  itemKeyId: string | null;
}

async function fetchHistoryRowKeyData(
  teamId: string,
  entryId: string,
  historyId: string,
): Promise<EntryItemKeyData> {
  const res = await fetchApi(apiPath.teamPasswordHistoryById(teamId, entryId, historyId));
  if (!res.ok) throw new Error("Failed to fetch history row");
  return historyRowKeyData((await res.json()) as TeamHistoryRowDto);
}

/** Fetch and decrypt the last N history blobs for a team entry, returning plaintext passwords. */
async function fetchDecryptedHistoryPasswords(
  teamId: string,
  entryId: string,
  editData: TeamEntryFormEditData,
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>,
  count: number,
): Promise<string[]> {
  const res = await fetchApi(apiPath.teamPasswordHistory(teamId, entryId));
  if (!res.ok) {
    return [];
  }
  const records: TeamHistoryListRow[] = await res.json();

  const passwords: string[] = [];
  const limited = records.slice(0, count);

  // Each history row is decrypted with its OWN wrap (a row saved before a
  // re-key or restore is under a different ItemKey than the live entry); a
  // list row carries no wrap, so it is read from the row's own endpoint
  // unless it shares the live ItemKey (same id → served from the cache).
  for (const record of limited) {
    try {
      const itemKeyVersion = record.itemKeyVersion ?? 0;
      const keyData: EntryItemKeyData = itemKeyIdsMatch(record.itemKeyId, editData.itemKeyId)
        ? {
            itemKeyVersion: editData.itemKeyVersion,
            encryptedItemKey: editData.encryptedItemKey,
            itemKeyIv: editData.itemKeyIv,
            itemKeyAuthTag: editData.itemKeyAuthTag,
            itemKeyId: editData.itemKeyId,
            teamKeyVersion: editData.teamKeyVersion ?? 1,
          }
        : await fetchHistoryRowKeyData(teamId, entryId, record.id);
      const decryptKey = await getEntryDecryptionKey(teamId, entryId, keyData);
      const aad = teamEntryAadFor(teamId, entryId, VAULT_TYPE.BLOB, itemKeyVersion, record.aadVersion);
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
