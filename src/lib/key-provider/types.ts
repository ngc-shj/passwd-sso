/**
 * Key provider abstraction for master key management.
 *
 * Supports pluggable backends: env vars (default), AWS KMS, etc.
 * Keys are identified by logical name and optional version.
 */

export type KeyName =
  | "share-master"
  | "verifier-pepper"
  | "directory-sync"
  | "webauthn-prf"
  | "audit-anchor-signing"
  | "audit-anchor-tag-secret";

export interface KeyProvider {
  /** Fetch a key by name. For versioned keys (share-master), pass version. */
  getKey(name: KeyName, version?: number): Promise<Buffer>;

  /**
   * Synchronous key access from cache or env.
   * For EnvKeyProvider: reads directly from process.env.
   * For KMS providers: returns from warmed cache. Throws if cache miss or stale.
   */
  getKeySync(name: KeyName, version?: number): Buffer;

  /** Validate all required keys are accessible. Called at startup. */
  validateKeys(): Promise<void>;

  /** Provider name for logging. */
  readonly name: ProviderName;
}

/**
 * The closed set of provider identities.
 *
 * A union rather than `string` because this value is interpolated into a raw,
 * unredacted stderr write in `BaseCloudKeyProvider.logStaleWarning`. Every
 * implementation today assigns a fixed literal, so this only writes down what
 * was already true — but as `string` it left the door open for a future
 * provider to derive its name from configuration and put that value on stderr
 * with nothing to stop it. Enforced by `scripts/checks/check-boot-stderr-callers.mjs`.
 */
export type ProviderName = "env" | "aws-sm" | "gcp-sm" | "azure-kv" | "test";
