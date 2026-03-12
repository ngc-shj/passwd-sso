import { z } from "zod";
import { SUPPORTED_WRAP_VERSIONS } from "@/lib/crypto-emergency";
import { TEAM_INVITE_ROLE_VALUES, TEAM_ROLE, TEAM_ROLE_VALUES, TENANT_ROLE_VALUES, ENTRY_TYPE, ENTRY_TYPE_VALUES, CUSTOM_FIELD_TYPE_VALUES, SHARE_PERMISSION_VALUES } from "@/lib/constants";
import { API_KEY_SCOPES, MAX_API_KEY_EXPIRY_DAYS } from "@/lib/constants/api-key";

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

const asciiPrintable = /^[\x20-\x7E]*$/;

export const generatePasswordSchema = z.object({
  length: z.number().int().min(PASSWORD_LENGTH_MIN).max(PASSWORD_LENGTH_MAX).default(16),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
  excludeAmbiguous: z.boolean().default(false),
  includeChars: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
  excludeChars: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
});

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

// ─── E2E Encrypted Entry Schemas ─────────────────────────────

const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(500_000), // 500KB limit per ciphertext
  iv: z.string().length(24), // 12 bytes hex
  authTag: z.string().length(32), // 16 bytes hex
});

export const entryTypeSchema = z.enum(ENTRY_TYPE_VALUES);

export const createE2EPasswordSchema = z.object({
  id: z.string().uuid().optional(), // client-generated UUIDv4 (required for aadVersion >= 1)
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  keyVersion: z.number().int().min(1),
  aadVersion: z.number().int().min(0).max(1).optional().default(1),
  tagIds: z.array(z.string().cuid()).optional(),
  folderId: z.string().cuid().optional().nullable(),
  isFavorite: z.boolean().optional(),
  entryType: entryTypeSchema.optional().default(ENTRY_TYPE.LOGIN),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
}).refine(
  (d) => (d.aadVersion ?? 0) < 1 || !!d.id,
  { message: "id is required when aadVersion >= 1", path: ["id"] }
);

export const updateE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema.optional(),
  encryptedOverview: encryptedFieldSchema.optional(),
  keyVersion: z.number().int().min(1).optional(),
  aadVersion: z.number().int().min(0).max(1).optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  folderId: z.string().cuid().optional().nullable(),
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  entryType: entryTypeSchema.optional(),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
});

// ─── Folder Schemas ─────────────────────────────────────────

export const createFolderSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH).trim(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH).trim().optional(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

// ─── Tag Schemas ────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null().transform(() => undefined)),
  parentId: z.string().cuid().optional().nullable(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .or(z.literal("")),
  parentId: z.string().cuid().optional().nullable(),
});

export const generatePassphraseSchema = z.object({
  wordCount: z.number().int().min(PASSPHRASE_WORD_COUNT_MIN).max(PASSPHRASE_WORD_COUNT_MAX).default(4),
  separator: z.string().max(5).default("-"),
  capitalize: z.boolean().default(true),
  includeNumber: z.boolean().default(false),
});

// ─── Team Schemas ──────────────────────────────────────────

export const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const createTeamSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH).trim(),
  slug: z
    .string()
    .min(SLUG_MIN_LENGTH)
    .max(SLUG_MAX_LENGTH)
    .regex(slugRegex, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).trim().optional(),
});

/** Schema for E2E team creation — includes client-encrypted TeamMemberKey for owner */
export const teamMemberKeySchema = z.object({
  encryptedTeamKey: z.string().min(1).max(1000),
  teamKeyIv: z.string().regex(/^[0-9a-f]{24}$/),
  teamKeyAuthTag: z.string().regex(/^[0-9a-f]{32}$/),
  ephemeralPublicKey: z.string().min(1).max(500),
  hkdfSalt: z.string().regex(/^[0-9a-f]{64}$/),
  keyVersion: z.number().int().min(1),
  wrapVersion: z.number().int().min(1).max(1).default(1),
});

export const createTeamE2ESchema = createTeamSchema.extend({
  id: z.string().uuid().optional(),
  teamMemberKey: teamMemberKeySchema,
});

/** Schema for E2E team password creation — client sends pre-encrypted blobs */
export const createTeamE2EPasswordSchema = z.object({
  id: z.string().uuid().optional(),
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  aadVersion: z.number().int().min(1),
  teamKeyVersion: z.number().int().min(1),
  itemKeyVersion: z.number().int().min(0).default(0),
  encryptedItemKey: encryptedFieldSchema.optional(),
  entryType: entryTypeSchema.optional().default(ENTRY_TYPE.LOGIN),
  tagIds: z.array(z.string().cuid()).optional(),
  teamFolderId: z.string().cuid().nullable().optional(),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
}).refine(
  (data) => {
    if (data.itemKeyVersion >= 1 && !data.encryptedItemKey) return false;
    if (data.itemKeyVersion === 0 && data.encryptedItemKey) return false;
    return true;
  },
  { message: "encryptedItemKey is required when itemKeyVersion >= 1 and forbidden when 0" }
);

