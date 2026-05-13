/**
 * Typed error-body access for main-API responses.
 *
 * Mirrors `src/lib/http/api-response.ts` `MainApiErrorBody` — keep in sync.
 * The CLI cannot import from the app's `src/` (separate tsconfig / `rootDir`),
 * so this is a deliberate type duplicate with the same shape and invariants.
 * See `docs/api/error-handling.md` for the canonical envelope.
 *
 * Keep in sync with the other 2 copies:
 *   - src/lib/http/read-api-error-body.ts (main, canonical)
 *   - extension/src/lib/api-error-body.ts (browser extension)
 * CI drift check: scripts/checks/check-api-error-body-drift.sh
 *
 * Note: OAuth endpoints (`/api/mcp/token`, `/api/mcp/register`) use the RFC 6749
 * error envelope (`error`, `error_description`), NOT this shape. Reads from
 * those endpoints belong in `cli/src/lib/oauth.ts` and are intentionally not
 * migrated here.
 */

export type MainApiErrorBody = {
  readonly error: string;
  readonly details?: unknown;
  readonly lockedUntil?: string | null;
  readonly currentKeyVersion?: number;
};

export async function readApiErrorBody(
  res: Response,
): Promise<MainApiErrorBody | null> {
  if (res.ok) return null;
  const json = await res.json().catch(() => null);
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as { error?: unknown }).error !== "string"
  ) {
    return null;
  }
  return json as MainApiErrorBody;
}

/**
 * Read `details.message` from an already-parsed error body.
 *
 * The `apiRequest` wrapper in `api-client.ts` returns `res.data` as the raw
 * JSON body (success OR error shape). On error paths, callers can pass that
 * body here after narrowing it via `readMainApiErrorBody`.
 */
export function getApiErrorMessage(
  body: MainApiErrorBody | null,
): string | null {
  if (!body || typeof body.details !== "object" || body.details === null) {
    return null;
  }
  const message = (body.details as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * Read a single named field from `body.details` with a runtime type guard.
 *
 * Mirrors `getApiErrorDetail` in the main copy. See that file for full
 * rationale.
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

/**
 * Read `details.properties[<field>].errors` from a Zod `treeifyError()` shape.
 *
 * Centralizes the per-field Zod-tree access pattern used by validation-error
 * consumers (slug, url, etc.). Returns the errors array if present, `null`
 * otherwise.
 */
export function getApiErrorFieldErrors(
  body: MainApiErrorBody | null,
  field: string,
): readonly unknown[] | null {
  if (!body || typeof body.details !== "object" || body.details === null) {
    return null;
  }
  const properties = (body.details as { properties?: Record<string, unknown> }).properties;
  if (!properties || typeof properties !== "object") return null;
  const fieldObj = (properties as Record<string, unknown>)[field];
  if (!fieldObj || typeof fieldObj !== "object") return null;
  const errors = (fieldObj as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors : null;
}

/**
 * Narrow an unknown value (e.g. `apiRequest`'s `res.data`) to `MainApiErrorBody`.
 *
 * Useful at error-path call sites that consume the wrapper's `res.data` rather
 * than reading the `Response` directly.
 */
export function readMainApiErrorBody(
  value: unknown,
): MainApiErrorBody | null {
  if (!value || typeof value !== "object") return null;
  if (typeof (value as { error?: unknown }).error !== "string") return null;
  return value as MainApiErrorBody;
}
