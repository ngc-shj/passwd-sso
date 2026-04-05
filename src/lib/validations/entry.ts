import { z } from "zod";
import { ENTRY_TYPE, ENTRY_TYPE_VALUES } from "@/lib/constants";
import {
  PASSWORD_LENGTH_MIN,
  PASSWORD_LENGTH_MAX,
  PASSWORD_LENGTH_DEFAULT,
  PASSPHRASE_WORD_COUNT_MIN,
  PASSPHRASE_WORD_COUNT_MAX,
  PASSPHRASE_WORD_COUNT_DEFAULT,
  PASSPHRASE_SEPARATOR_DEFAULT,
  PASSPHRASE_SEPARATOR_MAX,
  CHARS_FIELD_MAX,
  HISTORY_BLOB_MAX,
  FILENAME_MAX_LENGTH,
  asciiPrintable,
  encryptedFieldSchema,
  hexString,
} from "./common";

export const entryTypeSchema = z.enum(ENTRY_TYPE_VALUES);

export const generatePasswordSchema = z.object({
  length: z.number().int().min(PASSWORD_LENGTH_MIN).max(PASSWORD_LENGTH_MAX).default(PASSWORD_LENGTH_DEFAULT),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
  excludeAmbiguous: z.boolean().default(false),
  includeChars: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
  excludeChars: z.string().max(CHARS_FIELD_MAX).regex(asciiPrintable).default(""),
});

export const generatePassphraseSchema = z.object({
  wordCount: z.number().int().min(PASSPHRASE_WORD_COUNT_MIN).max(PASSPHRASE_WORD_COUNT_MAX).default(PASSPHRASE_WORD_COUNT_DEFAULT),
  separator: z.string().max(PASSPHRASE_SEPARATOR_MAX).default(PASSPHRASE_SEPARATOR_DEFAULT),
  capitalize: z.boolean().default(true),
  includeNumber: z.boolean().default(false),
});

export const createE2EPasswordSchema = z.object({
  id: z.string().uuid().optional(), // client-generated UUIDv4 (required for aadVersion >= 1)
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  keyVersion: z.number().int().min(1),
  aadVersion: z.number().int().min(1).max(1).optional().default(1),
  tagIds: z.array(z.string().uuid()).optional(),
  folderId: z.string().uuid().optional().nullable(),
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
  aadVersion: z.number().int().min(1).max(1).optional(),
  tagIds: z.array(z.string().uuid()).optional(),
  folderId: z.string().uuid().optional().nullable(),
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  entryType: entryTypeSchema.optional(),
  requireReprompt: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
});

// ─── Generate Request Schema (with legacy mode fallback) ────

export const generateRequestSchema = z.preprocess(
  (val) => typeof val === "object" && val !== null && !("mode" in val)
    ? { mode: "password", ...val }
    : val,
  z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("password") }).merge(generatePasswordSchema),
    z.object({ mode: z.literal("passphrase") }).merge(generatePassphraseSchema),
  ]),
);

// ─── History Re-encrypt Schemas ─────────────────────────────

export const historyReencryptSchema = z.object({
  encryptedBlob: z.string().min(1).max(HISTORY_BLOB_MAX),
  blobIv: hexString(12),
  blobAuthTag: hexString(16),
  keyVersion: z.number().int(),
  oldBlobHash: hexString(32),
});

export const teamHistoryReencryptSchema = z.object({
  encryptedBlob: z.string().min(1).max(HISTORY_BLOB_MAX),
  blobIv: hexString(12),
  blobAuthTag: hexString(16),
  teamKeyVersion: z.number(),
  itemKeyVersion: z.number().optional(),
  encryptedItemKey: z.string().optional(),
  itemKeyIv: hexString(12).optional(),
  itemKeyAuthTag: hexString(16).optional(),
  oldBlobHash: hexString(32),
});

// ─── Bulk Import Schemas ────────────────────────────────────

export const BULK_IMPORT_MAX_ENTRIES = 50;

export const bulkImportSchema = z.object({
  entries: z.array(createE2EPasswordSchema).min(1).max(BULK_IMPORT_MAX_ENTRIES),
  sourceFilename: z.string().max(FILENAME_MAX_LENGTH).optional(),
});

// ─── Type Exports ──────────────────────────────────────────

export type GeneratePasswordInput = z.infer<typeof generatePasswordSchema>;
export type GeneratePassphraseInput = z.infer<typeof generatePassphraseSchema>;
export type CreateE2EPasswordInput = z.infer<typeof createE2EPasswordSchema>;
export type UpdateE2EPasswordInput = z.infer<typeof updateE2EPasswordSchema>;
export type BulkImportInput = z.infer<typeof bulkImportSchema>;
