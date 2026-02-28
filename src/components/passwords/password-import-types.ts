import type { EntryTypeValue } from "@/lib/constants";
import type { useTranslations } from "next-intl";
import type {
  EntryCustomFieldPortable,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotpPortable,
} from "@/lib/entry-form-types";

export type ImportTranslator = ReturnType<typeof useTranslations<"Import">>;

export interface ParsedEntry {
  entryType: EntryTypeValue;
  title: string;
  username: string;
  password: string;
  content: string;
  url: string;
  notes: string;
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
  tags: EntryTagNameColor[];
  customFields: EntryCustomFieldPortable[];
  totp: EntryTotpPortable | null;
  generatorSettings: Record<string, unknown> | null;
  passwordHistory: EntryPasswordHistory[];
  requireReprompt: boolean;
}

export type CsvFormat = "bitwarden" | "onepassword" | "chrome" | "passwd-sso" | "unknown";
