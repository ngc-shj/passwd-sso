/**
 * Names of the owner-shaped probe roles the RDS-shaped cells connect as
 * (rds-probe-role.ts). Roles are cluster-global, so a run that dies before its
 * `finally` leaves its probe behind; the name carries its creation time so the
 * next run can drop such leftovers without touching a probe a concurrent run
 * on the same cluster still holds.
 */
import { MS_PER_HOUR } from "@/lib/constants/time";

export const PROBE_ROLE_PREFIX = "rls_probe_";

/** A probe older than this is a leftover of a run that never reached its `finally`. */
export const PROBE_ROLE_MAX_AGE_MS = MS_PER_HOUR;

const PROBE_NAME_RE = /^rls_probe_(\d{13})_[0-9a-f]{12}$/;

export function probeRoleName(now: number, randomHex: string): string {
  return `${PROBE_ROLE_PREFIX}${now}_${randomHex}`;
}

/**
 * The roles in `names` that are probes older than `maxAgeMs` at `now`. A name
 * that does not match the exact shape is never selected: another tool's role
 * that happens to share the prefix is not ours to drop.
 */
export function staleProbeRoles(
  names: readonly string[],
  now: number,
  maxAgeMs: number = PROBE_ROLE_MAX_AGE_MS,
): string[] {
  return names.filter((name) => {
    const match = PROBE_NAME_RE.exec(name);
    return match !== null && now - Number(match[1]) > maxAgeMs;
  });
}
