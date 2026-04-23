/**
 * Canonical entry type definitions for client-side (decrypted) entry data.
 * All fields here live inside encrypted blobs — no API contract or DB migration needed.
 */

import type { EntryTypeValue } from "@/lib/constants";
import type {
  EntryCustomField,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotp,
} from "@/lib/vault/entry-form-types";
import type { TOTPEntry } from "@/components/passwords/totp-field";

/**
 * Detail view data for a single entry (after decryption).
 * Used by PasswordDetailInline and its section components.
 */
export interface InlineDetailData {
  id: string;
  title?: string;
  entryType?: EntryTypeValue;
  requireReprompt?: boolean;
  password: string;
  content?: string;
  isMarkdown?: boolean;
  url: string | null;
  urlHost: string | null;
  notes: string | null;
  customFields: EntryCustomField[];
  passwordHistory: EntryPasswordHistory[];
  totp?: TOTPEntry;
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
  username?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  passkeyPublicKeyCose?: string | null;
  passkeyUserHandle?: string | null;
  passkeyUserDisplayName?: string | null;
  passkeySignCount?: number | null;
  passkeyAlgorithm?: number | null;
  passkeyTransports?: string[] | null;
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
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
  keySize?: number | null;
  fingerprint?: string | null;
  sshPassphrase?: string | null;
  sshComment?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Full decrypted entry data.
 * This is the superset of all entry fields stored inside the encrypted blob.
 * Field names here are canonical; other types (InlineDetailData, ExportEntry) derive from these.
 */
export interface FullEntryData {
  entryType?: EntryTypeValue;
  title: string;
  username?: string | null;
  password?: string;
  url?: string | null;
  notes?: string | null;
  content?: string;
  isMarkdown?: boolean;
  tags: EntryTagNameColor[];
  customFields?: EntryCustomField[];
  passwordHistory?: EntryPasswordHistory[];
  totp?: EntryTotp;
  // Credit card
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  // Identity
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  // Passkey
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  // Passkey provider (private key material — lives inside encryptedBlob only)
  passkeyPrivateKeyJwk?: string | null;
  passkeyPublicKeyCose?: string | null;
  passkeyUserHandle?: string | null;
  passkeyUserDisplayName?: string | null;
  passkeySignCount?: number | null;
  passkeyAlgorithm?: number | null;
  passkeyTransports?: string[] | null;
  // Bank account
  bankName?: string | null;
  accountType?: string | null;
  accountHolderName?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftBic?: string | null;
  iban?: string | null;
  branchName?: string | null;
  // Software license
  softwareName?: string | null;
  licenseKey?: string | null;
  version?: string | null;
  licensee?: string | null;
  purchaseDate?: string | null;
  expirationDate?: string | null;
  // SSH key
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
  keySize?: number | null;
  fingerprint?: string | null;
  /** Blob key is "passphrase"; UI display types (InlineDetailData) alias to "sshPassphrase" */
  passphrase?: string | null;
  /** Blob key is "comment"; UI display types (InlineDetailData) alias to "sshComment" */
  comment?: string | null;
}
