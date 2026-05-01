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
 *   AWS_SM_SECRET_SHARE_MASTER          — secret name/ARN (default: "passwd-sso/share-master-key")
 *   AWS_SM_SECRET_VERIFIER_PEPPER       — secret name/ARN for verifier pepper
 *   AWS_SM_SECRET_DIRECTORY_SYNC        — secret name/ARN for directory sync key
 *   AWS_SM_SECRET_WEBAUTHN_PRF          — secret name/ARN for WebAuthn PRF secret
 *   AWS_SM_SECRET_AUDIT_ANCHOR_SIGNING      — secret name/ARN for audit anchor signing key
 *   AWS_SM_SECRET_AUDIT_ANCHOR_TAG_SECRET   — secret name/ARN for audit anchor tag secret
 */

import type { KeyName } from "./types";
import { BaseCloudKeyProvider, type CloudProviderConfig } from "./base-cloud-provider";

interface AwsSmConfig extends CloudProviderConfig {
  region: string;
}

// Types for the subset of @aws-sdk/client-secrets-manager we use
interface SmGetResult { SecretString?: string }
interface SmClient { send(command: unknown): Promise<SmGetResult> }
interface AwsSmModule {
  SecretsManagerClient: new (config: { region: string }) => SmClient;
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
}

let smModulePromise: Promise<AwsSmModule> | null = null;
let smModuleLoader: () => Promise<AwsSmModule> = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module");
  const req = createRequire(__filename);
  return req("@aws-sdk/client-secrets-manager") as AwsSmModule;
};

export function _setAwsSmModuleLoader(loader: typeof smModuleLoader): void {
  smModuleLoader = loader;
}

function getSmModule(): Promise<AwsSmModule> {
  if (!smModulePromise) {
    smModulePromise = smModuleLoader().catch((err) => {
      throw new Error(
        `@aws-sdk/client-secrets-manager is required for KEY_PROVIDER=aws-sm. ` +
        `Install it with: npm install @aws-sdk/client-secrets-manager. ` +
        `Original error: ${err instanceof Error ? err.message : err}`
      );
    });
  }
  return smModulePromise;
}

export function _resetAwsSmModuleCache(): void {
  smModulePromise = null;
}

export class AwsSmKeyProvider extends BaseCloudKeyProvider {
  readonly name = "aws-sm";
  private region: string;
  private smClient: SmClient | null = null;

  protected readonly secretNameEnvMap: Record<KeyName, string> = {
    "share-master": "AWS_SM_SECRET_SHARE_MASTER",
    "verifier-pepper": "AWS_SM_SECRET_VERIFIER_PEPPER",
    "directory-sync": "AWS_SM_SECRET_DIRECTORY_SYNC",
    "webauthn-prf": "AWS_SM_SECRET_WEBAUTHN_PRF",
    "audit-anchor-signing": "AWS_SM_SECRET_AUDIT_ANCHOR_SIGNING",
    "audit-anchor-tag-secret": "AWS_SM_SECRET_AUDIT_ANCHOR_TAG_SECRET",
  };

  protected readonly defaultSecretNames: Record<KeyName, string> = {
    "share-master": "passwd-sso/share-master-key",
    "verifier-pepper": "passwd-sso/verifier-pepper-key",
    "directory-sync": "passwd-sso/directory-sync-key",
    "webauthn-prf": "passwd-sso/webauthn-prf-secret",
    "audit-anchor-signing": "passwd-sso/audit-anchor-signing-key",
    "audit-anchor-tag-secret": "passwd-sso/audit-anchor-tag-secret",
  };

  constructor(config: AwsSmConfig) {
    super(config);
    this.region = config.region;
  }

  protected validateConfig(): void {
    if (!this.region) {
      throw new Error("AWS_REGION is required for KEY_PROVIDER=aws-sm");
    }
  }

  protected async fetchSecret(name: KeyName, version?: number): Promise<Buffer> {
    const secretName = this.resolveSecretName(name, version);

    const mod = await getSmModule();
    if (!this.smClient) {
      this.smClient = new mod.SecretsManagerClient({ region: this.region });
    }

    const result = await this.smClient.send(
      new mod.GetSecretValueCommand({ SecretId: secretName })
    );

    if (!result.SecretString) {
      throw new Error(`AWS Secrets Manager secret "${secretName}" has no SecretString`);
    }

    return this.validateHex64(result.SecretString, secretName);
  }
}
