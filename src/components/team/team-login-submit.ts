import { buildTeamEntryPayload } from "@/lib/team/team-entry-payload";
import { validateTeamEntryBeforeSubmit } from "@/lib/team/team-entry-validation";
import { extractTagIds } from "@/lib/vault/entry-form-helpers";
import { detectCardBrand, formatCardNumber, normalizeCardBrand, normalizeCardNumber } from "@/lib/credit-card";
import { executeTeamEntrySubmit } from "@/components/team/team-entry-submit";
import type { EntryTypeValue } from "@/lib/constants";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { EntryCustomField, EntryTotp } from "@/lib/vault/entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface HandleTeamCardNumberChangeArgs {
  value: string;
  brand: string;
  brandSource: "auto" | "manual";
  setCardNumber: (value: string) => void;
  setBrand: (value: string) => void;
}

export function handleTeamCardNumberChange({
  value,
  brand,
  brandSource,
  setCardNumber,
  setBrand,
}: HandleTeamCardNumberChangeArgs): void {
  const digits = normalizeCardNumber(value);
  const detected = detectCardBrand(digits);
  const nextBrand = brandSource === "manual" ? brand : (detected || "");
  const formatted = formatCardNumber(digits, nextBrand || detected);

  setCardNumber(formatted);
  if (brandSource === "auto") {
    setBrand(detected);
  }
}

export interface SubmitTeamLoginArgs {
  teamId: string;
  teamEncryptionKey: CryptoKey;
  teamKeyVersion: number;
  isEdit: boolean;
  editData?: TeamEntryFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  title: string;
  notes: string;
  selectedTags: TeamTagData[];
  teamFolderId: string | null;
  username: string;
  password: string;
  url: string;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  content: string;
  cardholderName: string;
  cardNumber: string;
  brand: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  fullName: string;
  address: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  nationality: string;
  idNumber: string;
  issueDate: string;
  expiryDate: string;
  relyingPartyId: string;
  relyingPartyName: string;
  credentialId: string;
  creationDate: string;
  deviceInfo: string;
  bankName: string;
  accountType: string;
  accountHolderName: string;
  accountNumber: string;
  routingNumber: string;
  swiftBic: string;
  iban: string;
  branchName: string;
  softwareName: string;
  licenseKey: string;
  version: string;
  licensee: string;
  purchaseDate: string;
  expirationDate: string;
  travelSafe: boolean;
  requireReprompt: boolean;
  expiresAt: string | null;
  cardNumberValid: boolean;
  isIdentity: boolean;
  isBankAccount: boolean;
  isSoftwareLicense: boolean;
  setDobError: (value: string | null) => void;
  setExpiryError: (value: string | null) => void;
  identityErrorCopy: {
    dobFuture: string;
    expiryBeforeIssue: string;
  };
  softwareLicenseErrorCopy: {
    expirationBeforePurchase: string;
  };
  t: PasswordFormTranslator;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export async function submitTeamLogin({
  teamId,
  teamEncryptionKey,
  teamKeyVersion,
  isEdit,
  editData,
  effectiveEntryType,
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
  travelSafe,
  requireReprompt,
  expiresAt,
  cardNumberValid,
  isIdentity,
  isSoftwareLicense,
  setDobError,
  setExpiryError,
  identityErrorCopy,
  softwareLicenseErrorCopy,
  t,
  setSaving,
  handleOpenChange,
  onSaved,
}: SubmitTeamLoginArgs): Promise<void> {
  const validation = validateTeamEntryBeforeSubmit({
    entryType: effectiveEntryType,
    title,
    password,
    relyingPartyId,
    cardNumberValid,
    dateOfBirth,
    issueDate,
    expiryDate,
    purchaseDate,
    expirationDate,
  });
  if (isIdentity) {
    setDobError(validation.dobFuture ? identityErrorCopy.dobFuture : null);
    setExpiryError(validation.expiryBeforeIssue ? identityErrorCopy.expiryBeforeIssue : null);
  }
  if (isSoftwareLicense) {
    setExpiryError(validation.expirationBeforePurchase ? softwareLicenseErrorCopy.expirationBeforePurchase : null);
  }
  if (!validation.ok) return;

  const tagIds = extractTagIds(selectedTags);
  const tagNames = selectedTags.map((t) => ({ name: t.name, color: t.color }));

  const { fullBlob, overviewBlob } = buildTeamEntryPayload({
    entryType: effectiveEntryType,
    title,
    notes,
    tagNames,
    username,
    password,
    url,
    customFields,
    totp,
    content,
    cardholderName,
    cardNumber: normalizeCardNumber(cardNumber),
    brand: normalizeCardBrand(brand),
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
    travelSafe,
  });

  await executeTeamEntrySubmit({
    teamId: teamId,
    isEdit,
    editData,
    teamEncryptionKey,
    teamKeyVersion,
    fullBlob,
    overviewBlob,
    entryType: effectiveEntryType,
    tagIds,
    teamFolderId,
    requireReprompt,
    expiresAt,
    t,
    setSaving,
    handleOpenChange,
    onSaved,
  });
}
