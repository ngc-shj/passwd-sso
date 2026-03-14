import { z } from "zod";
import { ENTRY_TYPE, ENTRY_TYPE_VALUES } from "@/lib/constants";
import {
  PASSWORD_LENGTH_MIN,
  PASSWORD_LENGTH_MAX,
  PASSPHRASE_WORD_COUNT_MIN,
  PASSPHRASE_WORD_COUNT_MAX,
  CHARS_FIELD_MAX,
  asciiPrintable,
  encryptedFieldSchema,
} from "./common";

export const entryTypeSchema = z.enum(ENTRY_TYPE_VALUES);

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

export const generatePassphraseSchema = z.object({
  wordCount: z.number().int().min(PASSPHRASE_WORD_COUNT_MIN).max(PASSPHRASE_WORD_COUNT_MAX).default(4),
  separator: z.string().max(5).default("-"),
  capitalize: z.boolean().default(true),
  includeNumber: z.boolean().default(false),
});

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

// ─── Type Exports ──────────────────────────────────────────

export type GeneratePasswordInput = z.infer<typeof generatePasswordSchema>;
export type GeneratePassphraseInput = z.infer<typeof generatePassphraseSchema>;
export type CreateE2EPasswordInput = z.infer<typeof createE2EPasswordSchema>;
export type UpdateE2EPasswordInput = z.infer<typeof updateE2EPasswordSchema>;
