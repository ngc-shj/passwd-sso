import type { KeyName, KeyProvider } from "./types";

interface CacheEntry {
  key: Buffer;
  fetchedAt: number;
}

interface AwsKmsConfig {
  region: string;
  ttlMs?: number;        // default 300_000 (5 min)
  maxStaleTtlMs?: number; // default 2× ttlMs
}

// Map KeyName to env var names for encrypted data keys
const KEY_ENV_MAP: Record<KeyName, string> = {
  "share-master": "KMS_ENCRYPTED_KEY_SHARE_MASTER",
  "verifier-pepper": "KMS_ENCRYPTED_KEY_VERIFIER_PEPPER",
  "directory-sync": "KMS_ENCRYPTED_KEY_DIRECTORY_SYNC",
  "webauthn-prf": "KMS_ENCRYPTED_KEY_WEBAUTHN_PRF",
};

// Types for the subset of @aws-sdk/client-kms we use (optional peer dep)
interface KmsDecryptResult {
  Plaintext?: Uint8Array;
}
interface KmsClient {
  send(command: unknown): Promise<KmsDecryptResult>;
}
interface KmsModule {
  KMSClient: new (config: { region: string }) => KmsClient;
  DecryptCommand: new (input: { CiphertextBlob: Uint8Array }) => unknown;
}

// Cached module import promise. On load failure the rejected promise is cached
// so we don't retry (package-not-installed is permanent).
let kmsModulePromise: Promise<KmsModule> | null = null;

// Pluggable module loader — tests replace this via _setKmsModuleLoader
let kmsModuleLoader: () => Promise<KmsModule> = async () => {
  // Use createRequire to load the optional peer dependency at runtime.
  // This prevents the bundler from statically analyzing and failing
  // when @aws-sdk/client-kms is not installed (it's an optional peer dep).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return req("@aws-sdk/client-kms") as KmsModule;
};

/** Override the KMS module loader — for testing only. */
export function _setKmsModuleLoader(loader: () => Promise<KmsModule>): void {
  kmsModuleLoader = loader;
}

function getKmsModule(): Promise<KmsModule> {
  if (!kmsModulePromise) {
    kmsModulePromise = kmsModuleLoader().catch((err) => {
      // Cache the rejection — do NOT reset kmsModulePromise to null.
      // Package-not-installed is permanent; resetting would cause thundering herd.
      throw new Error(
        `@aws-sdk/client-kms is required for KEY_PROVIDER=aws-kms. ` +
        `Install it with: npm install @aws-sdk/client-kms. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return kmsModulePromise;
}

/** Reset module cache — for testing only. */
export function _resetKmsModuleCache(): void {
  kmsModulePromise = null;
}

export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "aws-kms";
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxStaleTtlMs: number;
  private region: string;
  private kmsClient: KmsClient | null = null;

  constructor(config: AwsKmsConfig) {
    this.region = config.region;
    this.ttlMs = config.ttlMs ?? 300_000;
    this.maxStaleTtlMs = config.maxStaleTtlMs ?? this.ttlMs * 2;
  }

  async getKey(name: KeyName, version?: number): Promise<Buffer> {
    const cacheKey = this.buildCacheKey(name, version);
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.key;
    }

    try {
      const plaintext = await this.decryptDataKey(name, version);
      this.cache.set(cacheKey, { key: plaintext, fetchedAt: Date.now() });
      return plaintext;
    } catch (err) {
      // If we have a stale cached key within maxStaleTtlMs, use it
      if (cached && Date.now() - cached.fetchedAt < this.maxStaleTtlMs) {
        const elapsed = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.warn(
          `[key-provider] KMS refresh failed for "${name}", using stale cached key (${elapsed}s old). ` +
          `Max stale TTL: ${this.maxStaleTtlMs / 1000}s. Error: ${err instanceof Error ? err.message : err}`
        );
        return cached.key;
      }
      throw err;
    }
  }

  getKeySync(name: KeyName, version?: number): Buffer {
    const cacheKey = this.buildCacheKey(name, version);
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      throw new Error(`Key "${name}" not in cache. Call validateKeys() at startup.`);
    }

    if (Date.now() - cached.fetchedAt >= this.maxStaleTtlMs) {
      throw new Error(`Key "${name}" cache expired beyond max stale TTL.`);
    }

    // Trigger background refresh if past TTL but within maxStaleTtlMs
    if (Date.now() - cached.fetchedAt >= this.ttlMs) {
      void this.getKey(name, version).catch(() => {
        // Background refresh failed — warning logged in getKey
      });
    }

    return cached.key;
  }

  async validateKeys(): Promise<void> {
    const version = parseInt(process.env.SHARE_MASTER_KEY_CURRENT_VERSION ?? "1", 10);
    if (!Number.isFinite(version) || version < 1) {
      throw new Error("SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer");
    }

    const keysToValidate: Array<{ name: KeyName; version?: number }> = [
      // Use version=undefined for share-master so env var is KMS_ENCRYPTED_KEY_SHARE_MASTER
      // (not KMS_ENCRYPTED_KEY_SHARE_MASTER_V1). Versioned keys are resolved at request time.
      { name: "share-master" },
    ];

    // Only validate keys that have encrypted data key env vars set
    for (const [name, envVar] of Object.entries(KEY_ENV_MAP)) {
      if (name !== "share-master" && process.env[envVar]) {
        keysToValidate.push({ name: name as KeyName });
      }
    }

    await Promise.all(
      keysToValidate.map(({ name, version }) => this.getKey(name, version))
    );
  }

  private buildCacheKey(name: KeyName, version?: number): string {
    return version != null ? `${name}:${version}` : name;
  }

  private async decryptDataKey(name: KeyName, version?: number): Promise<Buffer> {
    const envVar = version != null
      ? `${KEY_ENV_MAP[name]}_V${version}`
      : KEY_ENV_MAP[name];

    const encryptedB64 = process.env[envVar];
    if (!encryptedB64) {
      throw new Error(`Encrypted data key not found in env: ${envVar}`);
    }

    // Reuse KMS client instance across calls (connection pool + credential cache)
    if (!this.kmsClient) {
      const { KMSClient } = await getKmsModule();
      this.kmsClient = new KMSClient({ region: this.region });
    }
    const { DecryptCommand } = await getKmsModule();

    const result = await this.kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(encryptedB64, "base64"),
      })
    );

    if (!result.Plaintext) {
      throw new Error(`KMS Decrypt returned no plaintext for ${envVar}`);
    }

    return Buffer.from(result.Plaintext);
  }
}
