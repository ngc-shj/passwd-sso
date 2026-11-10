import { MS_PER_SECOND } from "../time";

/**
 * Prisma transaction timeout for a tenant admin's member passkey revoke (#974,
 * #1016). With containment it writes up to MEMBER_CONTAINMENT_MAX_IDS rows of
 * each of seven kinds — one bulk statement per kind, the emergency-access
 * grants one by one through the state machine — after the member's sessions
 * and tokens, so Prisma's 5s default is not a budget sized for it.
 */
export const MEMBER_PASSKEY_REVOKE_TX_TIMEOUT_MS = 15 * MS_PER_SECOND;