/** Schema for E2E team password update — full blob replacement or metadata-only update */
export const updateTeamE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema.optional(),
  encryptedOverview: encryptedFieldSchema.optional(),
  aadVersion: z.number().int().min(1).optional(),
  teamKeyVersion: z.number().int().min(1).optional(),
  itemKeyVersion: z.number().int().min(0).optional(),
  encryptedItemKey: encryptedFieldSchema.optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  teamFolderId: z.string().cuid().nullable().optional(),
  isArchived: z.boolean().optional(),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
}).refine(
  (data) => {
    const hasBlob = data.encryptedBlob !== undefined;
    const hasOverview = data.encryptedOverview !== undefined;
    const hasAad = data.aadVersion !== undefined;
    const hasKeyVer = data.teamKeyVersion !== undefined;
    const allPresent = hasBlob && hasOverview && hasAad && hasKeyVer;
    const nonePresent = !hasBlob && !hasOverview && !hasAad && !hasKeyVer;
    return allPresent || nonePresent;
  },
  { message: "Encrypted fields must be all present or all absent" },
).refine(
  (data) => {
    // For updates: itemKeyVersion>=1 without encryptedItemKey is valid (reuse existing)
    // encryptedItemKey without itemKeyVersion>=1 is invalid
    if ((data.itemKeyVersion === undefined || data.itemKeyVersion === 0) && data.encryptedItemKey) return false;
    return true;
  },
  { message: "encryptedItemKey is forbidden when itemKeyVersion is 0 or absent" },
);

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH).trim().optional(),
  description: z.string().max(DESCRIPTION_MAX_LENGTH).trim().optional().or(z.literal("")),
});

export const upsertTeamPolicySchema = z.object({
  minPasswordLength: z.number().int().min(POLICY_MIN_PW_LENGTH_MIN).max(POLICY_MIN_PW_LENGTH_MAX).default(0),
  requireUppercase: z.boolean().default(false),
  requireLowercase: z.boolean().default(false),
  requireNumbers: z.boolean().default(false),
  requireSymbols: z.boolean().default(false),
  maxSessionDurationMinutes: z.number().int().min(POLICY_SESSION_DURATION_MIN).max(POLICY_SESSION_DURATION_MAX).nullable().default(null),
  requireRepromptForAll: z.boolean().default(false),
  allowExport: z.boolean().default(true),
  allowSharing: z.boolean().default(true),
  requireSharePassword: z.boolean().default(false),
});

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(TEAM_INVITE_ROLE_VALUES).default(TEAM_ROLE.MEMBER),
});

export const addMemberSchema = z.object({
  userId: z.string().cuid(),
  role: z.enum(TEAM_INVITE_ROLE_VALUES).default(TEAM_ROLE.MEMBER),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(TEAM_ROLE_VALUES),
});

export const updateTenantMemberRoleSchema = z.object({
  role: z.enum(TENANT_ROLE_VALUES),
});

export const createTeamTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .or(z.literal("")),
  parentId: z.string().cuid().optional().nullable(),
});

export const updateTeamTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .or(z.literal("")),
  parentId: z.string().cuid().optional().nullable(),
});

// ─── Send Schemas ─────────────────────────────────────────

export const SEND_MAX_TEXT_LENGTH = 50_000;
export const SEND_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const SEND_MAX_ACTIVE_TOTAL_BYTES = 100 * 1024 * 1024; // ユーザーごと合計 100MB

/**
 * Safe filename pattern: alphanumeric, CJK, Hangul, minimal punctuation.
 * Allows: letters, digits, underscore, CJK, Hangul, half/fullwidth spaces, dots,
 *         hyphens, parentheses (browser duplicate downloads), apostrophes (possessives).
 * Rejects: path separators (/\), CRLF, null bytes, control characters (tab, BOM, etc.),
 *          emoji, and most special characters (#, &, <, >, |, etc.).
 * Note: Uses explicit space chars instead of \s to exclude \t, \v, \f, \uFEFF.
 */
