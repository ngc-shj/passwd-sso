import { z } from "zod";
import { NAME_MAX_LENGTH } from "./common";

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

// ─── Type Exports ──────────────────────────────────────────

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
