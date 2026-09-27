/**
 * The two names the per-request CSP nonce travels under.
 *
 * Isomorphic on purpose: the cookie is written by the proxy
 * (`src/lib/proxy/security-headers.ts`) and read by a Server Component
 * (`csp-nonce.server.ts`); the `<meta>` name is rendered by the root layout
 * and read by client code (`src/lib/ui/csp-nonce.ts`). Neither module can
 * import the other's runtime, so the shared piece is just these strings.
 *
 * They happen to be the same string today. They are two separate constants
 * because they are two separate contracts — a cookie name is subject to
 * RFC 6265 prefix rules and path scoping, a meta name is not — and a gate
 * over one must not silently pass by matching the other.
 */

/** Cookie the proxy writes the per-request nonce to, scoped to the basePath. */
export const CSP_NONCE_COOKIE = "csp-nonce";

/**
 * `<meta name>` the root layout renders the nonce under for client readers.
 *
 * Two artifacts hold this value as a byte literal and CANNOT import it, so
 * renaming it means editing them by hand — they are change-coupled by review,
 * not by the type system:
 *
 *   - `patches/sonner+2.0.8.patch` — a dependency patch cannot import
 *     application code, and sonner's `__insertCSS` runs at module evaluation,
 *     before anything could hand it the value.
 *   - `Dockerfile` — the build-time check greps the emitted client chunk for
 *     the patch's marker. Note it greps the patch's own literal, so a rename
 *     that missed the patch would leave the check green while sonner queried
 *     a `<meta>` name nothing renders.
 *
 * Both are covered in practice by the CSP gate, which adjudicates in a
 * browser rather than by string match.
 */
export const CSP_NONCE_META_NAME = "csp-nonce";
