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
  readonly name: string;
}
