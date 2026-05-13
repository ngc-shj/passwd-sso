// Mirrors src/lib/http/api-response.ts MainApiErrorBody — keep in sync.
// Extension cannot import from app/src/ (separate tsconfig), so this is a
// duplicate type with the same shape and invariants.
//
// Keep in sync with the other 2 copies:
//   - src/lib/http/read-api-error-body.ts (main, canonical)
//   - cli/src/lib/api-error-body.ts (CLI)
// CI drift check: scripts/checks/check-api-error-body-drift.sh
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
 * Narrow an unknown value (e.g. an already-extracted JSON body) to
 * `MainApiErrorBody`. Use this when you already have the parsed body in hand
 * rather than a `Response`.
 */
export function readMainApiErrorBody(
  value: unknown,
): MainApiErrorBody | null {
  if (!value || typeof value !== "object") return null;
  if (typeof (value as { error?: unknown }).error !== "string") return null;
  return value as MainApiErrorBody;
}
