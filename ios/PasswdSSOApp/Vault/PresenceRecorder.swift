import Shared

/// Best-effort server-side presence verification (plan C2/C7), extracted as a
/// free function so the delete-on-mismatch / keep-on-error decision is testable
/// without driving the full RootView state machine.
///
/// - `verify` returning `true` → presence recorded server-side; no local action.
/// - `verify` returning `false` (422 `AUTH_HASH_MISMATCH` — the cached authHash
///   no longer matches the server) → the stale cache is deleted so a later
///   biometric unlock does not keep re-presenting a hash the server rejects.
/// - `verify` throwing (401-ladder exhaustion, network error, 429, ACCOUNT_LOCKED)
///   → the cache is left untouched: none of those outcomes prove the hash is
///     wrong, only that presence could not be confirmed this time.
///
/// Never throws — callers fire this as an unawaited `Task` so a slow/offline
/// server never delays showing the vault.
func recordPresence(
  authHash: String,
  verify: @Sendable (String) async throws -> Bool,
  wrappedKeyStore: any WrappedKeyStore
) async {
  do {
    let verified = try await verify(authHash)
    if !verified {
      try? wrappedKeyStore.deleteAuthHash()
    }
  } catch {
    // Not recorded this time — cache kept, next unlock retries.
  }
}
