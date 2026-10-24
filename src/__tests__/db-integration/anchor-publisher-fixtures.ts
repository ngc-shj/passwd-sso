/**
 * Shared fixtures for the audit-anchor publisher's integration files.
 *
 * The publisher's state lives in four GLOBAL `system_settings` rows and reads
 * every chain-enabled tenant, so a test on the shared dev database must (a)
 * refuse to run beside chain-enabled tenants it did not create, (b) put the
 * four rows back as it found them, and (c) never leave the attempt count
 * behind — a leftover `{boundary, 3}` makes the next case report the cap.
 *
 * Boundaries are far in the future and randomised per run, so every row the
 * publisher writes for them (artifact keys, `anchoredAt` in audit metadata)
 * is this run's and nobody else's — the boundary doubles as the row nonce.
 */
import { randomBytes, randomInt } from "node:crypto";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/constants/time";
import {
  SETTING_DEPLOYMENT_ID,
  SETTING_LAST_PUBLISHED_BOUNDARY,
  SETTING_PREVIOUS_MANIFEST,
  SETTING_UPLOAD_ATTEMPTS,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { setBypassRlsGucs, type PrismaWithPool } from "./helpers";

export const CADENCE_MS = MS_PER_DAY;
export const OFFSET_MS = 5 * MS_PER_MINUTE;

export const SETTING = {
  DEPLOYMENT_ID: SETTING_DEPLOYMENT_ID,
  PREVIOUS_MANIFEST: SETTING_PREVIOUS_MANIFEST,
  LAST_PUBLISHED_BOUNDARY: SETTING_LAST_PUBLISHED_BOUNDARY,
  UPLOAD_ATTEMPTS: SETTING_UPLOAD_ATTEMPTS,
} as const;

const ALL_SETTINGS = Object.values(SETTING);

export type SettingsSnapshot = Array<{ key: string; value: string }>;

/** A boundary in year ~2200, unique to this run; step it by CADENCE_MS per case. */
export function farFutureBoundary(): Date {
  return new Date(Date.parse("2200-01-01T00:05:00.000Z") + randomInt(0, 100_000) * CADENCE_MS);
}

export function makePublisherConfig(
  destinations: AnchorDestination[],
  overrides: Partial<PublisherConfig> = {},
): PublisherConfig {
  return {
    databaseUrl: "unused://the-test-passes-its-own-client",
    deploymentId: `test-deploy-${randomBytes(4).toString("hex")}`,
    signingKey: randomBytes(32),
    signingKeyKid: `audit-anchor-${randomBytes(6).toString("hex")}`,
    tagSecret: randomBytes(32),
    destinations,
    cadenceMs: CADENCE_MS,
    publishOffsetMs: OFFSET_MS,
    ...overrides,
  };
}

export async function snapshotPublisherSettings(su: PrismaWithPool): Promise<SettingsSnapshot> {
  return su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<SettingsSnapshot>(
      `SELECT key, value FROM system_settings WHERE key = ANY($1::text[])`,
      ALL_SETTINGS,
    );
  });
}

export async function restorePublisherSettings(su: PrismaWithPool, snapshot: SettingsSnapshot): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`DELETE FROM system_settings WHERE key = ANY($1::text[])`, ALL_SETTINGS);
    for (const { key, value } of snapshot) {
      await tx.$executeRawUnsafe(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())`,
        key,
        value,
      );
    }
  });
}

/** Delete the publisher's rows; every case starts from none (default: all four). */
export async function clearPublisherSettings(
  su: PrismaWithPool,
  keys: readonly string[] = ALL_SETTINGS,
): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`DELETE FROM system_settings WHERE key = ANY($1::text[])`, [...keys]);
  });
}

export async function readSetting(su: PrismaWithPool, key: string): Promise<string | null> {
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM system_settings WHERE key = $1`, key);
  });
  return rows[0]?.value ?? null;
}

/** Fail unless the only chain-enabled tenants are `allowed`. */
export async function assertOnlyChainEnabledTenants(su: PrismaWithPool, allowed: readonly string[]): Promise<void> {
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM tenants WHERE audit_chain_enabled = true`);
  });
  const foreign = rows.map((r) => r.id).filter((id) => !allowed.includes(id));
  if (foreign.length > 0) {
    throw new Error(
      `the publisher reads every chain-enabled tenant, and ${foreign.length} on this database are not ` +
        `this file's (${foreign.join(", ")}); disable or remove them before running it`,
    );
  }
}

