/**
 * DPoP-aware fetch helper shared by index.ts and token-handler.ts.
 *
 * Every authenticated API call MUST route through swFetchAuthenticated so that
 * the DPoP proof is attached. swFetch in index.ts becomes a thin wrapper.
 */

import { signDpopProof, resetInMemoryKeyCache } from "../lib/dpop-key";

/** Thrown when two consecutive DPoP sign attempts fail. Callers MUST NOT
 * clearToken() on this error — a transient WebCrypto glitch is not a security
 * event; the next user-triggered call will retry from scratch. */
export class DpopSignError extends Error {
  readonly code: "DPoP_SIGN_FAILED";
  constructor(code: "DPoP_SIGN_FAILED") {
    super(code);
    this.code = code;
    this.name = "DpopSignError";
  }
}

/**
 * Fetch `${serverUrl}${path}` with Bearer + DPoP headers attached.
 *
 * Retries signing once (with a fresh key-cache flush) on transient WebCrypto
 * failures. Throws DpopSignError if the second attempt also fails.
 */
export async function swFetchAuthenticated(
  path: string,
  init: RequestInit | undefined,
  serverUrl: string,
  token: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  const sign = () =>
    signDpopProof({
      route: path,
      method: (init?.method ?? "GET").toUpperCase(),
      serverUrl,
      accessToken: token,
    });

  let proof: string;
  try {
    proof = await sign();
  } catch {
    try {
      resetInMemoryKeyCache();
      proof = await sign();
    } catch {
      throw new DpopSignError("DPoP_SIGN_FAILED");
    }
  }

  headers.set("DPoP", proof);
  return fetch(`${serverUrl}${path}`, { ...init, headers });
}
