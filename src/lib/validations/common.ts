import { z } from "zod";

// ─── Validation Constants (single source of truth) ──────────
// Used by both Zod schemas (server) and UI components (client).

// ─── Crypto Hex Field Lengths ────────────────────────────────
export const HEX_IV_LENGTH = 24;           // 12 bytes as hex
export const HEX_AUTH_TAG_LENGTH = 32;     // 16 bytes as hex
export const HEX_SALT_LENGTH = 64;         // 32 bytes as hex
export const HEX_HASH_LENGTH = 64;         // 32 bytes as hex (SHA-256)

// ─── Shared Regex Patterns ───────────────────────────────────
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// ─── Shared Enum Values ──────────────────────────────────────
export const EXPIRY_PERIODS = ["1h", "1d", "7d", "30d"] as const;
export const DIRECTORY_SYNC_PROVIDERS = ["AZURE_AD", "GOOGLE_WORKSPACE", "OKTA"] as const;

// ─── Password Generator Defaults ────────────────────────────
export const PASSWORD_LENGTH_DEFAULT = 16;
export const PASSPHRASE_WORD_COUNT_DEFAULT = 4;
export const PASSPHRASE_SEPARATOR_DEFAULT = "-";
export const PASSPHRASE_SEPARATOR_MAX = 5;

// ─── Emergency Access ────────────────────────────────────────
export const EMERGENCY_WAIT_DAYS = [7, 14, 30] as const;

// ─── Team Member Key ─────────────────────────────────────────
export const ENCRYPTED_TEAM_KEY_MAX = 1000;
export const EPHEMERAL_PUBLIC_KEY_MAX = 500;

// ─── Webhook ─────────────────────────────────────────────────
export const MAX_WEBHOOKS = 5;
export const WEBHOOK_URL_MAX_LENGTH = 2048;

// ─── Directory Sync ──────────────────────────────────────────
export const SYNC_INTERVAL_MIN = 15;
export const SYNC_INTERVAL_MAX = 1440;
export const SYNC_INTERVAL_DEFAULT = 60;

// ─── WebAuthn ────────────────────────────────────────────────
export const WEBAUTHN_NICKNAME_MAX_LENGTH = 100;
export const PRF_ENCRYPTED_KEY_MAX_LENGTH = 10_000;

// ─── SCIM ────────────────────────────────────────────────────
export const SCIM_TOKEN_EXPIRY_MIN_DAYS = 1;
export const SCIM_TOKEN_EXPIRY_MAX_DAYS = 3650;
export const SCIM_TOKEN_EXPIRY_DEFAULT_DAYS = 365;

// ─── Team Key Rotation ───────────────────────────────────────
export const TEAM_KEY_VERSION_MIN = 2;
export const TEAM_KEY_VERSION_MAX = 10_000;
export const TEAM_ROTATE_ENTRIES_MAX = 1000;
export const TEAM_ROTATE_MEMBER_KEYS_MIN = 1;
export const TEAM_ROTATE_MEMBER_KEYS_MAX = 1000;

// ─── General Limits ──────────────────────────────────────────
export const EMAIL_MAX_LENGTH = 254;           // RFC 5321
export const FILENAME_MAX_LENGTH = 255;
export const URL_MAX_LENGTH = 2048;
export const SEARCH_QUERY_MAX_LENGTH = 100;
export const CONTENT_TYPE_MAX_LENGTH = 100;

// ─── Ciphertext Limits ───────────────────────────────────────
export const CIPHERTEXT_MAX = 500_000;
export const HISTORY_BLOB_MAX = 1_000_000;     // history reencrypt allows larger blobs

// ─── Bulk Operation ──────────────────────────────────────────
export const MAX_BULK_IDS = 100;

// ─── Share Access ────────────────────────────────────────────
// SHARE_PASSWORD_MAX_ATTEMPTS: Client UX only; server-side rate limit is independent
export const SHARE_PASSWORD_MAX_ATTEMPTS = 5;
export const SHARE_ACCESS_PASSWORD_MAX = 43;

// ─── Breakglass ──────────────────────────────────────────────
export const BREAKGLASS_REASON_MIN = 10;
export const BREAKGLASS_REASON_MAX = 1000;
export const BREAKGLASS_INCIDENT_REF_MAX = 500;

// ─── Tenant Policy CIDR ──────────────────────────────────────
export const MAX_CIDRS = 50;

// ─── SCIM Batch Limits ───────────────────────────────────────
export const SCIM_PATCH_OPERATIONS_MAX = 100;
export const SCIM_GROUP_MEMBERS_MAX = 1000;
export const SCIM_FIELD_MAX_LENGTH = 255;

// ─── Notification ───────────────────────────────────────────
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 2000;

// ─── Entry Snippet ──────────────────────────────────────────
export const ENTRY_SNIPPET_MAX = 100;

// ─── QR / Image ─────────────────────────────────────────────
export const MAX_IMAGE_DIMENSION = 4096;

// ─── Import ─────────────────────────────────────────────────
export const MAX_IMPORT_FOLDERS = 200;

// ─── Tag / Folder Tree ──────────────────────────────────────
export const TAG_TREE_MAX_DEPTH = 3;

// ─── Credit Card ────────────────────────────────────────────
export const CREDIT_CARD_MIN_LENGTH = 12;
export const CREDIT_CARD_MAX_LENGTH = 19;
export const CREDIT_CARD_CVC_MAX_LENGTH = 4;

// ─── UI Display Truncation ──────────────────────────────────
export const DISPLAY_ID_SHORT = 8;
export const DISPLAY_FINGERPRINT_SHORT = 16;
export const DISPLAY_REASON_PREVIEW = 80;
export const DISPLAY_INITIALS_LENGTH = 2;

// ─── API Key ────────────────────────────────────────────────
export const API_KEY_TOKEN_LENGTH = 43;         // base64url encoded
export const API_KEY_PREFIX_LENGTH = 8;         // "api_XXXX"

// ─── HIBP ───────────────────────────────────────────────────
export const HIBP_PREFIX_LENGTH = 5;            // k-anonymity protocol

// ─── Recovery Key ───────────────────────────────────────────
export const RECOVERY_KEY_DATA_LENGTH = 52;     // Base32 data chars (32 bytes)

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
export const PIN_LENGTH_MIN = 4;   // CTAP2 spec minimum
export const PIN_LENGTH_MAX = 63;  // CTAP2 spec maximum
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

// Pre-defined hex schemas for commonly used field lengths.
export const hexIv = hexString(12);       // .length(24) — IV
export const hexAuthTag = hexString(16);  // .length(32) — GCM auth tag
export const hexSalt = hexString(32);     // .length(64) — salt
export const hexHash = hexString(32);     // .length(64) — SHA-256

// ─── WebAuthn PIN Length Schema ──────────────────────────────

export const pinLengthSchema = z.number().int().min(PIN_LENGTH_MIN).max(PIN_LENGTH_MAX);

// ─── Bulk Operation Schemas ─────────────────────────────────

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().min(1))
    .transform(ids => [...new Set(ids)])
    .pipe(z.array(z.string()).min(1).max(MAX_BULK_IDS)),
});

export const bulkArchiveSchema = z.object({
  ids: z.array(z.string().min(1))
    .transform(ids => [...new Set(ids)])
    .pipe(z.array(z.string()).min(1).max(MAX_BULK_IDS)),
  operation: z.enum(["archive", "unarchive"]).default("archive"),
});

// ─── E2E Encrypted Entry Schemas ─────────────────────────────

export const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(CIPHERTEXT_MAX),
  iv: hexIv,
  authTag: hexAuthTag,
});
