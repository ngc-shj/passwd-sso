import { z } from "zod";
import {
  getCardNumberValidation,
  getMinLength,
  normalizeCardNumber,
} from "@/lib/credit-card";
import { SUPPORTED_WRAP_VERSIONS } from "@/lib/crypto-emergency";
import { INVITE_ROLE_VALUES, ORG_ROLE, ORG_ROLE_VALUES, ENTRY_TYPE, ENTRY_TYPE_VALUES, TOTP_ALGORITHM_VALUES, CUSTOM_FIELD_TYPE_VALUES } from "@/lib/constants";

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
  ciphertext: z.string().min(1),
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

// ─── Organization Schemas ──────────────────────────────────

const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(slugRegex, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).trim().optional(),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).trim().optional().or(z.literal("")),
});

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(INVITE_ROLE_VALUES).default(ORG_ROLE.MEMBER),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORG_ROLE_VALUES),
});

export const customFieldSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().max(10000),
  type: z.enum(CUSTOM_FIELD_TYPE_VALUES),
});

export const totpSchema = z.object({
  secret: z.string().min(1),
  algorithm: z.enum(TOTP_ALGORITHM_VALUES).optional(),
  digits: z.number().int().min(6).max(8).optional(),
  period: z.number().int().min(15).max(60).optional(),
});

export const createOrgPasswordSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  username: z.string().max(200).optional().or(z.literal("")),
  password: z.string().min(1),
  url: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  customFields: z.array(customFieldSchema).optional(),
  totp: totpSchema.optional().nullable(),
});

export const updateOrgPasswordSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  username: z.string().max(200).optional().or(z.literal("")),
  password: z.string().min(1).optional(),
  url: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  customFields: z.array(customFieldSchema).optional(),
  totp: totpSchema.optional().nullable(),
  isArchived: z.boolean().optional(),
});

export const createOrgSecureNoteSchema = z.object({
  entryType: z.literal(ENTRY_TYPE.SECURE_NOTE),
  title: z.string().min(1).max(200).trim(),
  content: z.string().max(50000),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
});

export const updateOrgSecureNoteSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  content: z.string().max(50000).optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  isArchived: z.boolean().optional(),
});

export const createOrgCreditCardSchema = z.object({
  entryType: z.literal(ENTRY_TYPE.CREDIT_CARD),
  title: z.string().min(1).max(200).trim(),
  cardholderName: z.string().max(200).optional().or(z.literal("")),
  cardNumber: z.string().max(30).optional().or(z.literal("")),
  brand: z.string().max(50).optional().or(z.literal("")),
  expiryMonth: z.string().max(2).optional().or(z.literal("")),
  expiryYear: z.string().max(4).optional().or(z.literal("")),
  cvv: z.string().max(10).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
}).superRefine((data, ctx) => {
  if (!data.cardNumber) return;

  if (/[^\d\s]/.test(data.cardNumber)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number must contain only digits",
    });
    return;
  }

  const digits = normalizeCardNumber(data.cardNumber);
  if (!digits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number must contain digits",
    });
    return;
  }

  const { lengthValid, luhnValid } = getCardNumberValidation(digits, data.brand);
  if (!lengthValid) {
    const minLength = getMinLength(data.brand);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: `Card number must be at least ${minLength} digits and match brand length`,
    });
    return;
  }

  if (!luhnValid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number failed checksum validation",
    });
  }
});

export const updateOrgCreditCardSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  cardholderName: z.string().max(200).optional().or(z.literal("")),
  cardNumber: z.string().max(30).optional().or(z.literal("")),
  brand: z.string().max(50).optional().or(z.literal("")),
  expiryMonth: z.string().max(2).optional().or(z.literal("")),
  expiryYear: z.string().max(4).optional().or(z.literal("")),
  cvv: z.string().max(10).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  isArchived: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (!data.cardNumber) return;

  if (/[^\d\s]/.test(data.cardNumber)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number must contain only digits",
    });
    return;
  }

  const digits = normalizeCardNumber(data.cardNumber);
  if (!digits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number must contain digits",
    });
    return;
  }

  const { lengthValid, luhnValid } = getCardNumberValidation(digits, data.brand);
  if (!lengthValid) {
    const minLength = getMinLength(data.brand);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: `Card number must be at least ${minLength} digits and match brand length`,
    });
    return;
  }

  if (!luhnValid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cardNumber"],
      message: "Card number failed checksum validation",
    });
  }
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal(""));
const phoneSchema = z.string().max(50).regex(/^[0-9+\-\s()]*$/).optional().or(z.literal(""));

export const createOrgIdentitySchema = z.object({
  entryType: z.literal(ENTRY_TYPE.IDENTITY),
  title: z.string().min(1).max(200).trim(),
  fullName: z.string().max(200).optional().or(z.literal("")),
  address: z.string().max(500).optional().or(z.literal("")),
  phone: phoneSchema,
  email: z.string().email().max(200).optional().or(z.literal("")),
  dateOfBirth: dateSchema,
  nationality: z.string().max(100).optional().or(z.literal("")),
  idNumber: z.string().max(100).optional().or(z.literal("")),
  issueDate: dateSchema,
  expiryDate: dateSchema,
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.dateOfBirth) {
    const today = new Date().toISOString().slice(0, 10);
    if (data.dateOfBirth > today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Date of birth must be in the past",
      });
    }
  }
  if (data.issueDate && data.expiryDate && data.issueDate >= data.expiryDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiryDate"],
      message: "Expiry date must be after issue date",
    });
  }
});

