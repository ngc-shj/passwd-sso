/**
 * Database helper for seeding EmergencyAccessGrant rows in E2E tests.
 *
 * Supports seeding a grant at any state in the emergency access state machine:
 *   PENDING → ACCEPTED → IDLE → REQUESTED → ACTIVATED
 *
 * The token_hash is deterministic so tests can reference it if needed.
 */
import { createHash } from "node:crypto";
import { E2E_TENANT, getPool } from "./db";

export interface SeedEmergencyGrantOptions {
  id: string;
  ownerId: string;
  granteeId: string;
  granteeEmail: string;
  tenantId?: string;
  status: "PENDING" | "ACCEPTED" | "IDLE" | "STALE" | "REQUESTED" | "ACTIVATED" | "REVOKED" | "REJECTED";
  waitDays: number;
  /** If status is REQUESTED, set wait_expires_at this many days in the future (default: waitDays) */
  waitExpiresInDays?: number;
}

export async function seedEmergencyGrant(
  options: SeedEmergencyGrantOptions
): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const now = new Date();

  // Deterministic token derived from the grant ID so tests can reproduce it
  const rawToken = createHash("sha256")
    .update("e2e-ea-token:")
    .update(options.id)
    .digest("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // Token expires 7 days from now (acceptance window)
  const tokenExpiresAt = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  // State-dependent timestamps
  let requestedAt: string | null = null;
  let activatedAt: string | null = null;
  let waitExpiresAt: string | null = null;

  if (
    options.status === "REQUESTED" ||
    options.status === "ACTIVATED"
  ) {
    requestedAt = new Date(
      now.getTime() - 1 * 60 * 60 * 1000 // 1 hour ago
    ).toISOString();

    const waitDaysEffective =
      options.waitExpiresInDays ?? options.waitDays;
    waitExpiresAt = new Date(
      now.getTime() + waitDaysEffective * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  if (options.status === "ACTIVATED") {
    activatedAt = now.toISOString();
  }

  await p.query(
    `INSERT INTO emergency_access_grants (
      id, tenant_id, owner_id, grantee_id, grantee_email,
      status, wait_days,
      token_hash, token_expires_at,
      requested_at, activated_at, wait_expires_at,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      owner_id = EXCLUDED.owner_id,
      grantee_id = EXCLUDED.grantee_id,
      grantee_email = EXCLUDED.grantee_email,
      status = EXCLUDED.status,
      wait_days = EXCLUDED.wait_days,
      token_hash = EXCLUDED.token_hash,
      token_expires_at = EXCLUDED.token_expires_at,
      requested_at = EXCLUDED.requested_at,
      activated_at = EXCLUDED.activated_at,
      wait_expires_at = EXCLUDED.wait_expires_at,
      updated_at = EXCLUDED.updated_at`,
    [
      options.id,
      tenantId,
      options.ownerId,
      options.granteeId,
      options.granteeEmail,
      options.status,
      options.waitDays,
      tokenHash,
      tokenExpiresAt,
      requestedAt,
      activatedAt,
      waitExpiresAt,
      now.toISOString(),
      now.toISOString(),
    ]
  );
}
