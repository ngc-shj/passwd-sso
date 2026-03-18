import type { KeyProvider } from "./types";
export type { KeyName, KeyProvider } from "./types";

let _provider: KeyProvider | null = null;

export async function getKeyProvider(): Promise<KeyProvider> {
  if (_provider) return _provider;

  const providerType = process.env.KEY_PROVIDER || "env";

  switch (providerType) {
    case "env": {
      const { EnvKeyProvider } = await import("./env-provider");
      _provider = new EnvKeyProvider();
      break;
    }
    case "aws-kms": {
      const { AwsKmsKeyProvider } = await import("./aws-kms-provider");
      _provider = new AwsKmsKeyProvider({
        region: process.env.AWS_REGION!,
        ttlMs: process.env.KMS_CACHE_TTL_MS
          ? Number(process.env.KMS_CACHE_TTL_MS)
          : undefined,
      });
      break;
    }
    default:
      throw new Error(`Unknown KEY_PROVIDER: ${providerType}`);
  }

  return _provider!;
}

export function getKeyProviderSync(): KeyProvider {
  if (!_provider) {
    throw new Error("KeyProvider not initialized. Call getKeyProvider() at startup.");
  }
  return _provider;
}

/** Reset singleton — for testing only. */
export function _resetKeyProvider(): void {
  _provider = null;
}