export const updateOrgIdentitySchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  fullName: z.string().max(200).optional().or(z.literal("")),
  address: z.string().max(500).optional().or(z.literal("")),
  phone: phoneSchema,
  email: z.string().email().max(200).optional().or(z.literal("")),
  dateOfBirth: dateSchema,
  nationality: z.string().max(100).optional().or(z.literal("")),
  idNumber: z.string().max(100).optional().or(z.literal("")),
  issueDate: dateSchema,
  expiryDate: dateSchema,
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  isArchived: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.dateOfBirth) {
    const today = new Date().toISOString().slice(0, 10);
    if (data.dateOfBirth > today) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Date of birth must be in the past",
      });
    }
  }
  if (data.issueDate && data.expiryDate && data.issueDate >= data.expiryDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiryDate"],
      message: "Expiry date must be after issue date",
    });
  }
});

export const createOrgPasskeySchema = z.object({
  entryType: z.literal(ENTRY_TYPE.PASSKEY),
  title: z.string().min(1).max(200).trim(),
  relyingPartyId: z.string().min(1).max(200).trim(),
  relyingPartyName: z.string().max(200).optional().or(z.literal("")),
  username: z.string().max(200).optional().or(z.literal("")),
  credentialId: z.string().max(500).optional().or(z.literal("")),
  creationDate: z.string().optional().or(z.literal("")),
  deviceInfo: z.string().max(200).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
});

export const updateOrgPasskeySchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  relyingPartyId: z.string().min(1).max(200).trim().optional(),
  relyingPartyName: z.string().max(200).optional().or(z.literal("")),
  username: z.string().max(200).optional().or(z.literal("")),
  credentialId: z.string().max(500).optional().or(z.literal("")),
  creationDate: z.string().optional().or(z.literal("")),
  deviceInfo: z.string().max(200).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  orgFolderId: z.string().cuid().optional().nullable(),
  isArchived: z.boolean().optional(),
});

export const createOrgTagSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal("")),
});

// ─── Send Schemas ─────────────────────────────────────────

export const SEND_MAX_TEXT_LENGTH = 50_000;
export const SEND_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const SEND_MAX_ACTIVE_TOTAL_BYTES = 100 * 1024 * 1024; // ユーザーごと合計 100MB

/**
 * Safe filename pattern: alphanumeric, CJK, Hangul, hyphens, underscores, dots, spaces.
 * Rejects path separators, CRLF, null bytes, control characters, and emoji.
 */
const SAFE_FILENAME_RE = /^[\w\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\s.\-]+$/;

/** Windows reserved device names (case-insensitive) */
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Validate a filename for Send. Returns true if the filename is safe.
 */
export function isValidSendFilename(name: string): boolean {
  if (!name || name.length === 0) return false;
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
  creationDate: z.string().nullish(),
  deviceInfo: z.string().max(200).nullish(),
  // IDENTITY
  fullName: z.string().max(200).nullish(),
  address: z.string().max(500).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.string().max(200).nullish(),
  dateOfBirth: z.string().nullish(),
  nationality: z.string().max(100).nullish(),
  idNumber: z.string().max(100).nullish(),
  issueDate: z.string().nullish(),
  expiryDate: z.string().nullish(),
});

export const createShareLinkSchema = z.object({
  passwordEntryId: z.string().min(1).optional(),
  orgPasswordEntryId: z.string().min(1).optional(),
  data: shareDataSchema.optional(),
  expiresIn: z.enum(["1h", "1d", "7d", "30d"]),
  maxViews: z.number().int().min(1).max(100).optional(),
}).refine(
  (d) => (d.passwordEntryId ? !d.orgPasswordEntryId : !!d.orgPasswordEntryId),
  { message: "Exactly one of passwordEntryId or orgPasswordEntryId is required" }
).refine(
  (d) => (d.passwordEntryId ? !!d.data : true),
  { message: "data is required for personal entries" }
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
export type CreateOrgInput = z.infer<typeof createOrgSchema>;
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type CreateOrgPasswordInput = z.infer<typeof createOrgPasswordSchema>;
export type UpdateOrgPasswordInput = z.infer<typeof updateOrgPasswordSchema>;
export type CreateOrgSecureNoteInput = z.infer<typeof createOrgSecureNoteSchema>;
export type UpdateOrgSecureNoteInput = z.infer<typeof updateOrgSecureNoteSchema>;
export type CreateOrgCreditCardInput = z.infer<typeof createOrgCreditCardSchema>;
export type UpdateOrgCreditCardInput = z.infer<typeof updateOrgCreditCardSchema>;
export type CreateOrgIdentityInput = z.infer<typeof createOrgIdentitySchema>;
export type UpdateOrgIdentityInput = z.infer<typeof updateOrgIdentitySchema>;
export type CreateOrgPasskeyInput = z.infer<typeof createOrgPasskeySchema>;
export type UpdateOrgPasskeyInput = z.infer<typeof updateOrgPasskeySchema>;
export type CreateOrgTagInput = z.infer<typeof createOrgTagSchema>;
export type CreateSendTextInput = z.infer<typeof createSendTextSchema>;
export type CreateSendFileMetaInput = z.infer<typeof createSendFileMetaSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type CreateEmergencyGrantInput = z.infer<typeof createEmergencyGrantSchema>;
export type AcceptEmergencyGrantInput = z.infer<typeof acceptEmergencyGrantSchema>;
export type ConfirmEmergencyGrantInput = z.infer<typeof confirmEmergencyGrantSchema>;
export type RevokeEmergencyGrantInput = z.infer<typeof revokeEmergencyGrantSchema>;
