import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  MCP_CLIENT_ID_MAX_LENGTH,
  isAcceptableRedirectUri,
} from "@/lib/constants/auth/mcp";

/** Locale-stripped pathname of the MCP consent page. */
export const MCP_CONSENT_PATH = "/mcp/authorize";

/**
 * The extra `form-action` origins the MCP consent page needs, for this request
 * only.
 *
 * Why this exists. The consent form POSTs to `/api/mcp/authorize/consent`,
 * which answers a 302 to the client's registered callback. `form-action`
 * constrains the whole redirect chain, and the base policy lists only `'self'`
 * and loopback — measured: a 302 to any other https origin is blocked, after
 * the authorization audit row has already been written. A hosted MCP client
 * therefore could not complete consent, while the audit trail said it had.
 *
 * The obvious fix — adding `https:` to the base policy — would let every page
 * in the app submit a form to any https origin, which is the exfiltration
 * `form-action` exists to stop. So the widening is scoped to the one response
 * that needs it, and to the one client it is for.
 *
 * **The origins come from the stored registration, never from the request.**
 * A `redirect_uri` query parameter is attacker-chosen; reading it here would
 * let anyone name the origin their own page's CSP admits. Only `client_id` is
 * taken from the URL, and it is used solely as a lookup key — an unknown or
 * over-long one yields no extra sources, which leaves the page with the base
 * policy and the page's own validation to refuse on.
 *
 * Returns `[]` on every failure path: an unknown client, an inactive one, a
 * stored URI the current accept set would refuse, or a lookup error. Failing
 * to an unwidened policy is the safe direction — the consent screen then
 * cannot complete a redirect the page would have had to refuse anyway.
 */
export async function consentFormActionSources(
  pathWithoutLocale: string,
  searchParams: URLSearchParams,
): Promise<string[]> {
  if (pathWithoutLocale !== MCP_CONSENT_PATH) return [];

  const clientId = searchParams.get("client_id");
  if (!clientId || clientId.length > MCP_CLIENT_ID_MAX_LENGTH) return [];

  let redirectUris: string[];
  try {
    const client = await withBypassRls(
      prisma,
      async (tx) =>
        tx.mcpClient.findFirst({
          where: { clientId, isActive: true },
          select: { redirectUris: true },
        }),
      BYPASS_PURPOSE.AUTH_FLOW,
    );
    if (!client) return [];
    redirectUris = client.redirectUris;
  } catch {
    // A lookup failure must not take the page down, and must not widen.
    return [];
  }

  const origins = new Set<string>();
  for (const uri of redirectUris) {
    // The same predicate registration and the consent POST apply. A row stored
    // before the accept set was narrowed must not widen the policy either.
    if (!isAcceptableRedirectUri(uri)) continue;
    try {
      const { origin } = new URL(uri);
      // Loopback is already in the base policy with a port wildcard; adding a
      // specific loopback origin would be redundant, and `'self'` covers the
      // app's own.
      if (!origin.startsWith("http://127.0.0.1") && !origin.startsWith("http://localhost")) {
        origins.add(origin);
      }
    } catch {
      continue;
    }
  }
  return [...origins];
}
