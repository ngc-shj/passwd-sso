import { buildTeamEntryAAD, type VaultType } from "@/lib/crypto/crypto-aad";

/**
 * Client-side team key resolution shared by the vault context and the
 * React-free rotation / re-key builders
 * (docs/archive/review/team-key-rotation-rekey-plan.md C3).
 */

/**
 * Why a team key version could not be resolved:
 * - `not_available`: the member holds no key at that version (404
 *   MEMBER_KEY_NOT_FOUND, or the server answered with another version).
 * - `transient`: network / 5xx / missing local vault state — may succeed on
 *   retry, and is never evidence about the key itself.
 * - `key_invalid`: the member's own key row at that version exists but fails
 *   to unwrap (AES-GCM authentication failure). Old versions cannot be
 *   redistributed, so another holder of the version has to act.
 */
export const TEAM_KEY_FAILURE = {
  NOT_AVAILABLE: "not_available",
  TRANSIENT: "transient",
  KEY_INVALID: "key_invalid",
} as const;

export type TeamKeyFailureReason = (typeof TEAM_KEY_FAILURE)[keyof typeof TEAM_KEY_FAILURE];

export type TeamKeyResolution = { key: CryptoKey } | { reason: TeamKeyFailureReason };

/** Resolves the team encryption key at a (normalised) team key version. */
export type ResolveTeamKey = (teamKeyVersion: number) => Promise<TeamKeyResolution>;

/** Team key versions below 1 are version 1 everywhere (legacy schema default). */
export function normalizeTeamKeyVersion(version: number): number {
  return version < 1 ? 1 : version;
}

/**
 * True for an AES-GCM authentication failure: Web Crypto rejects a decrypt
 * whose tag does not verify with an `OperationError` DOMException. Anything
 * else (a malformed input, a missing key) is not evidence about the
 * ciphertext.
 */
export function isAesGcmAuthFailure(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name: unknown }).name === "OperationError"
  );
}

/**
 * The AAD a team entry blob / overview is sealed with: none for rows written
 * before AAD binding (`aadVersion` 0), else the team entry AAD at the row's
 * ItemKey version.
 */
export function teamEntryAadFor(
  teamId: string,
  entryId: string,
  vaultType: VaultType,
  itemKeyVersion: number,
  aadVersion: number,
): Uint8Array | undefined {
  return aadVersion >= 1
    ? buildTeamEntryAAD(teamId, entryId, vaultType, itemKeyVersion)
    : undefined;
}

/**
 * Whether an entry awaits the re-key pass: its ItemKey was created under an
 * older team key, or it holds an ItemKey of unknown identity (v1+ with a
 * NULL id — written by an instance of the previous release during rollout,
 * which neither mints the id nor sets the marker). The re-key mints the id.
 */
export function isRekeyPending(
  entry: { itemKeyVersion: number; itemKeyId?: string | null; itemKeyTeamKeyVersion: number },
  teamKeyVersion: number,
): boolean {
  return entry.itemKeyTeamKeyVersion < teamKeyVersion || (entry.itemKeyVersion >= 1 && entry.itemKeyId == null);
}

/**
 * The single comparison of two ItemKey ids, client and server (team-item-key.ts
 * re-exports it). NULL never matches — not even NULL against NULL: an unknown
 * ItemKey is never "the same" as another one.
 */
export function itemKeyIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}
