import { z } from "zod";
import { SEND_NAME_MAX_LENGTH, MAX_VIEWS_MIN, MAX_VIEWS_MAX } from "./common";

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

// ─── Type Exports ──────────────────────────────────────────

export type CreateSendTextInput = z.infer<typeof createSendTextSchema>;
export type CreateSendFileMetaInput = z.infer<typeof createSendFileMetaSchema>;
