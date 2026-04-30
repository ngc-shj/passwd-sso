import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getLogger } from "@/lib/logger";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  AUDIT_ANCHOR_CADENCE_MS,
  AUDIT_ANCHOR_PUBLISH_OFFSET_MS,
  AUDIT_ANCHOR_PAUSE_CAP_FACTOR,
} from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { logAuditAsync } from "@/lib/audit/audit";
import {
  buildManifest,
  canonicalize,
  sign,
  type AnchorRow,
} from "@/lib/audit/anchor-manifest";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

// --- Typed errors ---

export class DeploymentIdMismatchError extends Error {
  constructor(expected: string, found: string) {
    super(
      `DEPLOYMENT_ID mismatch: expected=${expected}, found=${found}. ` +
      "Another publisher instance owns this deployment slot.",
    );
    this.name = "DeploymentIdMismatchError";
  }
}

// --- Public types ---

export type CadenceOutcome =
  | { kind: "published"; manifestSha256: string; destinations: string[]; tenantsCount: number }
  | { kind: "lock_held"; reason: "LOCK_HELD_BY_OTHER_INSTANCE" }
  | { kind: "skipped_paused"; reason: "PUBLISH_PAUSED_ACTIVE" }
  | { kind: "failed"; reason: string };

export type PublisherConfig = {
  databaseUrl: string;
  deploymentId: string;
  signingKey: Buffer;
  signingKeyKid: string;
  tagSecret: Buffer;
  destinations: AnchorDestination[];
  cadenceMs: number;
  publishOffsetMs: number;
  pauseCapFactor: number;
};

// --- Cadence math ---

/**
 * Compute the current cadence boundary given a clock value.
 * floor((now - offset) / cadence) * cadence + offset
 */
export function currentCadenceBoundary(now: Date, cadenceMs: number, offsetMs: number): Date {
  const t = now.getTime();
  const boundary = Math.floor((t - offsetMs) / cadenceMs) * cadenceMs + offsetMs;
  return new Date(boundary);
}

export function previousCadenceBoundary(now: Date, cadenceMs: number, offsetMs: number): Date {
  const current = currentCadenceBoundary(now, cadenceMs, offsetMs);
  return new Date(current.getTime() - cadenceMs);
}

// --- Publisher class ---

export class AuditAnchorPublisher {
  private readonly prisma: PrismaClient;
  private readonly config: PublisherConfig;

  constructor(deps: { prisma: PrismaClient; config: PublisherConfig }) {
    this.prisma = deps.prisma;
    this.config = deps.config;
  }

