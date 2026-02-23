import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { filterNonEmptyCustomFields, parseUrlHost } from "@/lib/entry-form-helpers";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

export interface BuildOrgEntryPayloadInput {
  entryType: EntryTypeValue;
  title: string;
  notes: string;
  tagNames: { name: string; color: string | null }[];

  username?: string;
  password?: string;
  url?: string;
  customFields?: EntryCustomField[];
  totp?: EntryTotp | null;

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

/**
 * Build fullBlob + overviewBlob JSON strings for E2E encryption.
 * The blobs are encrypted client-side before sending to the server.
 */
export function buildOrgEntryPayload(
  input: BuildOrgEntryPayloadInput
): { fullBlob: string; overviewBlob: string } {
  const tags = input.tagNames;
  const title = input.title.trim();
  const notes = input.notes.trim() || null;

  let entryFields: Record<string, unknown>;

  switch (input.entryType) {
    case ENTRY_TYPE.PASSKEY:
      entryFields = {
        relyingPartyId: input.relyingPartyId?.trim() || null,
        relyingPartyName: input.relyingPartyName?.trim() || null,
        username: input.username?.trim() || null,
        credentialId: input.credentialId?.trim() || null,
        creationDate: input.creationDate || null,
        deviceInfo: input.deviceInfo?.trim() || null,
      };
      break;
    case ENTRY_TYPE.IDENTITY:
      entryFields = {
        fullName: input.fullName?.trim() || null,
        address: input.address?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        dateOfBirth: input.dateOfBirth || null,
        nationality: input.nationality?.trim() || null,
        idNumber: input.idNumber?.trim() || null,
        issueDate: input.issueDate || null,
        expiryDate: input.expiryDate || null,
      };
      break;
    case ENTRY_TYPE.CREDIT_CARD:
      entryFields = {
        cardholderName: input.cardholderName?.trim() || null,
        cardNumber: input.cardNumber || null,
        brand: input.brand || null,
        expiryMonth: input.expiryMonth || null,
        expiryYear: input.expiryYear || null,
        cvv: input.cvv || null,
      };
      break;
    case ENTRY_TYPE.SECURE_NOTE:
      entryFields = {
        content: input.content ?? "",
      };
      break;
    case ENTRY_TYPE.LOGIN:
    default: {
      const validFields = filterNonEmptyCustomFields(input.customFields ?? []);
      entryFields = {
        username: input.username?.trim() || null,
        password: input.password ?? "",
        url: input.url?.trim() || null,
        ...(validFields.length > 0 && { customFields: validFields }),
        ...(input.totp && { totp: input.totp }),
      };
      break;
    }
  }

  const fullBlob = JSON.stringify({
    entryType: input.entryType,
    title,
    notes,
    tags,
    ...entryFields,
  });

  // Overview: minimal summary for list rendering
  const urlHost = input.url ? parseUrlHost(input.url) : null;
  const overviewBlob = JSON.stringify({
    title,
    username: input.username?.trim() || null,
    urlHost,
    tags,
  });

  return { fullBlob, overviewBlob };
}
