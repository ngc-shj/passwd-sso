import { z } from "zod";
import { TAG_NAME_MAX_LENGTH, HEX_COLOR_REGEX } from "./common";

// ─── Tag Schemas ────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim(),
  color: z
    .string()
    .regex(HEX_COLOR_REGEX)
    .optional()
    .or(z.literal(""))
    .or(z.null().transform(() => undefined)),
  parentId: z.string().cuid().optional().nullable(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH).trim().optional(),
  color: z
    .string()
    .regex(HEX_COLOR_REGEX)
    .nullable()
    .optional()
    .or(z.literal("")),
  parentId: z.string().cuid().optional().nullable(),
});

// ─── Type Exports ──────────────────────────────────────────

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
