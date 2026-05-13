/**
 * Typed error-body access for main-API responses.
 *
 * Mirrors `src/lib/http/api-response.ts` `MainApiErrorBody` — keep in sync.
 * The CLI cannot import from the app's `src/` (separate tsconfig / `rootDir`),
 * so this is a deliberate type duplicate with the same shape and invariants.
 * See `docs/api/error-handling.md` for the canonical envelope.
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
