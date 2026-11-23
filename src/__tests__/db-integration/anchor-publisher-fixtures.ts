/**
 * Shared fixtures for the audit-anchor publisher's integration files.
 *
 * The publisher reads every chain-enabled tenant and the greatest
 * `last_published_at` of EVERY anchor row, and decides from what its primary
 * destination holds. A case is therefore its own world:
 *   - `createPublisherCase` refuses to start beside chain-enabled tenants, or
 *     beside anchor rows carrying a `last_published_at`, that are not its own;
 *   - every destination it hands out is a fresh temp dir, removed by a
 *     teardown registered when the dir is made (an S3 case takes a fresh
 *     prefix instead: Object-Lock objects cannot be deleted);
 *   - every tenant it creates registers the removal of its anchor row and
 *     itself at creation, so a failed assertion leaves nothing behind;
 *   - the signing key, deployment id and tag secret are the case's, and the
 *     wall clock defaults to an hour into the case's boundary;
 *   - its own public key is archived at each destination by default, so
 *     OWN_PUBLIC_KEY_NOT_ARCHIVED appears only where a case asks for it.
 *
 * Boundaries are far in the future and each case owns a span of them, so
 * every audit row the publisher writes for a case (`anchoredAt`) is that
 * case's and nobody else's.
 */
import { randomBytes, randomInt } from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/constants/time";
import {
  SETTING_DEPLOYMENT_ID,
  SETTING_UPLOAD_ATTEMPTS,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import { buildManifestArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { kidForPublicKey, publicKeyForSigningKey } from "@/lib/audit/anchor-manifest";
import { archivePublicKey } from "@/__tests__/helpers/anchor-manifest-fixtures";
import { setBypassRlsGucs, type PrismaWithPool, type TestContext } from "./helpers";
import { assertNoForeignRows } from "./foreign-rows";

export const CADENCE_MS = MS_PER_DAY;
export const OFFSET_MS = 5 * MS_PER_MINUTE;

export const SETTING = {
  DEPLOYMENT_ID: SETTING_DEPLOYMENT_ID,
  UPLOAD_ATTEMPTS: SETTING_UPLOAD_ATTEMPTS,
} as const;

/**
 * The two rows earlier releases decided from. The publisher no longer reads
 * or writes them; the strings live here only so a test can plant them in the
 * formats the old code parsed, and clean them up.
 */
export const LEGACY_SETTING = {
  PREVIOUS_MANIFEST: "audit_anchor_previous_manifest",
  LAST_PUBLISHED_BOUNDARY: "audit_anchor_last_published_boundary",
} as const;

const ALL_SETTINGS: readonly string[] = [...Object.values(SETTING), ...Object.values(LEGACY_SETTING)];

export type SettingsSnapshot = Array<{ key: string; value: string }>;

/** Boundaries one case may use: its own and the ones after it. */
const CASE_SPAN = 30;
const FILE_BASE_MS = Date.parse("2200-01-01T00:05:00.000Z") + randomInt(0, 100_000) * CADENCE_MS;
let casesInFile = 0;

/** A wall clock an hour into `boundary`: these boundaries are far past the real clock. */
export function wallClockAt(boundary: Date): () => number {
  return () => boundary.getTime() + 60 * MS_PER_MINUTE;
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

async function clearPublisherSettings(su: PrismaWithPool): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`DELETE FROM system_settings WHERE key = ANY($1::text[])`, ALL_SETTINGS);
  });
}

