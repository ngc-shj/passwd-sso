import { cookies } from "next/headers";
import { CSP_NONCE_COOKIE } from "./csp-nonce-names";

/**
 * The current request's CSP nonce, as the proxy issued it.
 *
 * Reading it from the cookie works within the same request because Next.js
 * merges cookies a middleware set onto the request the Server Components see
 * — verified against a production build: `<meta name="csp-nonce">` matches the
 * nonce in the response `Content-Security-Policy` header on a first, cookieless
 * request. (The originating handoff assumed this read was one request stale;
 * it is not. See docs/archive/review/prod-csp-violation-zero-plan.md, SC2.)
 *
 * Returns `""` when the cookie is absent — a page reached outside the proxy's
 * matcher receives no response CSP either, so there is no nonce to honour.
 */
export async function getCspNonce(): Promise<string> {
  return (await cookies()).get(CSP_NONCE_COOKIE)?.value ?? "";
}
