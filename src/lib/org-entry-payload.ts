import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue, TotpAlgorithm, CustomFieldType } from "@/lib/constants";
import { filterNonEmptyCustomFields } from "@/lib/entry-form-helpers";

interface CustomFieldLike {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface TotpLike {
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
}

export interface BuildOrgEntryPayloadInput {
  entryType: EntryTypeValue;
  title: string;
  notes: string;
  tagIds: string[];
  orgFolderId: string | null;

  username?: string;
  password?: string;
  url?: string;
  customFields?: CustomFieldLike[];
  totp?: TotpLike | null;

  content?: string;

  cardholderName?: string;
  cardNumber?: string;
  brand?: string;
  expiryMonth?: string;
  expiryYear?: string;
  cvv?: string;

  fullName?: string;
  address?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string;
  nationality?: string;
  idNumber?: string;
  issueDate?: string;
  expiryDate?: string;

  relyingPartyId?: string;
  relyingPartyName?: string;
  credentialId?: string;
  creationDate?: string;
  deviceInfo?: string;
}

export function buildOrgEntryPayload(
  input: BuildOrgEntryPayloadInput
): Record<string, unknown> {
  const shared = {
    title: input.title.trim(),
    notes: input.notes.trim() || undefined,
    tagIds: input.tagIds,
    orgFolderId: input.orgFolderId ?? null,
  };

  switch (input.entryType) {
    case ENTRY_TYPE.PASSKEY:
      return {
        entryType: ENTRY_TYPE.PASSKEY,
        ...shared,
        relyingPartyId: input.relyingPartyId?.trim(),
        relyingPartyName: input.relyingPartyName?.trim() || undefined,
        username: input.username?.trim() || undefined,
        credentialId: input.credentialId?.trim() || undefined,
        creationDate: input.creationDate || undefined,
        deviceInfo: input.deviceInfo?.trim() || undefined,
      };
    case ENTRY_TYPE.IDENTITY:
      return {
        entryType: ENTRY_TYPE.IDENTITY,
        ...shared,
        fullName: input.fullName?.trim() || undefined,
        address: input.address?.trim() || undefined,
        phone: input.phone?.trim() || undefined,
        email: input.email?.trim() || undefined,
        dateOfBirth: input.dateOfBirth || undefined,
        nationality: input.nationality?.trim() || undefined,
        idNumber: input.idNumber?.trim() || undefined,
        issueDate: input.issueDate || undefined,
        expiryDate: input.expiryDate || undefined,
      };
    case ENTRY_TYPE.CREDIT_CARD:
      return {
        entryType: ENTRY_TYPE.CREDIT_CARD,
        ...shared,
        cardholderName: input.cardholderName?.trim() || undefined,
        cardNumber: input.cardNumber || undefined,
        brand: input.brand || undefined,
        expiryMonth: input.expiryMonth || undefined,
        expiryYear: input.expiryYear || undefined,
        cvv: input.cvv || undefined,
      };
    case ENTRY_TYPE.SECURE_NOTE:
      return {
        entryType: ENTRY_TYPE.SECURE_NOTE,
        ...shared,
        content: input.content ?? "",
      };
    case ENTRY_TYPE.LOGIN:
    default: {
      const body: Record<string, unknown> = {
        ...shared,
        username: input.username?.trim() || undefined,
        password: input.password ?? "",
        url: input.url?.trim() || undefined,
      };
      const validFields = filterNonEmptyCustomFields(input.customFields ?? []);
      if (validFields.length > 0) body.customFields = validFields;
      body.totp = input.totp ?? null;
      return body;
    }
  }
}

