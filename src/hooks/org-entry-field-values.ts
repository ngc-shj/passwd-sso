import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";
import type { OrgPasswordFormValues } from "@/hooks/use-org-password-form-state";

export interface OrgEntryFieldValues {
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
}

export function selectOrgEntryFieldValues(values: OrgPasswordFormValues): OrgEntryFieldValues {
  return {
    title: values.title,
    notes: values.notes,
    selectedTags: values.selectedTags,
    orgFolderId: values.orgFolderId,
    username: values.username,
    password: values.password,
    url: values.url,
    customFields: values.customFields,
    totp: values.totp,
    content: values.content,
    cardholderName: values.cardholderName,
    cardNumber: values.cardNumber,
    brand: values.brand,
    expiryMonth: values.expiryMonth,
    expiryYear: values.expiryYear,
    cvv: values.cvv,
    fullName: values.fullName,
    address: values.address,
    phone: values.phone,
    email: values.email,
    dateOfBirth: values.dateOfBirth,
    nationality: values.nationality,
    idNumber: values.idNumber,
    issueDate: values.issueDate,
    expiryDate: values.expiryDate,
    relyingPartyId: values.relyingPartyId,
    relyingPartyName: values.relyingPartyName,
    credentialId: values.credentialId,
    creationDate: values.creationDate,
    deviceInfo: values.deviceInfo,
  };
}
