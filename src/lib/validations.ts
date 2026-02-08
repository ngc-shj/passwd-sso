import { z } from "zod";

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

export const createE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  keyVersion: z.number().int().min(1),
  tagIds: z.array(z.string().cuid()).optional(),
});

export const updateE2EPasswordSchema = z.object({
  encryptedBlob: encryptedFieldSchema.optional(),
  encryptedOverview: encryptedFieldSchema.optional(),
  keyVersion: z.number().int().min(1).optional(),
  tagIds: z.array(z.string().cuid()).optional(),
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
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
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

export const createOrgPasswordSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  username: z.string().max(200).optional().or(z.literal("")),
  password: z.string().min(1),
  url: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
});

export const updateOrgPasswordSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  username: z.string().max(200).optional().or(z.literal("")),
  password: z.string().min(1).optional(),
  url: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(10000).optional().or(z.literal("")),
  tagIds: z.array(z.string().cuid()).optional(),
  isFavorite: z.boolean().optional(),
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
export type CreateOrgTagInput = z.infer<typeof createOrgTagSchema>;
