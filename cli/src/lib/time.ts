/** Milliseconds per second. */
export const MS_PER_SECOND = 1_000;

/** Milliseconds per minute. */
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Milliseconds per day. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Timeout for agent child process acknowledgement (agent-decrypt, agent, decrypt). */
export const AGENT_CHILD_TIMEOUT_MS = 10 * MS_PER_SECOND;

/** Polling interval for vault lock check in agent foreground mode. */
export const VAULT_LOCK_POLL_INTERVAL_MS = 5 * MS_PER_SECOND;
