/**
 * AWS Secrets Manager key provider.
 *
 * Stores master keys as Secrets Manager secrets (hex strings).
 * Uses the default credential chain (IAM role, instance profile,
 * ECS task role, environment variables, etc.).
 *
 * Requires: @aws-sdk/client-secrets-manager (optional peer dep)
 *
 * Env vars:
 *   AWS_REGION                     — AWS region (required)
 *   SM_SECRET_SHARE_MASTER         — secret name/ARN for share master key (default: "passwd-sso/share-master-key")
 *   SM_SECRET_VERIFIER_PEPPER      — secret name/ARN for verifier pepper
 *   SM_SECRET_DIRECTORY_SYNC       — secret name/ARN for directory sync key
 *   SM_SECRET_WEBAUTHN_PRF         — secret name/ARN for WebAuthn PRF secret
 */

import type { KeyName, KeyProvider } from "./types";

interface CacheEntry {
  key: Buffer;
  fetchedAt: number;
}

interface AwsSmConfig {
  region: string;
  ttlMs?: number;        // default 300_000 (5 min)
  maxStaleTtlMs?: number; // default 2× ttlMs
}

// Map KeyName to env var names for secret names
const SECRET_NAME_ENV_MAP: Record<KeyName, string> = {
  "share-master": "SM_SECRET_SHARE_MASTER",
  "verifier-pepper": "SM_SECRET_VERIFIER_PEPPER",
  "directory-sync": "SM_SECRET_DIRECTORY_SYNC",
  "webauthn-prf": "SM_SECRET_WEBAUTHN_PRF",
};

// Default secret names in AWS Secrets Manager
const DEFAULT_SECRET_NAMES: Record<KeyName, string> = {
  "share-master": "passwd-sso/share-master-key",
  "verifier-pepper": "passwd-sso/verifier-pepper-key",
  "directory-sync": "passwd-sso/directory-sync-key",
  "webauthn-prf": "passwd-sso/webauthn-prf-secret",
};

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// Types for the subset of @aws-sdk/client-secrets-manager we use
interface SmGetResult {
  SecretString?: string;
}
interface SmClient {
  send(command: unknown): Promise<SmGetResult>;
}
interface AwsSmModule {
  SecretsManagerClient: new (config: { region: string }) => SmClient;
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
}

let smModulePromise: Promise<AwsSmModule> | null = null;

// Pluggable module loader — tests replace this via _setAwsSmModuleLoader
let smModuleLoader: () => Promise<AwsSmModule> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return req("@aws-sdk/client-secrets-manager") as AwsSmModule;
};

/** Override the module loader — for testing only. */
export function _setAwsSmModuleLoader(loader: typeof smModuleLoader): void {
  smModuleLoader = loader;
}

function getSmModule(): Promise<AwsSmModule> {
  if (!smModulePromise) {
    smModulePromise = smModuleLoader().catch((err) => {
      // Cache the rejection — package-not-installed is permanent
      throw new Error(
        `@aws-sdk/client-secrets-manager is required for KEY_PROVIDER=aws-sm. ` +
        `Install it with: npm install @aws-sdk/client-secrets-manager. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return smModulePromise;
}

/** Reset module cache — for testing only. */
export function _resetAwsSmModuleCache(): void {
  smModulePromise = null;
}

export class AwsSmKeyProvider implements KeyProvider {
  readonly name = "aws-sm";
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxStaleTtlMs: number;
  private region: string;
  private smClient: SmClient | null = null;

  constructor(config: AwsSmConfig) {
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
      const plaintext = await this.fetchSecret(name, version);
      this.cache.set(cacheKey, { key: plaintext, fetchedAt: Date.now() });
      return plaintext;
    } catch (err) {
      if (cached && Date.now() - cached.fetchedAt < this.maxStaleTtlMs) {
        const elapsed = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.warn(
          `[key-provider] AWS SM fetch failed for "${name}", using stale cached key (${elapsed}s old). ` +
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
    if (!this.region) {
      throw new Error("AWS_REGION is required for KEY_PROVIDER=aws-sm");
    }

    const keysToValidate: Array<{ name: KeyName; version?: number }> = [
      { name: "share-master" },
    ];

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

    if (!this.smClient) {
      const mod = await getSmModule();
      this.smClient = new mod.SecretsManagerClient({ region: this.region });
    }
    const { GetSecretValueCommand } = await getSmModule();

    const result = await this.smClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    if (!result.SecretString) {
      throw new Error(`AWS Secrets Manager secret "${secretName}" has no SecretString`);
    }

    const hex = result.SecretString.trim();
    if (!HEX64_RE.test(hex)) {
      throw new Error(
        `AWS Secrets Manager secret "${secretName}" is not a valid 64-char hex string`
      );
    }

    return Buffer.from(hex, "hex");
  }

  private resolveSecretName(name: KeyName, version?: number): string {
    const envVar = SECRET_NAME_ENV_MAP[name];
    const customName = process.env[envVar];
    const baseName = customName || DEFAULT_SECRET_NAMES[name];

    return version != null ? `${baseName}-v${version}` : baseName;
  }
}
