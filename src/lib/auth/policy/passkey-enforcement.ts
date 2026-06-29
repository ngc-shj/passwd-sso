import type { Prisma } from "@prisma/client";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/constants/time";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

// ─── Grace-period decision ────────────────────────────────────────────────────

/**
 * Returns true if the passkey grace period has expired (or was never set),
 * meaning enforcement should block the user.
 *
 * Semantics:
 *  - No enabledAt timestamp → treat as immediate enforcement (true).
 *  - No grace period configured (null/0) → immediate enforcement (true).
 *  - Otherwise: expired iff `now > enabledAt + graceDays * MS_PER_DAY`.
 *
 * MOVED verbatim from src/lib/proxy/page-route.ts.
 */
export function isPasskeyGracePeriodExpired(
  requirePasskeyEnabledAt: string | null | undefined,
  passkeyGracePeriodDays: number | null | undefined,
): boolean {
  // No enabledAt timestamp means enforcement was just turned on; treat as immediate.
  if (!requirePasskeyEnabledAt) return true;
  // No grace period configured means immediate enforcement.
  if (passkeyGracePeriodDays == null || passkeyGracePeriodDays <= 0) return true;

  const enabledAt = new Date(requirePasskeyEnabledAt).getTime();
  const gracePeriodMs = passkeyGracePeriodDays * MS_PER_DAY;
  return Date.now() > enabledAt + gracePeriodMs;
}

/**
 * Returns true iff passkey enforcement should block the given passkey state.
 *
 * This is the page-route condition MINUS the path-exempt check.
 * Every token-issuance gate uses this instead of re-implementing the logic.
 */
export function passkeyEnforcementBlocks(p: {
  requirePasskey?: boolean;
  hasPasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
}): boolean {
  return (
    !!p.requirePasskey &&
    !p.hasPasskey &&
    isPasskeyGracePeriodExpired(p.requirePasskeyEnabledAt, p.passkeyGracePeriodDays)
  );
}

// ─── DB re-derivation ─────────────────────────────────────────────────────────

/**
 * Fresh, fail-closed DB re-derivation of passkey state for a given user + tenant.
 *
 * Called by every TOKEN-ISSUANCE gate (C2/C3/C6/C8) instead of reading the
 * possibly-stale session snapshot.
 *
 * - `hasPasskey`: derived from `webAuthnCredential.count({ where: { userId } })`.
 *   Counted by userId ONLY — passkeys are user-global, not tenant-scoped.
 * - `requirePasskey`, `requirePasskeyEnabledAt`, `passkeyGracePeriodDays`: read
 *   from `tenant.findUnique({ where: { id: tenantId } })`.
 * - `requirePasskeyEnabledAt` is converted via `.toISOString()` (Prisma returns
 *   `Date | null`; callers receive `string | null`).
 *
 * RLS context:
 *  - When `params.tx` is provided (caller already holds a `withBypassRls`
 *    transaction), it is used directly — no new bypass is opened.
 *  - When no `tx` is provided, a new `withBypassRls(..., BYPASS_PURPOSE.AUTH_FLOW)`
 *    transaction is opened (matching the pattern in auth.ts:400/418).
 *
 * FAIL-CLOSED (S13): this helper does NOT catch DB errors. It throws on failure;
 * every caller treats a throw as fail-closed (refuse issuance — no token).
 */
export async function derivePasskeyState(params: {
  userId: string;
  tenantId: string;
  tx?: Prisma.TransactionClient;
}): Promise<{
  requirePasskey: boolean;
  hasPasskey: boolean;
  requirePasskeyEnabledAt: string | null;
  passkeyGracePeriodDays: number | null;
}> {
  const run = async (tx: Prisma.TransactionClient) => {
    const [credCount, tenant] = await Promise.all([
      tx.webAuthnCredential.count({ where: { userId: params.userId } }),
      tx.tenant.findUnique({
        where: { id: params.tenantId },
        select: {
          requirePasskey: true,
          requirePasskeyEnabledAt: true,
          passkeyGracePeriodDays: true,
        },
      }),
    ]);
    return { credCount, tenant };
  };

  const { credCount, tenant } = params.tx
    ? await run(params.tx)
    : await withBypassRls(prisma, run, BYPASS_PURPOSE.AUTH_FLOW);

  return {
    hasPasskey: credCount > 0,
    requirePasskey: tenant?.requirePasskey ?? false,
    requirePasskeyEnabledAt: tenant?.requirePasskeyEnabledAt?.toISOString() ?? null,
    passkeyGracePeriodDays: tenant?.passkeyGracePeriodDays ?? null,
  };
}

