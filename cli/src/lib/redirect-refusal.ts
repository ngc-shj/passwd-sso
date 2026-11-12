/**
 * Credential-bearing requests use `redirect: "error"`, so a server that
 * redirects (http→https, apex→www, a canonicalising proxy) makes fetch reject
 * with undici's bare "fetch failed". Rethrow that one case with the fix the
 * user needs; every other error passes through unchanged.
 *
 * Usage: `await fetch(url, init).catch(onRedirectRefused(url))`
 */
export function onRedirectRefused(url: string): (err: unknown) => never {
  return (err) => {
    if (
      err instanceof TypeError &&
      err.cause instanceof Error &&
      err.cause.message === "unexpected redirect"
    ) {
      throw new Error(
        `The server at ${new URL(url).origin} redirected the request, and requests carrying credentials do not follow redirects. ` +
          "Set the server URL to its final address: passwd-sso login --server <url>",
        { cause: err },
      );
    }
    throw err;
  };
}
