import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface ValidateOrgEntryInput {
  entryType: EntryTypeValue;
  title: string;
  password: string;
  relyingPartyId: string;
  cardNumberValid: boolean;
  dateOfBirth: string;
  issueDate: string;
  expiryDate: string;
  todayIsoDate?: string;
}

interface ValidateOrgEntryResult {
  ok: boolean;
  dobFuture: boolean;
  expiryBeforeIssue: boolean;
}

export function validateOrgEntryBeforeSubmit(
  input: ValidateOrgEntryInput
): ValidateOrgEntryResult {
  const today = input.todayIsoDate ?? new Date().toISOString().slice(0, 10);
  const title = input.title.trim();

  if (input.entryType === ENTRY_TYPE.PASSKEY) {
    return {
      ok: !!title && !!input.relyingPartyId.trim(),
      dobFuture: false,
      expiryBeforeIssue: false,
    };
  }

  if (input.entryType === ENTRY_TYPE.CREDIT_CARD) {
    return {
      ok: !!title && input.cardNumberValid,
      dobFuture: false,
      expiryBeforeIssue: false,
    };
  }

  if (input.entryType === ENTRY_TYPE.IDENTITY) {
    const dobFuture = !!input.dateOfBirth && input.dateOfBirth > today;
    const expiryBeforeIssue =
      !!input.issueDate &&
      !!input.expiryDate &&
      input.issueDate >= input.expiryDate;
    return {
      ok: !!title && !dobFuture && !expiryBeforeIssue,
      dobFuture,
      expiryBeforeIssue,
    };
  }

  if (input.entryType === ENTRY_TYPE.SECURE_NOTE) {
    return {
      ok: !!title,
      dobFuture: false,
      expiryBeforeIssue: false,
    };
  }

  return {
    ok: !!title && !!input.password,
    dobFuture: false,
    expiryBeforeIssue: false,
  };
}

