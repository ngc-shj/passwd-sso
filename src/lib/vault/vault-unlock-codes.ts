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
