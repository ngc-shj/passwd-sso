import { formatCardNumber } from "@/lib/credit-card";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import type { TeamEntryFieldValues } from "@/hooks/use-team-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";

export type TeamSnapshotBaselineArgs = {
  effectiveEntryType: EntryTypeValue;
  editData?: TeamPasswordFormProps["editData"];
  entryKindState: TeamEntryKindState;
};

export function buildBaselineSnapshot({
  effectiveEntryType,
  editData,
  entryKindState,
}: TeamSnapshotBaselineArgs): string {
  const { isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey, isBankAccount, isSoftwareLicense } = entryKindState;
  return JSON.stringify({
    entryType: effectiveEntryType,
    title: editData?.title ?? "",
    notes: editData?.notes ?? "",
    selectedTagIds: (editData?.tags ?? []).map((tag) => tag.id).sort(),
    teamFolderId: editData?.teamFolderId ?? null,
    login: isLoginEntry
      ? {
          username: editData?.username ?? "",
          password: editData?.password ?? "",
          url: editData?.url ?? "",
          customFields: editData?.customFields ?? [],
          totp: editData?.totp ?? null,
        }
      : null,
    secureNote: isNote
      ? {
          content: editData?.content ?? "",
        }
      : null,
    creditCard: isCreditCard
      ? {
          cardholderName: editData?.cardholderName ?? "",
          cardNumber: formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? ""),
          brand: editData?.brand ?? "",
          expiryMonth: editData?.expiryMonth ?? "",
          expiryYear: editData?.expiryYear ?? "",
          cvv: editData?.cvv ?? "",
        }
      : null,
    identity: isIdentity
      ? {
          fullName: editData?.fullName ?? "",
          address: editData?.address ?? "",
          phone: editData?.phone ?? "",
          email: editData?.email ?? "",
          dateOfBirth: editData?.dateOfBirth ?? "",
          nationality: editData?.nationality ?? "",
          idNumber: editData?.idNumber ?? "",
          issueDate: editData?.issueDate ?? "",
          expiryDate: editData?.expiryDate ?? "",
        }
      : null,
    passkey: isPasskey
      ? {
          relyingPartyId: editData?.relyingPartyId ?? "",
          relyingPartyName: editData?.relyingPartyName ?? "",
          username: editData?.username ?? "",
          credentialId: editData?.credentialId ?? "",
          creationDate: editData?.creationDate ?? "",
          deviceInfo: editData?.deviceInfo ?? "",
        }
      : null,
    bankAccount: isBankAccount
      ? {
          bankName: editData?.bankName ?? "",
          accountType: editData?.accountType ?? "",
          accountHolderName: editData?.accountHolderName ?? "",
          accountNumber: editData?.accountNumber ?? "",
          routingNumber: editData?.routingNumber ?? "",
          swiftBic: editData?.swiftBic ?? "",
          iban: editData?.iban ?? "",
          branchName: editData?.branchName ?? "",
        }
      : null,
    softwareLicense: isSoftwareLicense
      ? {
          softwareName: editData?.softwareName ?? "",
          licenseKey: editData?.licenseKey ?? "",
          version: editData?.version ?? "",
          licensee: editData?.licensee ?? "",
          purchaseDate: editData?.purchaseDate ?? "",
          expirationDate: editData?.expirationDate ?? "",
        }
      : null,
  });
}

export type BuildCurrentSnapshotArgs = {
  effectiveEntryType: EntryTypeValue;
  entryKindState: TeamEntryKindState;
  entryValues: TeamEntryFieldValues;
};

export function buildCurrentSnapshot({
  effectiveEntryType,
  entryKindState,
  entryValues,
}: BuildCurrentSnapshotArgs): string {
  const { isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey, isBankAccount, isSoftwareLicense } = entryKindState;
  const {
    title,
    notes,
    selectedTags,
    teamFolderId,
    username,
    password,
    url,
    customFields,
    totp,
    content,
    cardholderName,
    cardNumber,
    brand,
    expiryMonth,
    expiryYear,
    cvv,
    fullName,
    address,
    phone,
    email,
    dateOfBirth,
    nationality,
    idNumber,
    issueDate,
    expiryDate,
    relyingPartyId,
    relyingPartyName,
    credentialId,
    creationDate,
    deviceInfo,
    bankName,
    accountType,
    accountHolderName,
    accountNumber,
    routingNumber,
    swiftBic,
    iban,
    branchName,
    softwareName,
    licenseKey,
    version,
    licensee,
    purchaseDate,
    expirationDate,
  } = entryValues;
  return JSON.stringify({
    entryType: effectiveEntryType,
    title,
    notes,
    selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
    teamFolderId,
    login: isLoginEntry ? { username, password, url, customFields, totp } : null,
    secureNote: isNote ? { content } : null,
    creditCard: isCreditCard
      ? { cardholderName, cardNumber, brand, expiryMonth, expiryYear, cvv }
      : null,
    identity: isIdentity
      ? {
          fullName,
          address,
          phone,
          email,
          dateOfBirth,
          nationality,
          idNumber,
          issueDate,
          expiryDate,
        }
      : null,
    passkey: isPasskey
      ? {
          relyingPartyId,
          relyingPartyName,
          username,
          credentialId,
          creationDate,
          deviceInfo,
        }
      : null,
    bankAccount: isBankAccount
      ? {
          bankName,
          accountType,
          accountHolderName,
          accountNumber,
          routingNumber,
          swiftBic,
          iban,
          branchName,
        }
      : null,
    softwareLicense: isSoftwareLicense
      ? {
          softwareName,
          licenseKey,
          version,
          licensee,
          purchaseDate,
          expirationDate,
        }
      : null,
  });
}

export function buildTeamSubmitDisabled({
  entryKindState,
  entryValues,
  cardNumberValid,
}: {
  entryKindState: TeamEntryKindState;
  entryValues: Pick<TeamEntryFieldValues, "title" | "password" | "relyingPartyId">;
  cardNumberValid: boolean;
}): boolean {
  const { isPasskey, isLoginEntry, isCreditCard, isBankAccount, isSoftwareLicense } = entryKindState;
  if (isBankAccount || isSoftwareLicense) {
    return !entryValues.title.trim();
  }
  return (
    !entryValues.title.trim() ||
    (isPasskey && !entryValues.relyingPartyId.trim()) ||
    (isLoginEntry && !entryValues.password) ||
    (isCreditCard && !cardNumberValid)
  );
}
