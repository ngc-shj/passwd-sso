import type { TeamPasswordFormEditData } from "@/components/team/team-password-form-types";
import { formatCardNumber } from "@/lib/credit-card";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";

export interface TeamPasswordFormInitialValues {
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
  selectedTags: TeamTagData[];
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
  teamFolderId: string | null;
  requireReprompt: boolean;
  expiresAt: string | null;
}

export function buildTeamPasswordFormInitialValues(
  editData?: TeamPasswordFormEditData | null,
): TeamPasswordFormInitialValues {
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
    bankName: editData?.bankName ?? "",
    accountType: editData?.accountType ?? "",
    accountHolderName: editData?.accountHolderName ?? "",
    accountNumber: editData?.accountNumber ?? "",
    routingNumber: editData?.routingNumber ?? "",
    swiftBic: editData?.swiftBic ?? "",
    iban: editData?.iban ?? "",
    branchName: editData?.branchName ?? "",
    softwareName: editData?.softwareName ?? "",
    licenseKey: editData?.licenseKey ?? "",
    version: editData?.version ?? "",
    licensee: editData?.licensee ?? "",
    purchaseDate: editData?.purchaseDate ?? "",
    expirationDate: editData?.expirationDate ?? "",
    teamFolderId: editData?.teamFolderId ?? null,
    requireReprompt: editData?.requireReprompt ?? false,
    expiresAt: editData?.expiresAt ?? null,
  };
}
