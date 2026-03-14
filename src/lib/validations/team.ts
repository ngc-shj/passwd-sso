import { z } from "zod";
import {
  TEAM_INVITE_ROLE_VALUES,
  TEAM_ROLE,
  TEAM_ROLE_VALUES,
  TENANT_ROLE_VALUES,
  ENTRY_TYPE,
} from "@/lib/constants";
import {
  NAME_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  POLICY_SESSION_DURATION_MIN,
  POLICY_SESSION_DURATION_MAX,
  TAG_NAME_MAX_LENGTH,
  encryptedFieldSchema,
} from "./common";
import { entryTypeSchema } from "./entry";

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

// ─── Type Exports ──────────────────────────────────────────

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
