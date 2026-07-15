/**
 * Server-only durable-webhook-delivery lease constants.
 *
 * SEPARATED from @/lib/constants/audit/audit because the batch-size derivation
 * imports DNS_RESOLVE_TIMEOUT_MS from @/lib/http/external-http, which pulls in
 * node:dns/promises. `audit.ts` is imported by Client Components (e.g. the
 * tenant/team webhook settings cards read AUDIT_ACTION labels), and Next.js
 * cannot bundle node:dns into a client chunk — so these worker-only values must
 * live in a file the client graph never reaches. Only the audit-outbox worker
 * (and its tests) import this module.
 */

import { MS_PER_MINUTE } from "@/lib/constants/time";
import { envInt } from "@/lib/env/env-utils";
import {
  WEBHOOK_DELIVERY_CONCURRENCY,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_FETCH_TIMEOUT_MS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "@/lib/validations/common.server";
import { DNS_RESOLVE_TIMEOUT_MS } from "@/lib/http/external-http";

const OUTBOX_PROCESSING_TIMEOUT_MS = envInt("OUTBOX_PROCESSING_TIMEOUT_MS", 5 * MS_PER_MINUTE);

// Worst-case wall-clock a single unreachable webhook can hold the claim lease:
// every attempt (WEBHOOK_MAX_RETRIES) hits the bounded DNS resolution deadline
// (resolveAndValidateIps re-resolves per attempt; A + AAAA run concurrently under
// ONE DNS_RESOLVE_TIMEOUT_MS deadline) THEN the full fetch timeout, plus the
// inter-attempt backoffs. DNS is now bounded, so this is a real ceiling, not an
// estimate that silently excludes DNS. DB callback time is negligible (short leaf
// transactions) and covered by the ÷2 safety margin in the batch size below.
export const WEBHOOK_WORST_CASE_PER_ITEM_MS =
  WEBHOOK_MAX_RETRIES * (DNS_RESOLVE_TIMEOUT_MS + WEBHOOK_FETCH_TIMEOUT_MS) +
  WEBHOOK_RETRY_DELAYS_MS.slice(0, WEBHOOK_MAX_RETRIES - 1).reduce((a, b) => a + b, 0);

// processWebhookDeliveryBatch processes claimed work items in parallel chunks of
// WEBHOOK_DELIVERY_CONCURRENCY, so the batch's serial depth is
// ceil(batch / WEBHOOK_DELIVERY_CONCURRENCY) chunks. Bound the batch so that
// serial worst case (chunks × worstCasePerItem) stays under half the PROCESSING
// timeout; otherwise the reaper resets still-in-flight rows and a second worker
// re-claims them → duplicate + concurrent delivery. Solving
// ceil(batch/C) × perItem ≤ TIMEOUT/2 for batch gives
// batch = C × floor(TIMEOUT/2 / perItem). Floor of 1 so the queue always drains.
export const WEBHOOK_DELIVERY_BATCH_SIZE = Math.max(
  1,
  WEBHOOK_DELIVERY_CONCURRENCY *
    Math.floor(OUTBOX_PROCESSING_TIMEOUT_MS / 2 / WEBHOOK_WORST_CASE_PER_ITEM_MS),
);

/**
 * Fail-closed lease-vs-delivery guard. The Math.max(1,…) floor above still
 * claims one work item even when the configured PROCESSING timeout is too small
 * to hold a single item's worst-case delivery — in which case the reaper resets
 * the in-flight row mid-delivery and a second worker re-claims it (duplicate +
 * concurrent delivery), the exact hazard the batch bound exists to prevent.
 * OUTBOX_PROCESSING_TIMEOUT_MS is operator-configurable down to 10s (below the
 * per-item worst case), so validate and refuse to run rather than silently
 * violate the lease.
 *
 * Pure over its `timeoutMs` argument so callers (worker startup AND env
 * validation) can check any candidate timeout, and tests can exercise the reject
 * boundary directly. Defaults to the configured OUTBOX_PROCESSING_TIMEOUT_MS.
 * Returns an error message when unsafe, or null when the timeout can hold at
 * least one item within the ÷2 margin.
 */
export function validateWebhookDeliveryLease(
  timeoutMs: number = OUTBOX_PROCESSING_TIMEOUT_MS,
): string | null {
  const safeTimeout = timeoutMs / 2;
  if (safeTimeout < WEBHOOK_WORST_CASE_PER_ITEM_MS) {
    return (
      `OUTBOX_PROCESSING_TIMEOUT_MS=${timeoutMs}ms is too small for durable webhook ` +
      `delivery: one work item's worst case is ${WEBHOOK_WORST_CASE_PER_ITEM_MS}ms and the ` +
      `delivery batch may hold the claim lease for up to half the timeout (${safeTimeout}ms). ` +
      `Set OUTBOX_PROCESSING_TIMEOUT_MS to at least ${2 * WEBHOOK_WORST_CASE_PER_ITEM_MS}ms.`
    );
  }
  return null;
}
