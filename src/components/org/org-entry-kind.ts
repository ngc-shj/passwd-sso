import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgEntryKind } from "@/components/org/org-password-form-types";

interface OrgEntryKindState {
  entryKind: OrgEntryKind;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  isLoginEntry: boolean;
}

export function getOrgEntryKindState(entryType: EntryTypeValue): OrgEntryKindState {
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isLoginEntry = !isNote && !isCreditCard && !isIdentity && !isPasskey;

  const entryKind: OrgEntryKind = isPasskey
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
