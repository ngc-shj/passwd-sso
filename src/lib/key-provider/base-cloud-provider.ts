/**
 * Abstract base class for cloud secret manager key providers.
 *
 * Implements TTL-based caching, stale fallback, background refresh,
 * secret name resolution, and validateKeys(). Subclasses only need to
 * implement fetchSecret() and validateConfig().
 */

import type { KeyName, KeyProvider } from "./types";
import { HEX64_RE } from "@/lib/validations/common";

export { HEX64_RE };

export interface CacheEntry {
  key: Buffer;
  fetchedAt: number;
}

export interface CloudProviderConfig {
  ttlMs?: number;        // default 300_000 (5 min)
  maxStaleTtlMs?: number; // default 2× ttlMs
}

export abstract class BaseCloudKeyProvider implements KeyProvider {
  abstract readonly name: string;

  /** Map KeyName to env var name for custom secret name override */
  protected abstract readonly secretNameEnvMap: Record<KeyName, string>;

  /** Default secret names when env var is not set */
  protected abstract readonly defaultSecretNames: Record<KeyName, string>;

  private cache = new Map<string, CacheEntry>();
  protected ttlMs: number;
  protected maxStaleTtlMs: number;

  constructor(config: CloudProviderConfig) {
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
        this.logStaleWarning(name, elapsed, err);
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
    this.validateConfig();

    // Resolve current share-master version (same logic as EnvKeyProvider)
    const currentVersion = parseInt(
      process.env.SHARE_MASTER_KEY_CURRENT_VERSION ?? "1",
      10
    );
    if (isNaN(currentVersion) || currentVersion < 1) {
      throw new Error("SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer");
    }

    const keysToValidate: Array<{ name: KeyName; version?: number }> = [
      { name: "share-master", version: currentVersion },
    ];

    // Validate all other key types (not just those with custom secret names)
    const otherKeys: KeyName[] = ["verifier-pepper", "directory-sync", "webauthn-prf"];
    for (const name of otherKeys) {
      keysToValidate.push({ name });
    }

    await Promise.all(
      keysToValidate.map(({ name, version }) => this.getKey(name, version))
    );
  }

  /** Validate provider-specific prerequisites (region, vault URL, etc.) */
  protected abstract validateConfig(): void;

  /** Fetch and validate a secret from the cloud store. Must return a 32-byte Buffer. */
  protected abstract fetchSecret(name: KeyName, version?: number): Promise<Buffer>;

  protected resolveSecretName(name: KeyName, version?: number): string {
    const envVar = this.secretNameEnvMap[name];
    const customName = process.env[envVar];
    const baseName = customName || this.defaultSecretNames[name];
    return version != null ? `${baseName}-v${version}` : baseName;
  }

  protected validateHex64(value: string, secretName: string): Buffer {
    const hex = value.trim();
    if (!HEX64_RE.test(hex)) {
      throw new Error(`Secret "${secretName}" is not a valid 64-char hex string`);
    }
    return Buffer.from(hex, "hex");
  }

  private logStaleWarning(name: string, elapsedSec: number, err: unknown): void {
    // Dynamic import to avoid bundling pino/node:async_hooks into SSR bundles
    void import("@/lib/logger").then(({ default: log }) => {
      log.warn(
        { provider: this.name, keyName: name, elapsedSec, maxStaleTtlSec: this.maxStaleTtlMs / 1000 },
        `[key-provider] fetch failed, using stale cached key: ${err instanceof Error ? err.message : err}`
      );
    }).catch(() => {
      // Fallback if logger unavailable
      console.warn(`[key-provider] ${this.name} stale key used for "${name}" (${elapsedSec}s old)`);
    });
  }

  private buildCacheKey(name: KeyName, version?: number): string {
    return version != null ? `${name}:${version}` : name;
  }
}
