/**
 * Thrown by a getter that was deliberately declined by the user — today, the
 * master-passphrase re-prompt dialog (`useReprompt`).
 *
 * It lives in its own leaf module (no imports) on purpose: `copySecretToClipboard`
 * must discriminate a decline from a failure, and `CopyButton` renders on the
 * unauthenticated `/s/` share route. Exporting the sentinel from `use-reprompt.ts`
 * would drag `RepromptDialog` → `vault-context` into that bundle.
 */
export class CopyCancelledError extends Error {
  override readonly name = "CopyCancelledError";

  constructor() {
    super("copy cancelled by the user");
  }
}
