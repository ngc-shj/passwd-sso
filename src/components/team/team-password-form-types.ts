import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";

export type TeamEntryKind =
  | "password"
  | "secureNote"
  | "creditCard"
  | "identity"
  | "passkey"
  | "bankAccount"
  | "softwareLicense";

export interface TeamFolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

export interface TeamPasswordFormEditData {
  id: string;
  entryType?: EntryTypeValue;
  title: string;
  username: string | null;
  password: string;
  content?: string;
  url: string | null;
  notes: string | null;
  tags?: TeamTagData[];
  customFields?: EntryCustomField[];
  totp?: EntryTotp | null;
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  bankName?: string | null;
  accountType?: string | null;
  accountHolderName?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  branchName?: string | null;
  softwareName?: string | null;
  licenseKey?: string | null;
  version?: string | null;
  licensee?: string | null;
  purchaseDate?: string | null;
  expirationDate?: string | null;
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  expiresAt?: string | null;
}

export interface TeamPasswordFormProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  entryType?: EntryTypeValue;
  editData?: TeamPasswordFormEditData | null;
}