  /**
   * Boot validation: enforce DEPLOYMENT_ID against system_settings.
   * Call once at startup before runCadence.
   * Throws DeploymentIdMismatchError if another publisher owns the slot.
   */
  async ensureDeploymentIdMatch(): Promise<void> {
    const { deploymentId } = this.config;
    const prisma = this.prisma;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH}, true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${SYSTEM_TENANT_ID}, true)`;

      // Insert if not exists
      await tx.$executeRaw`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('audit_anchor_deployment_id', ${deploymentId}, now())
        ON CONFLICT (key) DO NOTHING
      `;

      const rows = await tx.$queryRaw<{ value: string }[]>`
        SELECT value FROM system_settings WHERE key = 'audit_anchor_deployment_id'
      `;

      const stored = rows[0]?.value;
      if (stored !== deploymentId) {
        await logAuditAsync({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          tenantId: SYSTEM_TENANT_ID,
          metadata: {
            failureReason: "DEPLOYMENT_ID_MISMATCH",
            expected: deploymentId,
            found: stored ?? null,
          },
        });
        throw new DeploymentIdMismatchError(deploymentId, stored ?? "(none)");
      }
    });
  }

  /** Single cadence cycle. Idempotent on cadence boundary via PG advisory lock. */
  async runCadence(now: Date): Promise<CadenceOutcome> {
    const { config } = this;
    const log = getLogger();

    const currentBoundary = currentCadenceBoundary(now, config.cadenceMs, config.publishOffsetMs);
    const prevBoundary = previousCadenceBoundary(now, config.cadenceMs, config.publishOffsetMs);

    let tenantsInManifest: string[] = [];
    let manifestSha256 = "";
    let artifactKey = "";
    let artifactBytes = Buffer.alloc(0);
    let primaryUri = "";

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        // Step 1: Set bypass RLS
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH}, true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${SYSTEM_TENANT_ID}, true)`;

        // Step 2: Acquire advisory lock
        const lockRows = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('audit-anchor-publish')) AS acquired
        `;
        const acquired = lockRows[0]?.acquired ?? false;
        if (!acquired) {
          return { kind: "lock_held" as const, reason: "LOCK_HELD_BY_OTHER_INSTANCE" as const };
        }

        // Step 3: Cadence-end safety net — check previous cadence completion
        const chainEnabledTenants = await tx.tenant.findMany({
          where: { auditChainEnabled: true },
          select: { id: true, auditChainEnabled: true },
        });

        if (chainEnabledTenants.length > 0) {
          const tenantIds = chainEnabledTenants.map((t) => t.id);
          const prevCadenceBoundaryMs = prevBoundary.getTime();

          // Only check if prevBoundary is non-genesis (> epoch start)
          if (prevCadenceBoundaryMs > config.publishOffsetMs) {
            const maxPublishedRows = await tx.$queryRaw<{ max_published: Date | null }[]>`
              SELECT MAX(last_published_at) AS max_published
              FROM audit_chain_anchors
              WHERE last_published_at IS NOT NULL
                AND tenant_id = ANY(${tenantIds}::uuid[])
            `;
            const maxPublished = maxPublishedRows[0]?.max_published;
            if (!maxPublished || maxPublished.getTime() < prevCadenceBoundaryMs) {
              log.warn(
                { prevCadenceBoundary: prevBoundary.toISOString(), maxPublished },
                "audit-anchor-publisher.missing_prior_cadence",
              );
              // Informational only — do NOT abort
              await logAuditAsync({
                scope: AUDIT_SCOPE.TENANT,
                action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
                userId: SYSTEM_ACTOR_ID,
                actorType: ACTOR_TYPE.SYSTEM,
                tenantId: SYSTEM_TENANT_ID,
                metadata: {
                  failureReason: "MISSING_PRIOR_CADENCE_PUBLICATION",
                  prevCadenceBoundary: prevBoundary.toISOString(),
                  maxPublishedAt: maxPublished?.toISOString() ?? null,
                },
              });
            }
          }
        }

        // Step 4: Read chain-enabled tenants and their anchors
        const tenants = await tx.tenant.findMany({
          where: { auditChainEnabled: true },
          select: { id: true, auditChainEnabled: true },
        });

        if (tenants.length === 0) {
          return { kind: "skipped_paused" as const, reason: "PUBLISH_PAUSED_ACTIVE" as const };
        }

        const tenantIds = tenants.map((t) => t.id);
        const anchors = await tx.auditChainAnchor.findMany({
          where: { tenantId: { in: tenantIds } },
        });

        // Step 5: Filter paused tenants
        const nonPausedAnchors = anchors.filter((a) => {
          if (a.publishPausedUntil && a.publishPausedUntil > now) {
            // Emit informational pause event
            void logAuditAsync({
              scope: AUDIT_SCOPE.TENANT,
              action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_PAUSED,
              userId: SYSTEM_ACTOR_ID,
              actorType: ACTOR_TYPE.SYSTEM,
              tenantId: SYSTEM_TENANT_ID,
              metadata: {
                tenantId: a.tenantId,
                pausedUntil: a.publishPausedUntil.toISOString(),
              },
            });
            return false;
          }
          return true;
        });

        if (nonPausedAnchors.length === 0) {
          return { kind: "skipped_paused" as const, reason: "PUBLISH_PAUSED_ACTIVE" as const };
        }

        // Step 6: Build anchor rows
        const rows: AnchorRow[] = nonPausedAnchors.map((a) => ({
          tenantId: a.tenantId,
          chainSeq: a.chainSeq,
          prevHash: Buffer.from(a.prevHash),
          epoch: a.epoch ?? 1,
        }));

        // Step 7: Fetch previous manifest reference
        const prevManifestRow = await tx.systemSetting.findUnique({
          where: { key: "audit_anchor_previous_manifest" },
        });
        const previousManifest = prevManifestRow
          ? (JSON.parse(prevManifestRow.value) as { uri: string; sha256: string })
          : null;

        // Step 8: Build + sign manifest
        const manifest = buildManifest({
          tenants: rows,
          deploymentId: config.deploymentId,
          anchoredAt: currentBoundary,
          previousManifest,
          tagSecret: config.tagSecret,
        });

        const canonicalBytes = canonicalize(manifest);
        const jws = sign(canonicalBytes, config.signingKey, config.signingKeyKid);

        manifestSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
        const dateStr = currentBoundary.toISOString().slice(0, 10);
        artifactKey = `${dateStr}.kid-${config.signingKeyKid}.jws`;
        artifactBytes = Buffer.from(jws, "utf-8");

        tenantsInManifest = nonPausedAnchors.map((a) => a.tenantId);

        // Step 9: Upload to all destinations (inside tx per plan Round 5 pattern)
        for (const dest of config.destinations) {
          try {
            await dest.upload({
              artifactBytes,
              artifactKey,
              contentType: "application/jose",
            });
          } catch (uploadErr) {
            const reason = `${dest.name}_UPLOAD_FAILED`;
            const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
            log.error({ destination: dest.name, err: errMsg }, "audit-anchor-publisher.upload_failed");

            // Set pause window on affected tenants
            const pauseUntil = new Date(
              Math.min(
                now.getTime() + config.cadenceMs,
                Math.max(now.getTime(), now.getTime()) + config.pauseCapFactor * config.cadenceMs,
              ),
            );
            await tx.auditChainAnchor.updateMany({
              where: { tenantId: { in: tenantsInManifest } },
              data: { publishPausedUntil: pauseUntil },
            });

            throw new Error(`${reason}: ${errMsg}`);
          }
        }

        // Determine primary URI (first destination)
        primaryUri = config.destinations.length > 0
          ? `${config.destinations[0]!.name}://${artifactKey}`
          : `local://${artifactKey}`;

        // Step 10: Update last_published_at
        await tx.auditChainAnchor.updateMany({
          where: { tenantId: { in: tenantsInManifest } },
          data: { lastPublishedAt: now, publishPausedUntil: null },
        });

        // Step 11: Update previousManifest pointer
        const manifestPtr = JSON.stringify({ uri: primaryUri, sha256: manifestSha256 });
        await tx.systemSetting.upsert({
          where: { key: "audit_anchor_previous_manifest" },
          update: { value: manifestPtr },
          create: { key: "audit_anchor_previous_manifest", value: manifestPtr },
        });

        return {
          kind: "published" as const,
          manifestSha256,
          destinations: config.destinations.map((d) => d.name),
          tenantsCount: tenantsInManifest.length,
        };
      });

      // Step 12: Emit success audit event AFTER tx commits
      if (outcome.kind === "published") {
        await logAuditAsync({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISHED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          tenantId: SYSTEM_TENANT_ID,
          metadata: {
            manifestSha256: outcome.manifestSha256,
            destinations: outcome.destinations,
            tenantsCount: outcome.tenantsCount,
            artifactKey,
            anchoredAt: currentBoundary.toISOString(),
          },
        });
      }

      return outcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ reason }, "audit-anchor-publisher.cadence_failed");

      await logAuditAsync({
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        tenantId: SYSTEM_TENANT_ID,
        metadata: {
          failureReason: reason,
          artifactKey: artifactKey || null,
          anchoredAt: currentBoundary.toISOString(),
        },
      });

      return { kind: "failed", reason };
    }
  }
}

// --- createPublisher factory ---

export function createPublisher(config: PublisherConfig): {
  publisher: AuditAnchorPublisher;
  prisma: PrismaClient;
  shutdown: () => Promise<void>;
} {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    application_name: "passwd-sso-audit-anchor-publisher",
  });

  pool.on("error", (err) => {
    getLogger().error(
      { code: (err as NodeJS.ErrnoException | undefined)?.code },
      "audit-anchor-publisher.pool.error",
    );
  });

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  const publisher = new AuditAnchorPublisher({ prisma, config });

  async function shutdown(): Promise<void> {
    await prisma.$disconnect();
    await pool.end();
  }

  return { publisher, prisma, shutdown };
}
