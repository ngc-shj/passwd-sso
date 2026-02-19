import { buildOrgEntryPayload } from "@/lib/org-entry-payload";
import { validateOrgEntryBeforeSubmit } from "@/lib/org-entry-validation";
import { extractTagIds } from "@/lib/entry-form-helpers";
import { detectCardBrand, formatCardNumber, normalizeCardBrand, normalizeCardNumber } from "@/lib/credit-card";
import { executeOrgEntrySubmit } from "@/components/org/org-entry-submit";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";

interface HandleOrgCardNumberChangeArgs {
  value: string;
  brand: string;
  brandSource: "auto" | "manual";
  setCardNumber: (value: string) => void;
  setBrand: (value: string) => void;
}

export function handleOrgCardNumberChange({
  value,
  brand,
  brandSource,
  setCardNumber,
  setBrand,
}: HandleOrgCardNumberChangeArgs): void {
  const digits = normalizeCardNumber(value);
  const detected = detectCardBrand(digits);
  const nextBrand = brandSource === "manual" ? brand : (detected || "");
  const formatted = formatCardNumber(digits, nextBrand || detected);

  setCardNumber(formatted);
  if (brandSource === "auto") {
    setBrand(detected);
  }
}

interface SubmitOrgPasswordFormArgs {
  orgId: string;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  title: string;
  notes: string;
  selectedTags: OrgTagData[];
  orgFolderId: string | null;
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
  cardNumberValid: boolean;
  isIdentity: boolean;
  setDobError: (value: string | null) => void;
  setExpiryError: (value: string | null) => void;
  identityErrorCopy: {
    dobFuture: string;
    expiryBeforeIssue: string;
  };
  t: (key: string) => string;
  setSaving: (value: boolean) => void;
  handleOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export async function submitOrgPasswordForm({
  orgId,
  isEdit,
  editData,
  effectiveEntryType,
  title,
  notes,
  selectedTags,
  orgFolderId,
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
  cardNumberValid,
  isIdentity,
  setDobError,
  setExpiryError,
  identityErrorCopy,
  t,
  setSaving,
  handleOpenChange,
  onSaved,
}: SubmitOrgPasswordFormArgs): Promise<void> {
  const validation = validateOrgEntryBeforeSubmit({
    entryType: effectiveEntryType,
    title,
    password,
    relyingPartyId,
    cardNumberValid,
    dateOfBirth,
    issueDate,
    expiryDate,
  });
  if (isIdentity) {
    setDobError(validation.dobFuture ? identityErrorCopy.dobFuture : null);
    setExpiryError(validation.expiryBeforeIssue ? identityErrorCopy.expiryBeforeIssue : null);
  }
  if (!validation.ok) return;

  const tagIds = extractTagIds(selectedTags);
  const body = buildOrgEntryPayload({
    entryType: effectiveEntryType,
    title,
    notes,
    tagIds,
    orgFolderId,
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
  });

  await executeOrgEntrySubmit({
    orgId,
    isEdit,
    editData,
    body,
    t,
    setSaving,
    handleOpenChange,
    onSaved,
  });
}
