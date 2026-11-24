// Kept out of vault-context so that modules mapping unlock errors (the lock
// screen's resolveUnlockError, and the dialogs reusing it) do not need the
// provider module, which their tests mock whole.

/**
 * `VaultUnlockError` code for an unlock whose key material was dropped (a page
 * hide, an unmount) before it could be installed. The passphrase or passkey
 * was accepted, so this is not a failed attempt: the caller says the unlock
 * was interrupted and nothing is reported for lockout tracking.
 */
export const VAULT_UNLOCK_INTERRUPTED = "VAULT_UNLOCK_INTERRUPTED";

/**
 * `VaultUnlockError` code for a setup whose POST got no answer the client can
 * read as a refusal (a rejected fetch, or a 5xx that is not a pre-route
 * refusal): the vault may have been created with the passphrase just entered.
 * The provider has asked the vault status again; the caller says the setup may
 * have completed and to unlock with that passphrase. A retry with another
 * passphrase would hit VAULT_ALREADY_SETUP with the first one in effect.
 */
export const VAULT_SETUP_OUTCOME_UNKNOWN = "VAULT_SETUP_OUTCOME_UNKNOWN";
