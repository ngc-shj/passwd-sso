import { API_ERROR } from "@/lib/http/api-error-codes";

/**
 * Whether a revoke response leaves the link revoked: a success, or
 * ALREADY_REVOKED (its creator or another admin revoked it since the list
 * loaded) — the goal is met either way, so the list shows it revoked.
 */
export async function revokeLeftLinkRevoked(res: Response): Promise<boolean> {
  if (res.ok) return true;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error === API_ERROR.ALREADY_REVOKED;
}