// ─── Audit dedup ──────────────────────────────────────────────────────────────

// Deduplicate passkey audit emit — track composite key (userId:blockedPath) +
// timestamp, skip if emitted within 5 min for the same user+path combination.
// Keyed by user+path so each path's first block within the window emits
// independently (prevents OWASP A09 under-reporting when a user is blocked
// across multiple paths simultaneously).
export const PASSKEY_AUDIT_DEDUP_MS = 5 * MS_PER_MINUTE;
export const PASSKEY_AUDIT_MAP_MAX = 1000;
// Module-private — direct mutation of this Map from outside the module would
// allow attacker-influenced suppression of passkey-enforcement audit events.
// Tests use the sanctioned _*ForTests helpers below.
const passkeyAuditEmitted = new Map<string, number>();

/**
 * @internal Test-only — clears the passkey-audit dedup map.
 * Use in `beforeEach` to isolate tests from each other.
 */
export function _resetPasskeyAuditForTests(): void {
  passkeyAuditEmitted.clear();
}

/** @internal Test-only — size probe for the passkey-audit dedup map. */
export function _passkeyAuditSizeForTests(): number {
  return passkeyAuditEmitted.size;
}

/**
 * @internal Test-only — membership probe for the passkey-audit dedup map.
 * Probes the composite key `${userId}:${blockedPath}`.
 */
export function _passkeyAuditHasForTests(userId: string, blockedPath: string): boolean {
  return passkeyAuditEmitted.has(`${userId}:${blockedPath}`);
}

/**
 * @internal Test-only — returns the first (oldest by recency) key in the
 * passkey-audit dedup map, or undefined if empty. Used to verify staleness
 * eviction order.
 */
export function _passkeyAuditFirstKeyForTests(): string | undefined {
  return passkeyAuditEmitted.keys().next().value;
}

/**
 * Record a passkey-enforcement audit emit for `userId` + `blockedPath` at `now`.
 * Returns `true` if the caller should fire the audit, `false` if the same
 * user+path has already been audited within `PASSKEY_AUDIT_DEDUP_MS`.
 *
 * The dedup key is `${userId}:${blockedPath}` (changed from bare userId —
 * round-3 S14). With 4+ gated paths, per-userId-only dedup suppressed a real
 * multi-path block as a single audit row (OWASP A09 under-reporting).
 *
 * Eviction is staleness-based, not insertion-order: when the dedup map is
 * full, the entry whose `lastEmitted` is oldest is evicted. This is achieved
 * by `delete`-then-`set` on every accepted emit so JS Map insertion order
 * (which is what `keys().next()` returns) tracks last-emit recency rather
 * than first-emit time.
 *
 * Boundary: `now - lastEmitted === PASSKEY_AUDIT_DEDUP_MS` deduplicates
 * (the inclusive `<=` window matches "within 5 minutes"). The original
 * inline form used the exclusive `>` form, which would fire at exactly the
 * boundary; the 1 ms shift here is intentional and tested at
 * `proxy.test.ts` `passkeyAuditEmitted staleness eviction` describe block.
 */
export function recordPasskeyAuditEmit(
  userId: string,
  blockedPath: string,
  nowMs: number,
): boolean {
  const key = `${userId}:${blockedPath}`;
  const lastEmitted = passkeyAuditEmitted.get(key);
  // Use !== undefined rather than truthy check so a literal-zero timestamp
  // (theoretically possible if an alternate clock source is ever wired in)
  // does not bypass dedup as if it were a first emit.
  if (lastEmitted !== undefined && nowMs - lastEmitted <= PASSKEY_AUDIT_DEDUP_MS) {
    return false;
  }
  // Refresh insertion order so the head is always the staleness candidate.
  passkeyAuditEmitted.delete(key);
  if (passkeyAuditEmitted.size >= PASSKEY_AUDIT_MAP_MAX) {
    const oldest = passkeyAuditEmitted.keys().next().value;
    if (oldest !== undefined) passkeyAuditEmitted.delete(oldest);
  }
  passkeyAuditEmitted.set(key, nowMs);
  return true;
}