const SAFE_FILENAME_RE = /^[\w\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF .\-()']+$/;

/** Windows reserved device names (case-insensitive) */
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Validate a filename for Send. Returns true if the filename is safe.
 */
export function isValidSendFilename(name: string): boolean {
  if (!name || name.length === 0) return false;
  // No leading/trailing whitespace or whitespace-only names
  if (name !== name.trim()) return false;
  // UTF-8 byte length ≤ 255
  if (new TextEncoder().encode(name).length > 255) return false;
  // No leading/trailing dots
  if (name.startsWith(".") || name.endsWith(".")) return false;
  // No path separators, null bytes, or CRLF
  if (/[/\\\r\n]/.test(name) || name.includes("\0")) return false;
  // No Windows reserved names
  if (WINDOWS_RESERVED_RE.test(name)) return false;
  // Must match safe character set
  if (!SAFE_FILENAME_RE.test(name)) return false;
  return true;
}

export const createSendTextSchema = z.object({
  name: z.string().min(1).max(SEND_NAME_MAX_LENGTH).trim(),
  text: z.string().min(1).max(SEND_MAX_TEXT_LENGTH),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  requirePassword: z.boolean().optional(),
});

export const createSendFileMetaSchema = z.object({
  name: z.string().min(1).max(SEND_NAME_MAX_LENGTH).trim(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.coerce.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  requirePassword: z.string().transform((v) => v === "true").optional(),
});

// ─── Share Link Schemas ───────────────────────────────────

const shareDataSchema = z.object({
  title: z.string().min(1).max(ENTRY_NAME_MAX),
  username: z.string().max(ENTRY_NAME_MAX).nullish(),
  password: z.string().nullish(),
  url: z.string().max(ENTRY_URL_MAX).nullish(),
  notes: z.string().max(ENTRY_NOTES_MAX).nullish(),
  customFields: z.array(z.object({
    label: z.string().max(NAME_MAX_LENGTH),
    value: z.string().max(ENTRY_NOTES_MAX),
    type: z.enum(CUSTOM_FIELD_TYPE_VALUES),
  })).nullish(),
  // SECURE_NOTE
  content: z.string().max(SECURE_NOTE_MAX).nullish(),
  // CREDIT_CARD
  cardholderName: z.string().max(ENTRY_NAME_MAX).nullish(),
  cardNumber: z.string().max(CARD_NUMBER_MAX).nullish(),
  brand: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expiryMonth: z.string().max(2).nullish(),
  expiryYear: z.string().max(4).nullish(),
  cvv: z.string().max(10).nullish(),
  // PASSKEY
  relyingPartyId: z.string().max(ENTRY_NAME_MAX).nullish(),
  relyingPartyName: z.string().max(ENTRY_NAME_MAX).nullish(),
  credentialId: z.string().max(ENTRY_SECRET_MAX).nullish(),
  creationDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  deviceInfo: z.string().max(ENTRY_NAME_MAX).nullish(),
  // IDENTITY
  fullName: z.string().max(ENTRY_NAME_MAX).nullish(),
  address: z.string().max(ENTRY_SECRET_MAX).nullish(),
  phone: z.string().max(ENTRY_SHORT_MAX).nullish(),
  email: z.string().max(ENTRY_NAME_MAX).nullish(),
  dateOfBirth: z.string().max(ENTRY_SHORT_MAX).nullish(),
  nationality: z.string().max(NAME_MAX_LENGTH).nullish(),
  idNumber: z.string().max(NAME_MAX_LENGTH).nullish(),
  issueDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expiryDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  // BANK_ACCOUNT
  bankName: z.string().max(ENTRY_NAME_MAX).nullish(),
  accountType: z.string().max(ENTRY_SHORT_MAX).nullish(),
  accountHolderName: z.string().max(ENTRY_NAME_MAX).nullish(),
  accountNumber: z.string().max(ENTRY_SHORT_MAX).nullish(),
  routingNumber: z.string().max(ENTRY_SHORT_MAX).nullish(),
  swiftBic: z.string().max(SWIFT_BIC_MAX).nullish(),
  iban: z.string().max(ENTRY_SHORT_MAX).nullish(),
  branchName: z.string().max(ENTRY_NAME_MAX).nullish(),
  // SOFTWARE_LICENSE
  softwareName: z.string().max(ENTRY_NAME_MAX).nullish(),
  licenseKey: z.string().max(ENTRY_SECRET_MAX).nullish(),
  version: z.string().max(ENTRY_SHORT_MAX).nullish(),
  licensee: z.string().max(ENTRY_NAME_MAX).nullish(),
  purchaseDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  expirationDate: z.string().max(ENTRY_SHORT_MAX).nullish(),
  // SSH_KEY
  privateKey: z.string().max(ENTRY_NOTES_MAX).nullish(),
  publicKey: z.string().max(PUBLIC_KEY_MAX).nullish(),
  keyType: z.string().max(ENTRY_SHORT_MAX).nullish(),
  keySize: z.number().int().nullish(),
  fingerprint: z.string().max(ENTRY_NAME_MAX).nullish(),
  passphrase: z.string().max(ENTRY_SECRET_MAX).nullish(),
  comment: z.string().max(ENTRY_SECRET_MAX).nullish(),
});

export const createShareLinkSchema = z.object({
  passwordEntryId: z.string().min(1).optional(),
  teamPasswordEntryId: z.string().min(1).optional(),
  data: shareDataSchema.optional(),
  encryptedShareData: encryptedFieldSchema.optional(),
  entryType: entryTypeSchema.optional(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(MAX_VIEWS_MIN).max(MAX_VIEWS_MAX).optional(),
  permissions: z.array(z.enum(SHARE_PERMISSION_VALUES)).optional(),
  requirePassword: z.boolean().optional(),
}).refine(
  (d) => (d.passwordEntryId ? !d.teamPasswordEntryId : !!d.teamPasswordEntryId),
  { message: "Exactly one of passwordEntryId or teamPasswordEntryId is required" }
).refine(
  (d) => (d.passwordEntryId ? !!d.data : true),
  { message: "data is required for personal entries" }
).refine(
  (d) => (d.teamPasswordEntryId ? !!d.encryptedShareData && !!d.entryType : true),
  { message: "encryptedShareData and entryType are required for team entries" }
).refine(
  (d) => (d.teamPasswordEntryId ? !d.data : true),
  { message: "data must not be present for team entries (use encryptedShareData)" }
);

// ─── Share Access Password Schemas ────────────────────────

export const verifyShareAccessSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  password: z.string().min(1).max(43),
});

// ─── Emergency Access Schemas ─────────────────────────────

export const createEmergencyGrantSchema = z.object({
  granteeEmail: z.string().email(),
  waitDays: z.number().int().refine((n) => [7, 14, 30].includes(n), {
    message: "waitDays must be 7, 14, or 30",
  }),
});

export const acceptEmergencyGrantSchema = z.object({
  token: z.string().min(1),
  granteePublicKey: z.string().min(1),
  encryptedPrivateKey: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

export const rejectEmergencyGrantSchema = z.object({
  token: z.string().min(1),
});

export const confirmEmergencyGrantSchema = z.object({
  ownerEphemeralPublicKey: z.string().min(1),
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().length(24),
  secretKeyAuthTag: z.string().length(32),
  hkdfSalt: z.string().length(64),
  wrapVersion: z.number().int().refine(
    (v) => SUPPORTED_WRAP_VERSIONS.has(v),
    { message: `wrapVersion must be one of: ${[...SUPPORTED_WRAP_VERSIONS].join(", ")}` }
  ),
  keyVersion: z.number().int().min(1).optional(), // Server uses owner's DB value
});

export const acceptEmergencyGrantByIdSchema = z.object({
  granteePublicKey: z.string().min(1),
  encryptedPrivateKey: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

export const revokeEmergencyGrantSchema = z.object({
  permanent: z.boolean().default(true),
});

// ─── API Key ──────────────────────────────────────────────

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  scope: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.coerce.date().refine(
    (d) => {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + MAX_API_KEY_EXPIRY_DAYS);
      return d.getTime() > Date.now() && d.getTime() <= maxDate.getTime();
    },
    { message: `Expiry must be in the future and within ${MAX_API_KEY_EXPIRY_DAYS} days` },
  ),
});

// ─── Type Exports ──────────────────────────────────────────

export type GeneratePasswordInput = z.infer<typeof generatePasswordSchema>;
export type GeneratePassphraseInput = z.infer<typeof generatePassphraseSchema>;
export type CreateE2EPasswordInput = z.infer<typeof createE2EPasswordSchema>;
export type UpdateE2EPasswordInput = z.infer<typeof updateE2EPasswordSchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type CreateTeamE2EInput = z.infer<typeof createTeamE2ESchema>;
export type TeamMemberKeyInput = z.infer<typeof teamMemberKeySchema>;
export type CreateTeamE2EPasswordInput = z.infer<typeof createTeamE2EPasswordSchema>;
export type UpdateTeamE2EPasswordInput = z.infer<typeof updateTeamE2EPasswordSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type UpdateTenantMemberRoleInput = z.infer<typeof updateTenantMemberRoleSchema>;
export type CreateTeamTagInput = z.infer<typeof createTeamTagSchema>;
export type CreateSendTextInput = z.infer<typeof createSendTextSchema>;
export type CreateSendFileMetaInput = z.infer<typeof createSendFileMetaSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type VerifyShareAccessInput = z.infer<typeof verifyShareAccessSchema>;
export type CreateEmergencyGrantInput = z.infer<typeof createEmergencyGrantSchema>;
export type AcceptEmergencyGrantInput = z.infer<typeof acceptEmergencyGrantSchema>;
export type ConfirmEmergencyGrantInput = z.infer<typeof confirmEmergencyGrantSchema>;
export type RevokeEmergencyGrantInput = z.infer<typeof revokeEmergencyGrantSchema>;
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
