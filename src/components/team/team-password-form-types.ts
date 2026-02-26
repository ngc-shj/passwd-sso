import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/team/team-tag-input";

export type OrgEntryKind =
  | "password"
  | "secureNote"
  | "creditCard"
  | "identity"
  | "passkey";

export interface OrgFolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

export type TeamFolderItem = OrgFolderItem;

export interface OrgPasswordFormEditData {
  id: string;
  entryType?: EntryTypeValue;
  title: string;
  username: string | null;
  password: string;
  content?: string;
  url: string | null;
  notes: string | null;
  tags?: OrgTagData[];
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
  orgFolderId?: string | null;
}

export interface OrgPasswordFormProps {
  orgId: string;
  teamId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  entryType?: EntryTypeValue;
  editData?: OrgPasswordFormEditData | null;
}
