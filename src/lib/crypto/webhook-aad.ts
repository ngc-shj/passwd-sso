/**
 * AAD construction for AES-GCM-encrypted webhook secrets (C9).
 *
 * Defense properties (per S8 + S9 + F14):
 *  - Table identity prefix prevents a TenantWebhook ciphertext from being
 *    swapped into a TeamWebhook row (or vice versa) at the DB layer.
 *  - secretAadVersion in AAD prevents a v2→v1 downgrade attack: flipping
 *    the version column on a v2 row to 1 (so the decrypt branches to the
 *    no-AAD legacy path) leaves the GCM tag mismatched against the
 *    original v2-bound AAD, and decrypt fails.
 *  - UTF-8 encoding (NOT hex-stripped UUID bytes) is tolerant of future
 *    UUID format changes (e.g., uuid-v7) and validates input strictly.
 *
 * The helper throws on malformed UUID input rather than silently
 * producing a wrong-shape AAD that would round-trip on both sides.
 */

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookKind = "TenantWebhook" | "TeamWebhook";

export interface WebhookSecretAADArgs {
  tableName: WebhookKind;
  version: number;
  webhookId: string;
  tenantId: string;
  /** Required for TeamWebhook; omitted (undefined) for TenantWebhook. */
  teamId?: string | null;
}

function assertCanonicalUuid(value: string, field: string): void {
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new Error(
      `webhook-aad: ${field} is not a canonical UUID (got length ${value.length})`,
    );
  }
}

export function buildWebhookSecretAAD(args: WebhookSecretAADArgs): Buffer {
  const { tableName, version, webhookId, tenantId, teamId } = args;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`webhook-aad: version must be a positive integer (got ${version})`);
  }
  if (tableName !== "TenantWebhook" && tableName !== "TeamWebhook") {
    throw new Error(`webhook-aad: unknown tableName ${tableName}`);
  }
  assertCanonicalUuid(webhookId, "webhookId");
  assertCanonicalUuid(tenantId, "tenantId");
  if (tableName === "TeamWebhook") {
    if (!teamId) {
      throw new Error("webhook-aad: TeamWebhook requires teamId");
    }
    assertCanonicalUuid(teamId, "teamId");
  } else if (teamId) {
    throw new Error("webhook-aad: TenantWebhook must not have a teamId");
  }

  // Format: "TableName|vN|webhookId|tenantId|teamId" — teamId omitted (no
  // trailing |) for TenantWebhook. Pipe delimiter avoids overlap with any
  // UUID byte. UTF-8 encoded → stable across UUID format changes.
  const parts = [tableName, `v${version}`, webhookId, tenantId];
  if (teamId) parts.push(teamId);
  return Buffer.from(parts.join("|"), "utf8");
}

/** Current AAD version emitted on new writes. */
export const WEBHOOK_SECRET_AAD_VERSION_CURRENT = 2;
