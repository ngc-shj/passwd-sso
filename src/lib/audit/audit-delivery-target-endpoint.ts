import { getMasterKeyByVersion, decryptServerData } from "@/lib/crypto/crypto-server";
import { maskUrlForDisplay } from "@/lib/url/url-validation";

/** AAD binding a delivery target's encrypted config to its id and tenant (create, list, worker). */
export function deliveryTargetAad(targetId: string, tenantId: string): Buffer {
  return Buffer.concat([
    Buffer.from(targetId.replace(/-/g, ""), "hex"),
    Buffer.from(tenantId.replace(/-/g, ""), "hex"),
  ]);
}

/**
 * The masked destination of an audit delivery target, read from its encrypted
 * config. Secrets (webhook secret, HEC token, S3 access keys) are never
 * returned — only the URL/endpoint, which is destination metadata the admin
 * supplied at create time.
 *
 * Null on any decrypt or parse failure (missing master key version, AAD
 * mismatch, corruption): the row stays visible without its endpoint rather
 * than failing the whole list. The worker surfaces the same error via lastError.
 */
export function deliveryTargetEndpoint(
  row: {
    id: string;
    masterKeyVersion: number;
    configEncrypted: string;
    configIv: string;
    configAuthTag: string;
  },
  tenantId: string,
): string | null {
  try {
    const masterKey = getMasterKeyByVersion(row.masterKeyVersion);
    const configJson = decryptServerData(
      { ciphertext: row.configEncrypted, iv: row.configIv, authTag: row.configAuthTag },
      masterKey,
      deliveryTargetAad(row.id, tenantId),
    );
    const config = JSON.parse(configJson) as { url?: string; endpoint?: string };
    const raw = config.url ?? config.endpoint ?? null;
    return raw ? maskUrlForDisplay(raw) : null;
  } catch {
    return null;
  }
}
