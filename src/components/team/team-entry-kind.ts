import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { TeamEntryKind } from "@/components/team/team-password-form-types";

export interface TeamEntryKindState {
  entryKind: TeamEntryKind;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  isLoginEntry: boolean;
}

export function getTeamEntryKindState(entryType: EntryTypeValue): TeamEntryKindState {
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isLoginEntry = !isNote && !isCreditCard && !isIdentity && !isPasskey;

  const entryKind: TeamEntryKind = isPasskey
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
    isLoginEntry,
  };
}
