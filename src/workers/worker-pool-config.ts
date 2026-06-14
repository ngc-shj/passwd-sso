import { MS_PER_SECOND } from "@/lib/constants/time";

/** pg.Pool idleTimeoutMillis — release idle connections after 30 s. */
export const WORKER_POOL_IDLE_TIMEOUT_MS = 30 * MS_PER_SECOND;

/** pg.Pool statement_timeout — cancel runaway queries after 60 s. */
export const WORKER_POOL_STATEMENT_TIMEOUT_MS = 60 * MS_PER_SECOND;
