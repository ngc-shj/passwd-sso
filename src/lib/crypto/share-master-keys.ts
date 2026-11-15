/**
 * Loading the `share-master` key versions a process outside the app is about to
 * use — an operator script, a worker — before it uses them.
 *
 * `account-token-crypto` reads keys through `getKeyProviderSync()`. With a
 * cloud `KEY_PROVIDER` that throws until `getKeyProvider()` has run, and then
 * serves only the versions fetched since: `getKey` caches an entry, refetches it
 * once it is older than the provider's TTL, and `getKeySync` throws on a miss or
 * past the stale limit. The app warms the current version at boot
 * (`instrumentation.ts`); a script or a worker runs no such boot, so it warms
 * here. The env provider needs none of this and passes through.
 *
 * Prisma-free, so `tenant-domain` can import it on MIGRATION_DATABASE_URL
 * alone.
 */

import { getKeyProvider } from "@/lib/key-provider";
import { getCurrentMasterKeyVersion } from "@/lib/crypto/crypto-server";
import { isEncryptedEnvelope, parseEnvelope } from "@/lib/crypto/envelope";

export const KEY_WARM_STATUS = {
  OK: "ok",
  UNAVAILABLE: "unavailable",
} as const;

export type KeyWarmStatus = (typeof KEY_WARM_STATUS)[keyof typeof KEY_WARM_STATUS];

/**
 * Fetch each given version and the current one, each on its own, and report
 * which loaded. A version that fails is reported, not thrown: the caller knows
 * which stored values it guards and refuses with them named. A provider that
 * cannot be initialised at all (an unknown `KEY_PROVIDER`, a missing region or
 * vault URL, an invalid current version) reports every given version
 * unavailable rather than throwing: its message names configuration, and the
 * worker stores what this throws in a tenant-readable delivery error.
 */
export async function warmShareMasterKeys(versions: Iterable<number>): Promise<Map<number, KeyWarmStatus>> {
  const wanted = new Set<number>(versions);
  const report = new Map<number, KeyWarmStatus>();
  let provider: Awaited<ReturnType<typeof getKeyProvider>>;
  try {
    provider = await getKeyProvider();
    wanted.add(getCurrentMasterKeyVersion());
  } catch {
    for (const version of wanted) report.set(version, KEY_WARM_STATUS.UNAVAILABLE);
    return report;
  }
  for (const version of [...wanted].sort((a, b) => a - b)) {
    try {
      await provider.getKey("share-master", version);
      report.set(version, KEY_WARM_STATUS.OK);
    } catch {
      // The provider's message can name a secret path or a vault URL; the
      // caller prints the version only.
      report.set(version, KEY_WARM_STATUS.UNAVAILABLE);
    }
  }
  return report;
}

/** The key version a stored envelope names, or null for a value that is not one. */
export function envelopeVersionOf(value: string | null | undefined): number | null {
  // `parseEnvelope` does not check the sentinel itself.
  if (value == null || !isEncryptedEnvelope(value)) return null;
  try {
    return parseEnvelope(value).version;
  } catch {
    return null;
  }
}

/**
 * The key versions the stored envelopes name. A value that is not an envelope
 * names none; whoever decrypts it reports it as corrupt.
 */
export function collectEnvelopeVersions(values: Iterable<string | null | undefined>): Set<number> {
  const versions = new Set<number>();
  for (const value of values) {
    const version = envelopeVersionOf(value);
    if (version !== null) versions.add(version);
  }
  return versions;
}