/** The publisher's audit rows for `boundaries`, by action and failure reason. */
export async function publisherOutboxRows(
  su: PrismaWithPool,
  boundaries: readonly Date[],
): Promise<Array<{ action: string; failureReason: string | null }>> {
  const anchored = boundaries.map((b) => b.toISOString());
  const prior = boundaries.map((b) => new Date(b.getTime() - CADENCE_MS).toISOString());
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ action: string; failure_reason: string | null }[]>(
      `SELECT payload->>'action' AS action, payload->'metadata'->>'failureReason' AS failure_reason
         FROM audit_outbox
        WHERE tenant_id = $1::uuid
          AND (payload->'metadata'->>'anchoredAt' = ANY($2::text[])
               OR (payload->'metadata'->>'failureReason' = 'MISSING_PRIOR_CADENCE_PUBLICATION'
                   AND payload->'metadata'->>'prevCadenceBoundary' = ANY($3::text[])))
        ORDER BY created_at, id`,
      SYSTEM_TENANT_ID,
      anchored,
      prior,
    );
  });
  return rows.map((r) => ({ action: r.action, failureReason: r.failure_reason }));
}

/**
 * Remove the publisher's audit rows for `boundaries` so no PENDING
 * `__system__` row is left for a worker to drain. The delete guard admits
 * only SENT/FAILED rows, hence the update first.
 */
export async function purgePublisherOutboxRows(su: PrismaWithPool, boundaries: readonly Date[]): Promise<void> {
  if (boundaries.length === 0) return;
  const anchored = boundaries.map((b) => b.toISOString());
  const prior = boundaries.map((b) => new Date(b.getTime() - CADENCE_MS).toISOString());
  const where = `tenant_id = $1::uuid
      AND (payload->'metadata'->>'anchoredAt' = ANY($2::text[])
           OR (payload->'metadata'->>'failureReason' = 'MISSING_PRIOR_CADENCE_PUBLICATION'
               AND payload->'metadata'->>'prevCadenceBoundary' = ANY($3::text[])))`;
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus" WHERE ${where}`,
      SYSTEM_TENANT_ID,
      anchored,
      prior,
    );
    await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE ${where}`, SYSTEM_TENANT_ID, anchored, prior);
  });
}

/** Seed (or reset) a tenant's anchor row and turn its chain on or off. */
export async function seedChainTenant(
  su: PrismaWithPool,
  tenantId: string,
  opts: { enabled: boolean; chainSeq?: number; lastPublishedAt?: Date | null; pausedUntil?: Date | null },
): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE tenants SET audit_chain_enabled = $2 WHERE id = $1::uuid`,
      tenantId,
      opts.enabled,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch, last_published_at, publish_paused_until)
       VALUES ($1::uuid, $2, $3::bytea, now(), 1, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE
         SET chain_seq = $2, prev_hash = $3::bytea, epoch = 1, updated_at = now(),
             last_published_at = $4, publish_paused_until = $5`,
      tenantId,
      opts.chainSeq ?? 5,
      `\\x${randomBytes(32).toString("hex")}`,
      opts.lastPublishedAt ?? null,
      opts.pausedUntil ?? null,
    );
  });
}

/** Advance a tenant's chain, as the outbox worker would between two publishes. */
export async function advanceChain(su: PrismaWithPool, tenantId: string): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE audit_chain_anchors SET chain_seq = chain_seq + 1, prev_hash = $2::bytea WHERE tenant_id = $1::uuid`,
      tenantId,
      `\\x${randomBytes(32).toString("hex")}`,
    );
  });
}

export async function anchorState(
  su: PrismaWithPool,
  tenantIds: readonly string[],
): Promise<Array<{ tenant_id: string; last_published_at: Date | null; publish_paused_until: Date | null }>> {
  return su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe(
      `SELECT tenant_id, last_published_at, publish_paused_until FROM audit_chain_anchors
        WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id`,
      [...tenantIds],
    );
  });
}
