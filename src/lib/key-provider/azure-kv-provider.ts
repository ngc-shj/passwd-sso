/**
 * Azure Key Vault key provider.
 *
 * Stores master keys as Key Vault secrets (hex strings).
 * Uses DefaultAzureCredential for authentication (supports managed identity,
 * workload identity, CLI credentials, etc.).
 *
 * Requires: @azure/keyvault-secrets + @azure/identity (optional peer deps)
 *
 * Env vars:
 *   AZURE_KV_URL                   — Key Vault URL (e.g. https://my-vault.vault.azure.net)
 *   KV_SECRET_SHARE_MASTER         — secret name for share master key (default: "share-master-key")
 *   KV_SECRET_VERIFIER_PEPPER      — secret name for verifier pepper
 *   KV_SECRET_DIRECTORY_SYNC       — secret name for directory sync key
 *   KV_SECRET_WEBAUTHN_PRF         — secret name for WebAuthn PRF secret
 */

import type { KeyName, KeyProvider } from "./types";

interface CacheEntry {
  key: Buffer;
  fetchedAt: number;
}

interface AzureKvConfig {
  vaultUrl: string;
  ttlMs?: number;        // default 300_000 (5 min)
  maxStaleTtlMs?: number; // default 2× ttlMs
}

// Map KeyName to env var names for Key Vault secret names
const SECRET_NAME_ENV_MAP: Record<KeyName, string> = {
  "share-master": "KV_SECRET_SHARE_MASTER",
  "verifier-pepper": "KV_SECRET_VERIFIER_PEPPER",
  "directory-sync": "KV_SECRET_DIRECTORY_SYNC",
  "webauthn-prf": "KV_SECRET_WEBAUTHN_PRF",
};

// Default secret names in Key Vault
const DEFAULT_SECRET_NAMES: Record<KeyName, string> = {
  "share-master": "share-master-key",
  "verifier-pepper": "verifier-pepper-key",
  "directory-sync": "directory-sync-key",
  "webauthn-prf": "webauthn-prf-secret",
};

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// Types for the subset of Azure SDK we use (optional peer deps)
interface KvSecretClient {
  getSecret(name: string, options?: { version?: string }): Promise<{ value?: string }>;
}
interface AzureKvModule {
  SecretClient: new (url: string, credential: unknown) => KvSecretClient;
}
interface AzureIdentityModule {
  DefaultAzureCredential: new () => unknown;
}

let kvModulePromise: Promise<{ kv: AzureKvModule; identity: AzureIdentityModule }> | null = null;

// Pluggable module loader — tests replace this via _setAzureKvModuleLoader
let kvModuleLoader: () => Promise<{ kv: AzureKvModule; identity: AzureIdentityModule }> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return {
    kv: req("@azure/keyvault-secrets") as AzureKvModule,
    identity: req("@azure/identity") as AzureIdentityModule,
  };
};

/** Override the Azure module loader — for testing only. */
export function _setAzureKvModuleLoader(loader: typeof kvModuleLoader): void {
  kvModuleLoader = loader;
}

function getAzureModules(): Promise<{ kv: AzureKvModule; identity: AzureIdentityModule }> {
  if (!kvModulePromise) {
    kvModulePromise = kvModuleLoader().catch((err) => {
      // Cache the rejection — package-not-installed is permanent
      throw new Error(
        `@azure/keyvault-secrets and @azure/identity are required for KEY_PROVIDER=azure-kv. ` +
        `Install them with: npm install @azure/keyvault-secrets @azure/identity. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return kvModulePromise;
}

/** Reset module cache — for testing only. */
export function _resetAzureKvModuleCache(): void {
  kvModulePromise = null;
}

export class AzureKvKeyProvider implements KeyProvider {
  readonly name = "azure-kv";
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxStaleTtlMs: number;
  private vaultUrl: string;
  private secretClient: KvSecretClient | null = null;

  constructor(config: AzureKvConfig) {
    this.vaultUrl = config.vaultUrl;
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
      const plaintext = await this.fetchSecret(name, version);
      this.cache.set(cacheKey, { key: plaintext, fetchedAt: Date.now() });
      return plaintext;
    } catch (err) {
      if (cached && Date.now() - cached.fetchedAt < this.maxStaleTtlMs) {
        const elapsed = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.warn(
          `[key-provider] Azure KV fetch failed for "${name}", using stale cached key (${elapsed}s old). ` +
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

    if (Date.now() - cached.fetchedAt >= this.ttlMs) {
      void this.getKey(name, version).catch(() => {
        // Background refresh failed — warning logged in getKey
      });
    }

    return cached.key;
  }

  async validateKeys(): Promise<void> {
    if (!this.vaultUrl) {
      throw new Error("AZURE_KV_URL is required for KEY_PROVIDER=azure-kv");
    }

    // share-master secret name must be configured or use default
    const shareSecretName = process.env[SECRET_NAME_ENV_MAP["share-master"]]
      || DEFAULT_SECRET_NAMES["share-master"];
    if (!shareSecretName) {
      throw new Error("Share master secret name is required for KEY_PROVIDER=azure-kv");
    }

    const keysToValidate: Array<{ name: KeyName; version?: number }> = [
      { name: "share-master" },
    ];

    // Validate other keys if their secret name env vars are set
    for (const [name, envVar] of Object.entries(SECRET_NAME_ENV_MAP)) {
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

  private async fetchSecret(name: KeyName, version?: number): Promise<Buffer> {
    const secretName = this.resolveSecretName(name, version);

    if (!this.secretClient) {
      const { kv, identity } = await getAzureModules();
      const credential = new identity.DefaultAzureCredential();
      this.secretClient = new kv.SecretClient(this.vaultUrl, credential);
    }

    const result = await this.secretClient.getSecret(secretName);

    if (!result.value) {
      throw new Error(`Azure Key Vault secret "${secretName}" has no value`);
    }

    // Validate hex format (secrets store 64-char hex strings)
    const hex = result.value.trim();
    if (!HEX64_RE.test(hex)) {
      throw new Error(
        `Azure Key Vault secret "${secretName}" is not a valid 64-char hex string`
      );
    }

    return Buffer.from(hex, "hex");
  }

  private resolveSecretName(name: KeyName, version?: number): string {
    const envVar = SECRET_NAME_ENV_MAP[name];
    const customName = process.env[envVar];
    const baseName = customName || DEFAULT_SECRET_NAMES[name];

    // For versioned keys, append version suffix
    return version != null ? `${baseName}-v${version}` : baseName;
  }
}
