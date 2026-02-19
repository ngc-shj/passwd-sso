import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import { formatCardNumber } from "@/lib/credit-card";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";

export interface OrgPasswordFormInitialValues {
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
  selectedTags: OrgTagData[];
  generatorSettings: GeneratorSettings;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  showTotpInput: boolean;
  cardholderName: string;
  cardNumber: string;
  brand: string;
  brandSource: "auto" | "manual";
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
  orgFolderId: string | null;
}

export function buildOrgPasswordFormInitialValues(
  editData?: OrgPasswordFormEditData | null,
): OrgPasswordFormInitialValues {
  return {
    title: editData?.title ?? "",
    username: editData?.username ?? "",
    password: editData?.password ?? "",
    content: editData?.content ?? "",
    url: editData?.url ?? "",
    notes: editData?.notes ?? "",
    selectedTags: editData?.tags ?? [],
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: editData?.customFields ?? [],
    totp: editData?.totp ?? null,
    showTotpInput: Boolean(editData?.totp),
    cardholderName: editData?.cardholderName ?? "",
    cardNumber: formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? ""),
    brand: editData?.brand ?? "",
    brandSource: editData?.brand ? "manual" : "auto",
    expiryMonth: editData?.expiryMonth ?? "",
    expiryYear: editData?.expiryYear ?? "",
    cvv: editData?.cvv ?? "",
    fullName: editData?.fullName ?? "",
    address: editData?.address ?? "",
    phone: editData?.phone ?? "",
    email: editData?.email ?? "",
    dateOfBirth: editData?.dateOfBirth ?? "",
    nationality: editData?.nationality ?? "",
    idNumber: editData?.idNumber ?? "",
    issueDate: editData?.issueDate ?? "",
    expiryDate: editData?.expiryDate ?? "",
    relyingPartyId: editData?.relyingPartyId ?? "",
    relyingPartyName: editData?.relyingPartyName ?? "",
    credentialId: editData?.credentialId ?? "",
    creationDate: editData?.creationDate ?? "",
    deviceInfo: editData?.deviceInfo ?? "",
    orgFolderId: editData?.orgFolderId ?? null,
  };
}
