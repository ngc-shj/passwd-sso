import type { EntryTypeValue } from "@/lib/constants";

/**
 * Decrypted team vault entry shape for the list view (C6).
 *
 * Mirrors the personal DisplayEntry plus team-only metadata (createdBy/updatedBy)
 * carried opaquely through EntryListView for the accordion PasswordCard (INV-C6.1).
 * Satisfies PasswordRowEntry & PasswordDetailPaneEntry so it can drive the shared
 * EntryListView. Extracted from the inline definition in the team page so the
 * adapter and the page share one type.
 */
export interface TeamDisplayEntry {
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
  requireReprompt: boolean;
  expiresAt: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; email: string | null; image: string | null };
  updatedBy: { id: string; name: string | null; email: string | null };
  createdAt: string;
  updatedAt: string;
  /** Present only for trash entries (INV-C1.5). */
  deletedAt?: string;
}
