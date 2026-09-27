"use client";

import { CSP_NONCE_META_NAME } from "@/lib/security/csp-nonce-names";

/**
 * The document's CSP nonce, for client code that must nonce a `<style>` or
 * `<script>` it creates at runtime.
 *
 * Two carriers, in this order:
 *
 *  1. `document.querySelector("script[nonce]")?.nonce` — the IDL property.
 *     The browser parses the attribute into this property and then empties the
 *     attribute's VALUE, so `outerHTML`, `getAttribute("nonce")` and a
 *     value-matching selector like `script[nonce^="abc"]` all come back blank
 *     and an injected stylesheet cannot read it back out. The attribute itself
 *     remains present, which is why the PRESENCE selector `script[nonce]`
 *     below still matches. Preferring this read means the app does not publish
 *     the nonce anywhere wider than the platform already does.
 *  2. `<meta name="csp-nonce">` — the fallback, and the only carrier available
 *     before any nonced script has been parsed. It is serialised in clear,
 *     which is why it is second rather than first.
 *
 * Why the *initial* document's nonce is the right value: a document's CSP is
 * fixed at load. Every style element inserted later — by any client-side
 * navigation, at any time — is checked against that initial policy, so a
 * per-navigation nonce would never match.
 *
 * Only a non-null result is memoized. Caching a miss would let one early read
 * on a page with no carrier (the root error boundary renders its own
 * `<html><body>` with no `<head>`) poison every later reader in the document.
 */
let cachedNonce: string | null = null;

export function readCspNonce(): string | null {
  if (cachedNonce !== null) return cachedNonce;
  if (typeof document === "undefined") return null;

  const fromScript = document.querySelector<HTMLScriptElement>(
    "script[nonce]",
  )?.nonce;
  if (fromScript) {
    cachedNonce = fromScript;
    return cachedNonce;
  }

  const fromMeta = document.querySelector<HTMLMetaElement>(
    `meta[name="${CSP_NONCE_META_NAME}"]`,
  )?.content;
  if (fromMeta) {
    cachedNonce = fromMeta;
    return cachedNonce;
  }

  return null;
}

/** Test seam: drop the memoized value so a test can vary the carrier. */
export function _resetCspNonceCacheForTests(): void {
  cachedNonce = null;
}
