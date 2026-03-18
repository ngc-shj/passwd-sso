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
 *   GCP_SM_SECRET_SHARE_MASTER     — secret name (default: "share-master-key")
 *   GCP_SM_SECRET_VERIFIER_PEPPER  — secret name for verifier pepper
 *   GCP_SM_SECRET_DIRECTORY_SYNC   — secret name for directory sync key
 *   GCP_SM_SECRET_WEBAUTHN_PRF     — secret name for WebAuthn PRF secret
 */

import type { KeyName } from "./types";
import { BaseCloudKeyProvider, type CloudProviderConfig } from "./base-cloud-provider";

interface GcpSmConfig extends CloudProviderConfig {
  projectId: string;
}

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
let smModuleLoader: () => Promise<GcpSmModule> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return req("@google-cloud/secret-manager") as GcpSmModule;
};

export function _setGcpSmModuleLoader(loader: typeof smModuleLoader): void {
  smModuleLoader = loader;
}

function getSmModule(): Promise<GcpSmModule> {
  if (!smModulePromise) {
    smModulePromise = smModuleLoader().catch((err) => {
      throw new Error(
        `@google-cloud/secret-manager is required for KEY_PROVIDER=gcp-sm. ` +
        `Install it with: npm install @google-cloud/secret-manager. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return smModulePromise;
}

export function _resetGcpSmModuleCache(): void {
  smModulePromise = null;
}

export class GcpSmKeyProvider extends BaseCloudKeyProvider {
  readonly name = "gcp-sm";
  private projectId: string;
  private smClient: SmClient | null = null;

  protected readonly secretNameEnvMap: Record<KeyName, string> = {
    "share-master": "GCP_SM_SECRET_SHARE_MASTER",
    "verifier-pepper": "GCP_SM_SECRET_VERIFIER_PEPPER",
    "directory-sync": "GCP_SM_SECRET_DIRECTORY_SYNC",
    "webauthn-prf": "GCP_SM_SECRET_WEBAUTHN_PRF",
  };

  protected readonly defaultSecretNames: Record<KeyName, string> = {
    "share-master": "share-master-key",
    "verifier-pepper": "verifier-pepper-key",
    "directory-sync": "directory-sync-key",
    "webauthn-prf": "webauthn-prf-secret",
  };

  constructor(config: GcpSmConfig) {
    super(config);
    this.projectId = config.projectId;
  }

  protected validateConfig(): void {
    if (!this.projectId) {
      throw new Error("GCP_PROJECT_ID is required for KEY_PROVIDER=gcp-sm");
    }
  }

  protected async fetchSecret(name: KeyName, version?: number): Promise<Buffer> {
    const secretName = this.resolveSecretName(name, version);
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

    const value = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    return this.validateHex64(value, secretName);
  }
}
