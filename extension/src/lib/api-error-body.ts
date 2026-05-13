// Mirrors src/lib/http/api-response.ts MainApiErrorBody — keep in sync.
// Extension cannot import from app/src/ (separate tsconfig), so this is a
// duplicate type with the same shape and invariants.
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
  if (!json || typeof json !== "object" || typeof (json as { error?: unknown }).error !== "string") {
    return null;
  }
  return json as MainApiErrorBody;
}

export function getApiErrorMessage(body: MainApiErrorBody | null): string | null {
  if (!body || typeof body.details !== "object" || body.details === null) {
    return null;
  }
  const message = (body.details as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
