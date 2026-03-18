/**
 * GCP Secret Manager key provider.
 *
 * Stores master keys as Secret Manager secrets (hex strings).
 * Uses Application Default Credentials (ADC) for authentication
 * (supports Workload Identity, service account keys, gcloud CLI, etc.).
 *
 * Requires: @google-cloud/secret-manager (optional peer dep)
 *
 * Env vars:
 *   GCP_PROJECT_ID                 — GCP project ID (required)
 *   SM_SECRET_SHARE_MASTER         — secret name for share master key (default: "share-master-key")
 *   SM_SECRET_VERIFIER_PEPPER      — secret name for verifier pepper
 *   SM_SECRET_DIRECTORY_SYNC       — secret name for directory sync key
 *   SM_SECRET_WEBAUTHN_PRF         — secret name for WebAuthn PRF secret
 */

import type { KeyName, KeyProvider } from "./types";

interface CacheEntry {
  key: Buffer;
  fetchedAt: number;
}

interface GcpSmConfig {
  projectId: string;
  ttlMs?: number;        // default 300_000 (5 min)
  maxStaleTtlMs?: number; // default 2× ttlMs
}

// Map KeyName to env var names for Secret Manager secret names
const SECRET_NAME_ENV_MAP: Record<KeyName, string> = {
  "share-master": "SM_SECRET_SHARE_MASTER",
  "verifier-pepper": "SM_SECRET_VERIFIER_PEPPER",
  "directory-sync": "SM_SECRET_DIRECTORY_SYNC",
  "webauthn-prf": "SM_SECRET_WEBAUTHN_PRF",
};

// Default secret names in Secret Manager
const DEFAULT_SECRET_NAMES: Record<KeyName, string> = {
  "share-master": "share-master-key",
  "verifier-pepper": "verifier-pepper-key",
  "directory-sync": "directory-sync-key",
  "webauthn-prf": "webauthn-prf-secret",
};

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// Types for the subset of @google-cloud/secret-manager we use
interface SmClient {
  accessSecretVersion(request: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string } }]>;
}
interface GcpSmModule {
  SecretManagerServiceClient: new () => SmClient;
}

let smModulePromise: Promise<GcpSmModule> | null = null;

// Pluggable module loader — tests replace this via _setGcpSmModuleLoader
let smModuleLoader: () => Promise<GcpSmModule> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return req("@google-cloud/secret-manager") as GcpSmModule;
};

/** Override the Secret Manager module loader — for testing only. */
export function _setGcpSmModuleLoader(loader: typeof smModuleLoader): void {
  smModuleLoader = loader;
}

function getSmModule(): Promise<GcpSmModule> {
  if (!smModulePromise) {
    smModulePromise = smModuleLoader().catch((err) => {
      // Cache the rejection — package-not-installed is permanent
      throw new Error(
        `@google-cloud/secret-manager is required for KEY_PROVIDER=gcp-sm. ` +
        `Install it with: npm install @google-cloud/secret-manager. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return smModulePromise;
}

/** Reset module cache — for testing only. */
export function _resetGcpSmModuleCache(): void {
  smModulePromise = null;
}

export class GcpSmKeyProvider implements KeyProvider {
  readonly name = "gcp-sm";
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxStaleTtlMs: number;
  private projectId: string;
  private smClient: SmClient | null = null;

  constructor(config: GcpSmConfig) {
    this.projectId = config.projectId;
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
          `[key-provider] GCP SM fetch failed for "${name}", using stale cached key (${elapsed}s old). ` +
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
    if (!this.projectId) {
      throw new Error("GCP_PROJECT_ID is required for KEY_PROVIDER=gcp-sm");
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

    // Resource name: projects/{project}/secrets/{secret}/versions/latest
    const resourceName = `projects/${this.projectId}/secrets/${secretName}/versions/latest`;

    if (!this.smClient) {
      const mod = await getSmModule();
      this.smClient = new mod.SecretManagerServiceClient();
    }

    const [response] = await this.smClient.accessSecretVersion({ name: resourceName });

    const data = response.payload?.data;
    if (!data) {
      throw new Error(`GCP Secret Manager secret "${secretName}" has no payload data`);
    }

    const hex = (typeof data === "string" ? data : Buffer.from(data).toString("utf8")).trim();

    if (!HEX64_RE.test(hex)) {
      throw new Error(
        `GCP Secret Manager secret "${secretName}" is not a valid 64-char hex string`
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
