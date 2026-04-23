import type { EntryTypeValue } from "@/lib/constants";
import type { EntryTagNameColor } from "@/lib/vault/entry-form-types";

/**
 * Display data for PasswordCard — groups the entry-specific
 * display fields that were previously passed as individual props.
 */
export interface EntryCardData {
  id: string;
  entryType?: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  cardholderName?: string | null;
  fullName?: string | null;
  idNumberLast4?: string | null;
  relyingPartyId?: string | null;
  bankName?: string | null;
  accountNumberLast4?: string | null;
  softwareName?: string | null;
  licensee?: string | null;
  keyType?: string | null;
  fingerprint?: string | null;
  tags: EntryTagNameColor[];
  isFavorite: boolean;
  isArchived: boolean;
  requireReprompt?: boolean;
  expiresAt?: string | null;
}
