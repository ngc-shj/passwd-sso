import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface ValidateTeamEntryInput {
  entryType: EntryTypeValue;
  title: string;
  password: string;
  relyingPartyId: string;
  cardNumberValid: boolean;
  dateOfBirth: string;
  issueDate: string;
  expiryDate: string;
  purchaseDate: string;
  expirationDate: string;
  todayIsoDate?: string;
}

interface ValidateTeamEntryResult {
  ok: boolean;
  dobFuture: boolean;
  expiryBeforeIssue: boolean;
  expirationBeforePurchase: boolean;
}

export function validateTeamEntryBeforeSubmit(
  input: ValidateTeamEntryInput
): ValidateTeamEntryResult {
  const today = input.todayIsoDate ?? new Date().toISOString().slice(0, 10);
  const title = input.title.trim();

  if (input.entryType === ENTRY_TYPE.PASSKEY) {
    return {
      ok: !!title && !!input.relyingPartyId.trim(),
      dobFuture: false,
      expiryBeforeIssue: false,
      expirationBeforePurchase: false,
    };
  }

  if (input.entryType === ENTRY_TYPE.CREDIT_CARD) {
    return {
      ok: !!title && input.cardNumberValid,
      dobFuture: false,
      expiryBeforeIssue: false,
      expirationBeforePurchase: false,
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
      expirationBeforePurchase: false,
    };
  }

  if (input.entryType === ENTRY_TYPE.BANK_ACCOUNT) {
    return {
      ok: !!title,
      dobFuture: false,
      expiryBeforeIssue: false,
      expirationBeforePurchase: false,
    };
  }

  if (input.entryType === ENTRY_TYPE.SOFTWARE_LICENSE) {
    const expirationBeforePurchase =
      !!input.purchaseDate &&
      !!input.expirationDate &&
      input.purchaseDate >= input.expirationDate;
    return {
      ok: !!title && !expirationBeforePurchase,
      dobFuture: false,
      expiryBeforeIssue: false,
      expirationBeforePurchase,
    };
  }

  if (input.entryType === ENTRY_TYPE.SECURE_NOTE) {
    return {
      ok: !!title,
      dobFuture: false,
      expiryBeforeIssue: false,
      expirationBeforePurchase: false,
    };
  }

  return {
    ok: !!title && !!input.password,
    dobFuture: false,
    expiryBeforeIssue: false,
    expirationBeforePurchase: false,
  };
}

