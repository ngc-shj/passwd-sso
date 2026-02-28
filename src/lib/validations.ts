import { z } from "zod";
import { SUPPORTED_WRAP_VERSIONS } from "@/lib/crypto-emergency";
import { TEAM_INVITE_ROLE_VALUES, TEAM_ROLE, TEAM_ROLE_VALUES, ENTRY_TYPE, ENTRY_TYPE_VALUES, CUSTOM_FIELD_TYPE_VALUES } from "@/lib/constants";

export const generatePasswordSchema = z.object({
  length: z.number().int().min(8).max(128).default(16),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.string().default(""),
  excludeAmbiguous: z.boolean().default(false),
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
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  parentId: z.string().cuid().optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

// ─── Tag Schemas ────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null().transform(() => undefined)),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(50).trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .or(z.literal("")),
});

export const generatePassphraseSchema = z.object({
  wordCount: z.number().int().min(3).max(10).default(4),
  separator: z.string().max(5).default("-"),
  capitalize: z.boolean().default(true),
  includeNumber: z.boolean().default(false),
});

// ─── Team Schemas ──────────────────────────────────────────

const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const createTeamSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(slugRegex, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).trim().optional(),
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
  entryType: entryTypeSchema.optional().default(ENTRY_TYPE.LOGIN),
  tagIds: z.array(z.string().cuid()).optional(),
  teamFolderId: z.string().cuid().nullable().optional(),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
});

/** Schema for E2E team password update — full blob replacement or metadata-only update */
export const updateTeamE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema.optional(),
  encryptedOverview: encryptedFieldSchema.optional(),
  aadVersion: z.number().int().min(1).optional(),
  teamKeyVersion: z.number().int().min(1).optional(),
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
);

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).trim().optional().or(z.literal("")),
});

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(TEAM_INVITE_ROLE_VALUES).default(TEAM_ROLE.MEMBER),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(TEAM_ROLE_VALUES),
});

export const createTeamTagSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .or(z.literal("")),
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
  name: z.string().min(1).max(200).trim(),
  text: z.string().min(1).max(SEND_MAX_TEXT_LENGTH),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(1).max(100).optional(),
});

export const createSendFileMetaSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.coerce.number().int().min(1).max(100).optional(),
});

// ─── Share Link Schemas ───────────────────────────────────

const shareDataSchema = z.object({
  title: z.string().min(1).max(200),
  username: z.string().max(200).nullish(),
  password: z.string().nullish(),
  url: z.string().max(2000).nullish(),
  notes: z.string().max(10000).nullish(),
  customFields: z.array(z.object({
    label: z.string().max(100),
    value: z.string().max(10000),
    type: z.enum(CUSTOM_FIELD_TYPE_VALUES),
  })).nullish(),
  // SECURE_NOTE
  content: z.string().max(50000).nullish(),
  // CREDIT_CARD
  cardholderName: z.string().max(200).nullish(),
  cardNumber: z.string().max(30).nullish(),
  brand: z.string().max(50).nullish(),
  expiryMonth: z.string().max(2).nullish(),
  expiryYear: z.string().max(4).nullish(),
  cvv: z.string().max(10).nullish(),
  // PASSKEY
  relyingPartyId: z.string().max(200).nullish(),
  relyingPartyName: z.string().max(200).nullish(),
  credentialId: z.string().max(500).nullish(),
  creationDate: z.string().max(50).nullish(),
  deviceInfo: z.string().max(200).nullish(),
  // IDENTITY
  fullName: z.string().max(200).nullish(),
  address: z.string().max(500).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.string().max(200).nullish(),
  dateOfBirth: z.string().max(50).nullish(),
  nationality: z.string().max(100).nullish(),
  idNumber: z.string().max(100).nullish(),
  issueDate: z.string().max(50).nullish(),
  expiryDate: z.string().max(50).nullish(),
  // BANK_ACCOUNT
  bankName: z.string().max(200).nullish(),
  accountType: z.string().max(50).nullish(),
  accountHolderName: z.string().max(200).nullish(),
  accountNumber: z.string().max(50).nullish(),
  routingNumber: z.string().max(50).nullish(),
  swiftBic: z.string().max(20).nullish(),
  iban: z.string().max(50).nullish(),
  branchName: z.string().max(200).nullish(),
  // SOFTWARE_LICENSE
  softwareName: z.string().max(200).nullish(),
  licenseKey: z.string().max(500).nullish(),
  version: z.string().max(50).nullish(),
  licensee: z.string().max(200).nullish(),
  purchaseDate: z.string().max(50).nullish(),
  expirationDate: z.string().max(50).nullish(),
});

export const createShareLinkSchema = z.object({
  passwordEntryId: z.string().min(1).optional(),
  teamPasswordEntryId: z.string().min(1).optional(),
  data: shareDataSchema.optional(),
  encryptedShareData: encryptedFieldSchema.optional(),
  entryType: entryTypeSchema.optional(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(1).max(100).optional(),
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
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type CreateTeamTagInput = z.infer<typeof createTeamTagSchema>;
export type CreateSendTextInput = z.infer<typeof createSendTextSchema>;
export type CreateSendFileMetaInput = z.infer<typeof createSendFileMetaSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type CreateEmergencyGrantInput = z.infer<typeof createEmergencyGrantSchema>;
export type AcceptEmergencyGrantInput = z.infer<typeof acceptEmergencyGrantSchema>;
export type ConfirmEmergencyGrantInput = z.infer<typeof confirmEmergencyGrantSchema>;
export type RevokeEmergencyGrantInput = z.infer<typeof revokeEmergencyGrantSchema>;
