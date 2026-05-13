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
