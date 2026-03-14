import { z } from "zod";

// ─── Validation Constants (single source of truth) ──────────
// Used by both Zod schemas (server) and UI components (client).

export const PASSWORD_LENGTH_MIN = 8;
export const PASSWORD_LENGTH_MAX = 128;
export const PASSPHRASE_WORD_COUNT_MIN = 3;
export const PASSPHRASE_WORD_COUNT_MAX = 10;
export const CHARS_FIELD_MAX = 128;
export const NAME_MAX_LENGTH = 100;
export const TAG_NAME_MAX_LENGTH = 50;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 50;
export const DESCRIPTION_MAX_LENGTH = 500;
export const POLICY_MIN_PW_LENGTH_MIN = 0;
export const POLICY_MIN_PW_LENGTH_MAX = 128;
export const POLICY_SESSION_DURATION_MIN = 5;
export const POLICY_SESSION_DURATION_MAX = 43200;
export const MAX_VIEWS_MIN = 1;
export const MAX_VIEWS_MAX = 100;
export const SEND_NAME_MAX_LENGTH = 200;
export const PASSPHRASE_MIN_LENGTH = 10;
export const TAILNET_NAME_MAX_LENGTH = 63;
export const SCIM_TOKEN_DESC_MAX_LENGTH = 255;

// ─── Entry Field Lengths (shareDataSchema) ──────────────────
export const ENTRY_NAME_MAX = 200;
export const ENTRY_SHORT_MAX = 50;
export const ENTRY_SECRET_MAX = 500;
export const ENTRY_NOTES_MAX = 10000;
export const ENTRY_URL_MAX = 2000;
export const SECURE_NOTE_MAX = 50000;
export const PUBLIC_KEY_MAX = 5000;
export const CARD_NUMBER_MAX = 30;
export const SWIFT_BIC_MAX = 20;

export const asciiPrintable = /^[\x20-\x7E]*$/;

// ─── Attachment Constants ────────────────────────────────────

export const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "txt", "csv"] as const;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS_PER_ENTRY = 20;

export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/csv",
] as const;

// ─── Hex String Validator ────────────────────────────────────

/** Validates a hex string of the given byte length (e.g. 12 bytes = 24 hex chars). */
export const hexString = (bytes: number) =>
  z.string().length(bytes * 2).regex(/^[0-9a-f]+$/i);

// ─── Bulk Operation Schemas ─────────────────────────────────

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().min(1))
    .transform(ids => [...new Set(ids)])
    .pipe(z.array(z.string()).min(1).max(100)),
});

export const bulkArchiveSchema = z.object({
  ids: z.array(z.string().min(1))
    .transform(ids => [...new Set(ids)])
    .pipe(z.array(z.string()).min(1).max(100)),
  operation: z.enum(["archive", "unarchive"]).default("archive"),
});

// ─── E2E Encrypted Entry Schemas ─────────────────────────────

export const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(500_000), // 500KB limit per ciphertext
  iv: z.string().length(24), // 12 bytes hex
  authTag: z.string().length(32), // 16 bytes hex
});
