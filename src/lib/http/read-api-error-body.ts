import type { MainApiErrorBody } from "@/lib/http/api-response";

/**
 * Parse a non-2xx `Response` into the canonical Main API error envelope.
 *
 * Returns `null` if the body is missing, not JSON, or does not match the
 * envelope shape — callers then fall back to a generic error toast.
 *
 * Usage:
 *   const res = await fetchApi("/api/tenant/policy", { method: "PATCH", ... });
 *   if (!res.ok) {
 *     const body = await readApiErrorBody(res);
 *     // body.message would be a TypeScript error (not in MainApiErrorBody)
 *     // body?.details would be `unknown` — narrow before use.
 *     const detail = typeof body?.details === "object" && body.details && "message" in body.details
 *       ? (body.details as { message: unknown }).message
 *       : null;
 *     toast.error(typeof detail === "string" ? detail : t("genericFailure"));
 *     return;
 *   }
 *
 * Why this exists:
 * - `await res.json()` returns `Promise<any>`. Without an explicit type,
 *   TypeScript cannot detect a consumer reading `data.message` after the
 *   wire shape moved that field under `details`. This helper forces the
 *   caller to use the typed envelope at the parse boundary.
 * - The closed list of context fields is enforced via the absence of an
 *   index signature on `MainApiErrorBody`; deep validation (e.g., asserting
 *   `error` is a known `ApiErrorCode` value) is intentionally NOT done here
 *   so the helper is cheap and never throws on unfamiliar codes.
 */
export async function readApiErrorBody(
  res: Response,
): Promise<MainApiErrorBody | null> {
  if (res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object" || typeof (json as { error?: unknown }).error !== "string") {
    return null;
  }
  return json as MainApiErrorBody;
}

/**
 * Extract `details.message` from a parsed `MainApiErrorBody`.
 *
 * The server wraps single-line diagnostic messages as `{ details: { message } }`
 * (per C4 closed list). UI consumers reading the message back have to walk
 * three optional levels — `body? -> details? -> message?` — and verify each
 * is the expected type. This helper centralizes that walk so consumers can:
 *
 *   const body = await readApiErrorBody(res);
 *   toast.error(getApiErrorMessage(body) ?? t("genericFailure"));
 *
 * Returns the message string when present, `null` otherwise.
 */
export function getApiErrorMessage(body: MainApiErrorBody | null): string | null {
  if (!body || typeof body.details !== "object" || body.details === null) {
    return null;
  }
  const message = (body.details as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * Read a single named field from `body.details` with a runtime type guard.
 *
 * Same rationale as `getApiErrorMessage` but for arbitrary fields. Useful
 * when the wire response carries diagnostic data beyond `message` —
 * e.g., the directory-sync `abortedSafety` boolean flag inside
 * `details: SyncResult`.
 *
 *   const body = await readApiErrorBody(res);
 *   const aborted = getApiErrorDetail(body, "abortedSafety", (v): v is boolean => v === true);
 *   toast.error(aborted ? t("safetyGuardTriggered") : t("genericFailure"));
 */
export function getApiErrorDetail<T>(
  body: MainApiErrorBody | null,
  field: string,
  guard: (value: unknown) => value is T,
): T | null {
  if (!body || typeof body.details !== "object" || body.details === null) {
    return null;
  }
  const value = (body.details as Record<string, unknown>)[field];
  return guard(value) ? value : null;
}
