/** pg.Pool idleTimeoutMillis — release idle connections after 30 s. */
export const WORKER_POOL_IDLE_TIMEOUT_MS = 30_000;

/** pg.Pool statement_timeout — cancel runaway queries after 60 s. */
export const WORKER_POOL_STATEMENT_TIMEOUT_MS = 60_000;
