import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { TeamEntryKind } from "@/components/team/team-entry-form-types";

export interface TeamEntryKindState {
  entryKind: TeamEntryKind;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  isBankAccount: boolean;
  isSoftwareLicense: boolean;
  isSshKey: boolean;
  isLoginEntry: boolean;
}

export function getTeamEntryKindState(entryType: EntryTypeValue): TeamEntryKindState {
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const isSshKey = entryType === ENTRY_TYPE.SSH_KEY;
  const isLoginEntry = !isNote && !isCreditCard && !isIdentity && !isPasskey && !isBankAccount && !isSoftwareLicense && !isSshKey;

  const entryKind: TeamEntryKind = isSshKey
    ? "sshKey"
    : isBankAccount
    ? "bankAccount"
    : isSoftwareLicense
      ? "softwareLicense"
      : isPasskey
        ? "passkey"
        : isIdentity
          ? "identity"
          : isCreditCard
            ? "creditCard"
            : isNote
              ? "secureNote"
              : "password";

  return {
    entryKind,
    isNote,
    isCreditCard,
    isIdentity,
    isPasskey,
    isBankAccount,
    isSoftwareLicense,
    isSshKey,
    isLoginEntry,
  };
}
