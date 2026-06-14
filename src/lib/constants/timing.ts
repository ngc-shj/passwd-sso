import { MS_PER_SECOND, MS_PER_MINUTE } from "@/lib/constants/time";

/** Timeout before auto-hiding revealed sensitive fields (30 seconds) */
export const REVEAL_TIMEOUT_MS = 30 * MS_PER_SECOND;

/** Timeout before auto-clearing clipboard content (30 seconds) */
export const CLIPBOARD_CLEAR_TIMEOUT_MS = 30 * MS_PER_SECOND;

/** Minimum interval between watchtower security scans. */
export const WATCHTOWER_COOLDOWN_MS = 5 * MS_PER_MINUTE;
