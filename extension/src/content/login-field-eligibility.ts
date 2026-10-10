// Whether a field may be a LOGIN candidate (password, username, OTP) given the
// card form on the page. Best-effort over page markup, not a security boundary:
// it keeps LOGIN fill, the inline trigger and save capture off the fields the
// card form owns (ccFormFields), except where the page itself declares a LOGIN
// role through `autocomplete`.

import { LOGIN_AUTOCOMPLETE_TOKENS } from "../lib/cc-patterns";

/** The page declares a LOGIN role for this field via an `autocomplete` token. */
export function hasExplicitLoginAutocomplete(el: HTMLInputElement): boolean {
  return (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .some((token) => LOGIN_AUTOCOMPLETE_TOKENS.includes(token));
}

export function isLoginEligible(
  el: HTMLInputElement,
  ccForm: ReadonlySet<HTMLElement>,
): boolean {
  return !ccForm.has(el) || hasExplicitLoginAutocomplete(el);
}