export async function readSetting(su: PrismaWithPool, key: string): Promise<string | null> {
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM system_settings WHERE key = $1`, key);
  });
  return rows[0]?.value ?? null;
}

export async function writeSetting(su: PrismaWithPool, key: string, value: string): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      key,
      value,
    );
  });
}

/** Fail unless the only chain-enabled tenants are `allowed`. */
export async function assertOnlyChainEnabledTenants(su: PrismaWithPool, allowed: readonly string[]): Promise<void> {
  await assertNoForeignRows(
    su,
    "the publisher reads every chain-enabled tenant",
    `SELECT id::text AS ref FROM tenants WHERE audit_chain_enabled = true AND id <> ALL($1::uuid[])`,
    allowed,
  );
}

/**
 * Fail unless the only anchor rows carrying a `last_published_at` are
 * `allowed`'s. The publisher's high-water is the greatest value over every
 * row, so one left by another run makes each case here fail closed
 * (DESTINATION_BEHIND_DATABASE) for a reason the case does not show.
 */
export async function assertNoForeignPublishedAnchors(su: PrismaWithPool, allowed: readonly string[]): Promise<void> {
  await assertNoForeignRows(
    su,
    "the publisher reads last_published_at from every anchor row",
    `SELECT tenant_id::text AS ref FROM audit_chain_anchors
      WHERE last_published_at IS NOT NULL AND tenant_id <> ALL($1::uuid[])`,
    allowed,
  );
}

export type PublisherOutboxRow = {
  action: string;
  failureReason: string | null;
  metadata: Record<string, unknown>;
};

/** The publisher's audit rows for `boundaries`: every one carries `anchoredAt`. */
export async function publisherOutboxRows(
  su: PrismaWithPool,
  boundaries: readonly Date[],
): Promise<PublisherOutboxRow[]> {
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ action: string; metadata: Record<string, unknown> }[]>(
      `SELECT payload->>'action' AS action, payload->'metadata' AS metadata
         FROM audit_outbox
        WHERE tenant_id = $1::uuid
          AND payload->'metadata'->>'anchoredAt' = ANY($2::text[])
        ORDER BY created_at, id`,
      SYSTEM_TENANT_ID,
      boundaries.map((b) => b.toISOString()),
    );
  });
  return rows.map((r) => ({
    action: r.action,
    failureReason: typeof r.metadata.failureReason === "string" ? r.metadata.failureReason : null,
    metadata: r.metadata,
  }));
}

/**
 * Remove the publisher's audit rows for `boundaries` so no PENDING
 * `__system__` row is left for a worker to drain. The delete guard admits
 * only SENT/FAILED rows, hence the update first.
 */
async function purgePublisherOutboxRows(su: PrismaWithPool, boundaries: readonly Date[]): Promise<void> {
  const anchored = boundaries.map((b) => b.toISOString());
  const where = `tenant_id = $1::uuid AND payload->'metadata'->>'anchoredAt' = ANY($2::text[])`;
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus" WHERE ${where}`,
      SYSTEM_TENANT_ID,
      anchored,
    );
    await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE ${where}`, SYSTEM_TENANT_ID, anchored);
  });
}

type SeedOptions = { enabled: boolean; chainSeq?: number; lastPublishedAt?: Date | null; pausedUntil?: Date | null };

/** Seed (or reset) a tenant's anchor row and turn its chain on or off. */
export async function seedChainTenant(su: PrismaWithPool, tenantId: string, opts: SeedOptions): Promise<void> {
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

export async function setChainEnabled(su: PrismaWithPool, tenantId: string, enabled: boolean): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`UPDATE tenants SET audit_chain_enabled = $2 WHERE id = $1::uuid`, tenantId, enabled);
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

/** Set the chain position of a tenant, as a database writer would. */
export async function setChainSeq(su: PrismaWithPool, tenantId: string, chainSeq: number): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE audit_chain_anchors SET chain_seq = $2 WHERE tenant_id = $1::uuid`,
      tenantId,
      chainSeq,
    );
  });
}

