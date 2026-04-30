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
 *   AZ_KV_SECRET_SHARE_MASTER              — secret name (default: "share-master-key")
 *   AZ_KV_SECRET_VERIFIER_PEPPER           — secret name for verifier pepper
 *   AZ_KV_SECRET_DIRECTORY_SYNC            — secret name for directory sync key
 *   AZ_KV_SECRET_WEBAUTHN_PRF              — secret name for WebAuthn PRF secret
 *   AZ_KV_SECRET_AUDIT_ANCHOR_SIGNING      — secret name for audit anchor signing key
 *   AZ_KV_SECRET_AUDIT_ANCHOR_TAG_SECRET   — secret name for audit anchor tag secret
 */

import type { KeyName } from "./types";
import { BaseCloudKeyProvider, type CloudProviderConfig } from "./base-cloud-provider";

interface AzureKvConfig extends CloudProviderConfig {
  vaultUrl: string;
}

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
let kvModuleLoader: () => Promise<{ kv: AzureKvModule; identity: AzureIdentityModule }> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return {
    kv: req("@azure/keyvault-secrets") as AzureKvModule,
    identity: req("@azure/identity") as AzureIdentityModule,
  };
};

export function _setAzureKvModuleLoader(loader: typeof kvModuleLoader): void {
  kvModuleLoader = loader;
}

function getAzureModules(): Promise<{ kv: AzureKvModule; identity: AzureIdentityModule }> {
  if (!kvModulePromise) {
    kvModulePromise = kvModuleLoader().catch((err) => {
      throw new Error(
        `@azure/keyvault-secrets and @azure/identity are required for KEY_PROVIDER=azure-kv. ` +
        `Install them with: npm install @azure/keyvault-secrets @azure/identity. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return kvModulePromise;
}

export function _resetAzureKvModuleCache(): void {
  kvModulePromise = null;
}

export class AzureKvKeyProvider extends BaseCloudKeyProvider {
  readonly name = "azure-kv";
  private vaultUrl: string;
  private secretClient: KvSecretClient | null = null;

  protected readonly secretNameEnvMap: Record<KeyName, string> = {
    "share-master": "AZ_KV_SECRET_SHARE_MASTER",
    "verifier-pepper": "AZ_KV_SECRET_VERIFIER_PEPPER",
    "directory-sync": "AZ_KV_SECRET_DIRECTORY_SYNC",
    "webauthn-prf": "AZ_KV_SECRET_WEBAUTHN_PRF",
    "audit-anchor-signing": "AZ_KV_SECRET_AUDIT_ANCHOR_SIGNING",
    "audit-anchor-tag-secret": "AZ_KV_SECRET_AUDIT_ANCHOR_TAG_SECRET",
  };

  protected readonly defaultSecretNames: Record<KeyName, string> = {
    "share-master": "share-master-key",
    "verifier-pepper": "verifier-pepper-key",
    "directory-sync": "directory-sync-key",
    "webauthn-prf": "webauthn-prf-secret",
    "audit-anchor-signing": "audit-anchor-signing-key",
    "audit-anchor-tag-secret": "audit-anchor-tag-secret",
  };

  constructor(config: AzureKvConfig) {
    super(config);
    this.vaultUrl = config.vaultUrl;
  }

  protected validateConfig(): void {
    if (!this.vaultUrl) {
      throw new Error("AZURE_KV_URL is required for KEY_PROVIDER=azure-kv");
    }
  }

  protected async fetchSecret(name: KeyName, version?: number): Promise<Buffer> {
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

    return this.validateHex64(result.value, secretName);
  }
}
