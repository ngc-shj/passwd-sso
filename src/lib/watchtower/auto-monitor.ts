// Auto-monitor logic for dark-web continuous monitoring.
// Pure functions — no side effects, no React dependencies.

import { MS_PER_DAY } from "@/lib/constants/time";

const CHECK_INTERVAL_MS = MS_PER_DAY;

// ── localStorage keys ──

export const LS_LAST_BREACH_CHECK_AT = "watchtower:lastBreachCheckAt";
export const LS_AUTO_MONITOR_ENABLED = "watchtower:autoMonitorEnabled";
export const LS_LAST_KNOWN_BREACH_COUNT = "watchtower:lastKnownBreachCount";

// ── Pure functions ──

export interface ShouldAutoCheckOpts {
  lastCheckAt: number | null;
  now: number;
  enabled: boolean;
  vaultUnlocked: boolean;
}

/**
 * Determine if auto-check should run.
 * Takes `now` as argument so tests don't need vi.useFakeTimers().
 */
export function shouldAutoCheck(opts: ShouldAutoCheckOpts): boolean {
  if (!opts.enabled) return false;
  if (!opts.vaultUnlocked) return false;
  if (opts.lastCheckAt === null) return true;
  return opts.now - opts.lastCheckAt >= CHECK_INTERVAL_MS;
}

/**
 * Determine if there are new breaches by comparing current count
 * with the last known count.
 */
export function hasNewBreaches(
  currentBreachCount: number,
  lastKnownBreachCount: number,
): boolean {
  return currentBreachCount > lastKnownBreachCount;
}