/** Set (or clear) `last_published_at` on a tenant's anchor row, as a database writer would. */
export async function setLastPublishedAt(su: PrismaWithPool, tenantIds: readonly string[], value: Date | null): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE audit_chain_anchors SET last_published_at = $2 WHERE tenant_id = ANY($1::uuid[])`,
      [...tenantIds],
      value,
    );
  });
}

export async function deleteAnchorRows(su: PrismaWithPool, tenantIds: readonly string[]): Promise<void> {
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`DELETE FROM audit_chain_anchors WHERE tenant_id = ANY($1::uuid[])`, [...tenantIds]);
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

export type PublisherCase = {
  /** The case's first boundary. */
  readonly boundary: Date;
  readonly signingKey: Buffer;
  readonly publicKey: Buffer;
  readonly kid: string;
  readonly deploymentId: string;
  readonly tagSecret: Buffer;
  /** The boundary `days` after the case's first; within the case's span. */
  boundaryAt(days: number): Date;
  /** The key this case's publisher stores the manifest for `boundary` under. */
  manifestKey(boundary?: Date): string;
  /** A tenant with an anchor row; its removal is registered now. */
  createTenant(opts?: SeedOptions): Promise<string>;
  /** A fresh temp dir, removed at cleanup. */
  tempDir(): Promise<string>;
  /** A filesystem destination on a fresh temp dir, the case's public key archived unless told otherwise. */
  filesystem(opts?: { archiveOwnKey?: boolean }): Promise<{ dest: FilesystemDestination; dir: string }>;
  /** A config with the case's identity; `now` an hour into the case's boundary unless overridden. */
  config(destinations: AnchorDestination[], overrides?: Partial<PublisherConfig>): PublisherConfig;
  /** The publisher's audit rows for every boundary of the case. */
  outboxRows(): Promise<PublisherOutboxRow[]>;
  /** Run every registered teardown, newest first. Call from afterEach. */
  cleanup(): Promise<void>;
};

/**
 * Start a case: checks the database holds no publish state but its own,
 * clears the publisher's settings rows, and hands out resources whose
 * teardown is registered as each is created.
 */
export async function createPublisherCase(ctx: TestContext): Promise<PublisherCase> {
  await assertOnlyChainEnabledTenants(ctx.su, []);
  await assertNoForeignPublishedAnchors(ctx.su, []);
  await clearPublisherSettings(ctx.su);

  const first = FILE_BASE_MS + casesInFile++ * CASE_SPAN * CADENCE_MS;
  const boundaries = Array.from({ length: CASE_SPAN }, (_, i) => new Date(first + i * CADENCE_MS));
  const signingKey = randomBytes(32);
  const publicKey = publicKeyForSigningKey(signingKey);
  const kid = kidForPublicKey(publicKey);
  const deploymentId = `test-deploy-${randomBytes(4).toString("hex")}`;
  const tagSecret = randomBytes(32);

  const teardowns: Array<() => Promise<void>> = [
    () => clearPublisherSettings(ctx.su),
    () => purgePublisherOutboxRows(ctx.su, boundaries),
  ];

  const boundaryAt = (days: number): Date => {
    const boundary = boundaries[days];
    if (!boundary) throw new Error(`a case owns ${CASE_SPAN} boundaries; ${days} is outside them`);
    return boundary;
  };

  const tempDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-publisher-case-"));
    teardowns.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  };

  return {
    boundary: boundaryAt(0),
    signingKey,
    publicKey,
    kid,
    deploymentId,
    tagSecret,
    boundaryAt,
    manifestKey: (boundary = boundaryAt(0)) => buildManifestArtifactKey(boundary, kid),
    async createTenant(opts = { enabled: true }) {
      const tenantId = await ctx.createTenant();
      // deleteTestData removes the anchor row before the tenant.
      teardowns.push(() => ctx.deleteTestData(tenantId));
      await seedChainTenant(ctx.su, tenantId, opts);
      return tenantId;
    },
    tempDir,
    async filesystem(opts = {}) {
      const dir = await tempDir();
      const dest = new FilesystemDestination({ basePath: dir });
      if (opts.archiveOwnKey !== false) await archivePublicKey(dest, publicKey);
      return { dest, dir };
    },
    config(destinations, overrides = {}) {
      return {
        databaseUrl: "unused://the-test-passes-its-own-client",
        deploymentId,
        signingKey,
        tagSecret,
        destinations,
        cadenceMs: CADENCE_MS,
        publishOffsetMs: OFFSET_MS,
        now: wallClockAt(boundaryAt(0)),
        ...overrides,
      };
    },
    outboxRows: () => publisherOutboxRows(ctx.su, boundaries),
    async cleanup() {
      const failures: unknown[] = [];
      for (const teardown of teardowns.splice(0).reverse()) {
        try {
          await teardown();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "publisher case teardown failed");
    },
  };
}
