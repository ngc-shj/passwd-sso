import type { EntryTypeValue } from "@/lib/constants";
import type { EntryTagNameColor } from "@/lib/vault/entry-form-types";

/**
 * Decrypted personal vault entry shape for the list view.
 * Fields map to the encrypted OVERVIEW blob + server metadata.
 *
 * Exported as a shared type so both password-list.tsx (re-export for consumers)
 * and personal-vault-list-adapter.ts (adapter return type) can reference it
 * without a circular import.
 */
export interface DisplayEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  relyingPartyId: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  softwareName: string | null;
  licensee: string | null;
  keyType: string | null;
  fingerprint: string | null;
  tags: EntryTagNameColor[];
  isFavorite: boolean;
  isArchived: boolean;
  requireReprompt: boolean;
  travelSafe: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only for trash entries (INV-C5.1). */
  deletedAt?: string;
}
