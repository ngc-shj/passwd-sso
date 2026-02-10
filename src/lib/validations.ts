import { z } from "zod";
import {
  getCardNumberValidation,
  getMinLength,
  normalizeCardNumber,
} from "@/lib/credit-card";

export const generatePasswordSchema = z.object({
  length: z.number().int().min(8).max(128).default(16),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.string().default(""),
  excludeAmbiguous: z.boolean().default(false),
});

// ─── E2E Encrypted Entry Schemas ─────────────────────────────

const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().length(24), // 12 bytes hex
  authTag: z.string().length(32), // 16 bytes hex
});

export const entryTypeSchema = z.enum(["LOGIN", "SECURE_NOTE", "CREDIT_CARD", "IDENTITY", "PASSKEY"]);

export const createE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  keyVersion: z.number().int().min(1),
  tagIds: z.array(z.string().cuid()).optional(),
  entryType: entryTypeSchema.optional().default("LOGIN"),
});

export const updateE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema.optional(),
  encryptedOverview: encryptedFieldSchema.optional(),
  keyVersion: z.number().int().min(1).optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  entryType: entryTypeSchema.optional(),
});

// ─── Tag Schemas ────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal("")),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(50).trim().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
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
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
});

const orgCustomFieldSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().max(10000),
  type: z.enum(["text", "hidden", "url"]),
});

const orgTotpSchema = z.object({
  secret: z.string().min(1),
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]).optional(),
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
  customFields: z.array(orgCustomFieldSchema).optional(),
  totp: orgTotpSchema.optional().nullable(),
});

export const updateOrgPasswordSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  username: z.string().max(200).optional().or(z.literal("")),
  password: z.string().min(1).optional(),
  url: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  customFields: z.array(orgCustomFieldSchema).optional(),
  totp: orgTotpSchema.optional().nullable(),
  isArchived: z.boolean().optional(),
});

export const createOrgSecureNoteSchema = z.object({
  entryType: z.literal("SECURE_NOTE"),
  title: z.string().min(1).max(200).trim(),
  content: z.string().max(50000),
  tagIds: z.array(z.string().cuid()).optional(),
});

export const updateOrgSecureNoteSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  content: z.string().max(50000).optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  isArchived: z.boolean().optional(),
});

export const createOrgCreditCardSchema = z.object({
  entryType: z.literal("CREDIT_CARD"),
  title: z.string().min(1).max(200).trim(),
  cardholderName: z.string().max(200).optional().or(z.literal("")),
  cardNumber: z.string().max(30).optional().or(z.literal("")),
  brand: z.string().max(50).optional().or(z.literal("")),
  expiryMonth: z.string().max(2).optional().or(z.literal("")),
  expiryYear: z.string().max(4).optional().or(z.literal("")),
  cvv: z.string().max(10).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
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
  entryType: z.literal("IDENTITY"),
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

export const createOrgTagSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal("")),
});

// ─── Share Link Schemas ───────────────────────────────────

const shareDataSchema = z.object({
  title: z.string().min(1).max(200),
  username: z.string().max(200).optional(),
  password: z.string().optional(),
  url: z.string().max(2000).optional(),
  notes: z.string().max(10000).optional(),
  customFields: z.array(z.object({
    label: z.string().max(100),
    value: z.string().max(10000),
    type: z.enum(["text", "hidden", "url"]),
  })).optional(),
  // SECURE_NOTE
  content: z.string().max(50000).optional(),
  // CREDIT_CARD
  cardholderName: z.string().max(200).optional(),
  cardNumber: z.string().max(30).optional(),
  brand: z.string().max(50).optional(),
  expiryMonth: z.string().max(2).optional(),
  expiryYear: z.string().max(4).optional(),
  cvv: z.string().max(10).optional(),
  // PASSKEY
  relyingPartyId: z.string().max(200).optional(),
  relyingPartyName: z.string().max(200).optional(),
  credentialId: z.string().max(500).optional(),
  creationDate: z.string().optional(),
  deviceInfo: z.string().max(200).optional(),
  // IDENTITY
  fullName: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
  dateOfBirth: z.string().optional(),
  nationality: z.string().max(100).optional(),
  idNumber: z.string().max(100).optional(),
  issueDate: z.string().optional(),
  expiryDate: z.string().optional(),
});

export const createShareLinkSchema = z.object({
  passwordEntryId: z.string().cuid().optional(),
  orgPasswordEntryId: z.string().cuid().optional(),
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

// ─── Type Exports ──────────────────────────────────────────

export type GeneratePasswordInput = z.infer<typeof generatePasswordSchema>;
export type GeneratePassphraseInput = z.infer<typeof generatePassphraseSchema>;
export type CreateE2EPasswordInput = z.infer<typeof createE2EPasswordSchema>;
export type UpdateE2EPasswordInput = z.infer<typeof updateE2EPasswordSchema>;
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
export type CreateOrgTagInput = z.infer<typeof createOrgTagSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
