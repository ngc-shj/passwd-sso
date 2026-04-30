"use client";

import { toast } from "sonner";
import { apiErrorToI18nKey, type ApiErrorCode } from "./api-error-codes";

/**
 * Parse an API error response, map its `error` code to the matching
 * ApiErrors i18n key, and surface it via a toast. If the body parse fails
 * or the code is missing/unknown, falls back to `fallbackErrorCode` (which
 * itself goes through apiErrorToI18nKey, so unrecognized codes still
 * render the catch-all "unknownError" string).
 *
 * Replaces the previous `showSidebarCrudError` helper and a number of
 * inline duplications across dialogs.
 */
export async function toastApiError(
  res: Response,
  tErrors: (key: string) => string,
  fallbackErrorCode?: ApiErrorCode,
): Promise<void> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const code = body.error ?? fallbackErrorCode;
  toast.error(tErrors(apiErrorToI18nKey(code)));
}
