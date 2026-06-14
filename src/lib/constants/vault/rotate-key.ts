import { MS_PER_MINUTE } from "../time";

/** Prisma transaction timeout for full vault key rotation (2 minutes). */
export const VAULT_ROTATE_TX_TIMEOUT_MS = 2 * MS_PER_MINUTE;
