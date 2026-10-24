import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { AuditAction, Prisma, PrismaClient } from "@prisma/client";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
} from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { BYPASS_GRANT, setBypassGucs, setLockTimeout } from "@/lib/tenant-rls-grants";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { createPool, createPrismaClient } from "@/lib/db/pool-factory";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
// Not `@/lib/audit/audit`: that module imports `@/lib/prisma`, which builds the
// application pool at import and throws without DATABASE_URL. The publisher
// runs on its own role and URL, so its module graph must not reach it (C1).
import { buildOutboxPayload, type AuditLogParams } from "@/lib/audit/audit-payload";
import { auditLogger, deadLetterLogger } from "@/lib/audit/audit-logger";
import {
  buildManifest,
  canonicalize,
  sign,
  type AnchorRow,
} from "@/lib/audit/anchor-manifest";
import { WORKER_POOL_IDLE_TIMEOUT_MS, WORKER_POOL_STATEMENT_TIMEOUT_MS } from "@/workers/worker-pool-config";
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

/** The upload bound fired. Its `code` is what the failure reason carries. */
class UploadTimeoutError extends Error {
  readonly code = "UPLOAD_TIMEOUT";
  constructor() {
    super("anchor upload exceeded its time bound");
    this.name = "UploadTimeoutError";
  }
}

// --- Constants ---

const ADVISORY_LOCK_KEY = "audit-anchor-publish";
const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";

const SETTING_PREVIOUS_MANIFEST = "audit_anchor_previous_manifest";
const SETTING_LAST_PUBLISHED_BOUNDARY = "audit_anchor_last_published_boundary";
const SETTING_UPLOAD_ATTEMPTS = "audit_anchor_upload_attempts";

/** Runs per boundary that may reach the upload; the next one reports the cap. */
export const AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP = 3;

export const DEFAULT_LOCK_TIMEOUT_MS = 10 * MS_PER_SECOND;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 60 * MS_PER_SECOND;
export const DEFAULT_TX_TIMEOUT_MS = 90 * MS_PER_SECOND;

/** The dead-letter reason for an emit whose outbox write failed. */
export const PUBLISHER_AUDIT_DEAD_LETTER_REASON = "anchor_publisher_emit_failed";

// --- Public types ---

/** `null` only where the run failed before it could read the tenants. */
type TenantCount = { chainEnabledTenantCount: number | null };

/** Where a failed run stopped. */
export type FailureStage = "before_upload" | "upload" | "after_upload";

export type CadenceOutcome =
  | ({ kind: "published"; manifestSha256: string; destinations: string[]; tenantsCount: number } & TenantCount)
  | ({ kind: "lock_held"; reason: "LOCK_HELD_BY_OTHER_INSTANCE" } & TenantCount)
  | ({ kind: "skipped_already_published"; reason: "BOUNDARY_ALREADY_PUBLISHED" } & TenantCount)
  | ({ kind: "skipped_no_tenants"; reason: "NO_CHAIN_ENABLED_TENANTS"; everChainEnabled: boolean } & TenantCount)
  | ({ kind: "upload_cap_reached"; reason: "UPLOAD_ATTEMPT_CAP_REACHED"; attempts: number } & TenantCount)
  | ({ kind: "failed"; reason: string; stage: FailureStage } & TenantCount);

/**
 * Test seams. Production passes none. `inTx` runs inside the publish
 * transaction once the advisory lock is held; `afterUpload` runs after every
 * destination accepted the artifact and before the commit's writes, so a
 * throw there is a commit lost after the upload.
 */
export type PublisherHooks = {
  inTx?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterUpload?: () => Promise<void>;
};

export type PublisherConfig = {
  databaseUrl: string;
  deploymentId: string;
  signingKey: Buffer;
  signingKeyKid: string;
  tagSecret: Buffer;
  destinations: AnchorDestination[];
  cadenceMs: number;
  publishOffsetMs: number;
  /** `SET LOCAL lock_timeout` before the advisory lock. Default 10 s. */
  lockTimeoutMs?: number;
  /** Bound on the upload to every destination, as a whole. Default 60 s. */
  uploadTimeoutMs?: number;
  /** Bound on each transaction. Default 90 s. */
  txTimeoutMs?: number;
  hooks?: PublisherHooks;
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

/**
 * The manifest's object key, `YYYY-MM-DD.kid-<kid>.jws`. The single source of
 * the key shape: the anchors bucket policy's manifest pattern is pinned to it.
 */
export function buildManifestArtifactKey(boundary: Date, kid: string): string {
  return `${boundary.toISOString().slice(0, 10)}.kid-${kid}.jws`;
}

// --- Internals ---

const previousManifestSchema = z.object({
  uri: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const uploadAttemptsSchema = z.object({
  boundary: z.string(),
  count: z.number().int().positive(),
});

type PendingEmit = { action: AuditAction; metadata: Record<string, unknown> };

type AttemptGate =
  | { kind: "already_published"; chainEnabledTenantCount: number }
  | { kind: "no_tenants"; everChainEnabled: boolean }
  | { kind: "counted"; attempts: number; chainEnabledTenantCount: number };

class LockHeldSignal {
  constructor(readonly chainEnabledTenantCount: number | null) {}
}

function isLockNotAvailable(err: unknown): boolean {
  return pgErrorCode(err) === SQLSTATE_LOCK_NOT_AVAILABLE;
}

/** Reject when `signal` aborts, whether or not `work` honours it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function chainEnabledTenantIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const tenants = await tx.tenant.findMany({
    where: { auditChainEnabled: true },
    select: { id: true },
  });
  return tenants.map((t) => t.id);
}

/**
 * Whether `boundary` is already published. The marker decides; an install that
 * predates it has none, and there the anchors' `last_published_at` stands in,
 * so an upgrade does not republish the boundary it already published.
 */
async function isBoundaryPublished(
  tx: Prisma.TransactionClient,
  boundary: Date,
  tenantIds: string[],
): Promise<boolean> {
  const marker = await tx.systemSetting.findUnique({
    where: { key: SETTING_LAST_PUBLISHED_BOUNDARY },
  });
  if (marker) return marker.value === boundary.toISOString();
  if (tenantIds.length === 0) return false;
  const rows = await tx.$queryRaw<{ max_published: Date | null }[]>`
    SELECT MAX(last_published_at) AS max_published
    FROM audit_chain_anchors
    WHERE tenant_id = ANY(${tenantIds}::uuid[])
  `;
  const maxPublished = rows[0]?.max_published;
  return maxPublished != null && maxPublished.getTime() >= boundary.getTime();
}

// --- Publisher class ---

export class AuditAnchorPublisher {
  private readonly prisma: PrismaClient;
  private readonly config: PublisherConfig;

  constructor(deps: { prisma: PrismaClient; config: PublisherConfig }) {
    this.prisma = deps.prisma;
    this.config = deps.config;
  }

  private get lockTimeoutMs(): number {
    return this.config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  private get txOptions(): { timeout: number } {
    return { timeout: this.config.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS };
  }

  /**
   * Write one audit row through the outbox on its own transaction. Never
   * throws: the structured line goes out first, as `logAuditAsync` emits it,
   * and a failed write goes to the dead-letter stream.
   *
   * `createMany`, not `create`: it issues no RETURNING, so the role's INSERT
   * on `audit_outbox` suffices. The bypass is the grant naming `auditOutbox`
   * alone, with no tenant id set, so the grant is what admits the row.
   */
  private async emitAudit(action: AuditAction, metadata: Record<string, unknown>): Promise<void> {
    const params: AuditLogParams = {
      scope: AUDIT_SCOPE.TENANT,
      action,
      userId: SYSTEM_ACTOR_ID,
      actorType: ACTOR_TYPE.SYSTEM,
      tenantId: SYSTEM_TENANT_ID,
      metadata,
    };
    const payload = buildOutboxPayload(params);

    try {
      auditLogger.info(
        {
          audit: {
            scope: payload.scope,
            action: payload.action,
            userId: payload.userId,
            actorType: payload.actorType,
            serviceAccountId: payload.serviceAccountId,
            tenantId: SYSTEM_TENANT_ID,
            teamId: payload.teamId,
            targetType: payload.targetType,
            targetId: payload.targetId,
            metadata: payload.metadata,
            ip: payload.ip,
            userAgent: payload.userAgent,
          },
        },
        `audit.${payload.action}`,
      );
    } catch {
      // Never let forwarding break the publisher
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);
        await tx.auditOutbox.createMany({
          data: [{ tenantId: SYSTEM_TENANT_ID, payload: payload as unknown as Prisma.InputJsonValue }],
        });
      });
    } catch (err) {
      deadLetterLogger.warn(
        {
          scope: params.scope,
          action: params.action,
          userId: params.userId,
          tenantId: SYSTEM_TENANT_ID,
          reason: PUBLISHER_AUDIT_DEAD_LETTER_REASON,
          error: errorLogFields(err),
        },
        "audit.dead_letter",
      );
    }
  }

  /**
   * Boot validation: enforce DEPLOYMENT_ID against system_settings.
   * Call once at startup before runCadence.
   * Throws DeploymentIdMismatchError if another publisher owns the slot.
   */
  async ensureDeploymentIdMatch(): Promise<void> {
    const { deploymentId } = this.config;

    const stored = await this.prisma.$transaction(async (tx) => {
      await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });

      // Insert if not exists
      await tx.$executeRaw`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('audit_anchor_deployment_id', ${deploymentId}, now())
        ON CONFLICT (key) DO NOTHING
      `;

      const rows = await tx.$queryRaw<{ value: string }[]>`
        SELECT value FROM system_settings WHERE key = 'audit_anchor_deployment_id'
      `;
      return rows[0]?.value;
    });

    if (stored !== deploymentId) {
      await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED, {
        failureReason: "DEPLOYMENT_ID_MISMATCH",
        expected: deploymentId,
        found: stored ?? null,
      });
      throw new DeploymentIdMismatchError(deploymentId, stored ?? "(none)");
    }
  }

  /**
   * Count this run against `boundary`, on its own transaction committed before
   * the publish transaction opens — so neither a rollback nor a crash after
   * the PUT undoes it. Takes the publish lock, re-checks the marker, and does
   * not count a run with nothing to publish.
   */
  private async claimAttempt(boundary: Date): Promise<AttemptGate> {
    let tenantCount: number | null = null;
    try {
      return await this.prisma.$transaction(async (tx): Promise<AttemptGate> => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        const tenantIds = await chainEnabledTenantIds(tx);
        tenantCount = tenantIds.length;
        await setLockTimeout(tx, this.lockTimeoutMs);
        await advisoryXactLock(tx, ADVISORY_LOCK_KEY);

        if (await isBoundaryPublished(tx, boundary, tenantIds)) {
          return { kind: "already_published", chainEnabledTenantCount: tenantIds.length };
        }
        if (tenantIds.length === 0) {
          const anyAnchor = await tx.auditChainAnchor.findFirst({ select: { tenantId: true } });
          return { kind: "no_tenants", everChainEnabled: anyAnchor !== null };
        }

        // Read-then-write is safe under the advisory lock every publisher
        // takes. A stored value that does not parse fails the run rather than
        // restarting the count.
        const boundaryIso = boundary.toISOString();
        const storedRow = await tx.systemSetting.findUnique({ where: { key: SETTING_UPLOAD_ATTEMPTS } });
        const previous = storedRow ? uploadAttemptsSchema.parse(JSON.parse(storedRow.value)) : null;
        const count = previous?.boundary === boundaryIso ? previous.count + 1 : 1;
        const value = JSON.stringify({ boundary: boundaryIso, count });
        await tx.systemSetting.upsert({
          where: { key: SETTING_UPLOAD_ATTEMPTS },
          update: { value },
          create: { key: SETTING_UPLOAD_ATTEMPTS, value },
        });
        return { kind: "counted", attempts: count, chainEnabledTenantCount: tenantIds.length };
      }, this.txOptions);
    } catch (err) {
      if (isLockNotAvailable(err)) throw new LockHeldSignal(tenantCount);
      throw err;
    }
  }

  /** One cadence run for `boundary`. Logs the cadence line; never throws. */
  async runCadence(boundary: Date): Promise<CadenceOutcome> {
    const outcome = await this.runCadenceInner(boundary);
    const log = getLogger();
    log.info(
      {
        ...outcome,
        boundary: boundary.toISOString(),
        _logType: "audit-anchor-publisher.cadence",
      },
      "audit-anchor-publisher.cadence",
    );
    // The healthy line is what the absence alarm counts: one per healthy
    // boundary, and nothing else may emit it.
    const healthy =
      outcome.kind === "published" ||
      (outcome.kind === "skipped_no_tenants" && !outcome.everChainEnabled);
    if (healthy) {
      log.info(
        {
          outcome: outcome.kind,
          boundary: boundary.toISOString(),
          chainEnabledTenantCount: outcome.chainEnabledTenantCount,
          _logType: "audit-anchor-publisher.cadence_healthy",
        },
        "audit-anchor-publisher.cadence_healthy",
      );
    }
    return outcome;
  }

  private async runCadenceInner(boundary: Date): Promise<CadenceOutcome> {
    const { config } = this;
    const log = getLogger();
    const boundaryIso = boundary.toISOString();

    // Step 1: the attempt count, committed before anything is uploaded.
    let gate: AttemptGate;
    try {
      gate = await this.claimAttempt(boundary);
    } catch (err) {
      if (err instanceof LockHeldSignal) {
        return this.lockHeld(boundary, err.chainEnabledTenantCount);
      }
      const reason = `CADENCE_FAILED:${errorLogFields(err).code}`;
      return this.fail(boundary, { reason, stage: "before_upload", chainEnabledTenantCount: null, artifactKey: null });
    }

    if (gate.kind === "already_published") {
      return {
        kind: "skipped_already_published",
        reason: "BOUNDARY_ALREADY_PUBLISHED",
        chainEnabledTenantCount: gate.chainEnabledTenantCount,
      };
    }
    if (gate.kind === "no_tenants") {
      return {
        kind: "skipped_no_tenants",
        reason: "NO_CHAIN_ENABLED_TENANTS",
        everChainEnabled: gate.everChainEnabled,
        chainEnabledTenantCount: 0,
      };
    }
    if (gate.attempts > AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP) {
      log.error(
        {
          boundary: boundaryIso,
          attempts: gate.attempts,
          _logType: "audit-anchor-publisher.upload_cap_reached",
        },
        "audit-anchor-publisher.upload_cap_reached",
      );
      // One row per boundary: only the first run past the cap writes it.
      if (gate.attempts === AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP + 1) {
        await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED, {
          failureReason: "UPLOAD_ATTEMPT_CAP_REACHED",
          attempts: gate.attempts,
          anchoredAt: boundaryIso,
        });
      }
      return {
        kind: "upload_cap_reached",
        reason: "UPLOAD_ATTEMPT_CAP_REACHED",
        attempts: gate.attempts,
        chainEnabledTenantCount: gate.chainEnabledTenantCount,
      };
    }

    // Step 2: the publish transaction, upload inside.
    const now = new Date();
    const prevBoundary = new Date(boundary.getTime() - config.cadenceMs);
    const pendingEmits: PendingEmit[] = [];
    let chainEnabledTenantCount: number | null = gate.chainEnabledTenantCount;
    let tenantsInManifest: string[] = [];
    let artifactKey = "";
    let uploadFailedReason: string | null = null;
    let uploaded = false;

    try {
      const outcome = await this.prisma.$transaction(async (tx): Promise<CadenceOutcome> => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        const tenantIds = await chainEnabledTenantIds(tx);
        chainEnabledTenantCount = tenantIds.length;
        await setLockTimeout(tx, this.lockTimeoutMs);
        await advisoryXactLock(tx, ADVISORY_LOCK_KEY);
        await config.hooks?.inTx?.(tx);

        // Another run may have published between the two transactions.
        if (await isBoundaryPublished(tx, boundary, tenantIds)) {
          return {
            kind: "skipped_already_published",
            reason: "BOUNDARY_ALREADY_PUBLISHED",
            chainEnabledTenantCount: tenantIds.length,
          };
        }
        if (tenantIds.length === 0) {
          const anyAnchor = await tx.auditChainAnchor.findFirst({ select: { tenantId: true } });
          return {
            kind: "skipped_no_tenants",
            reason: "NO_CHAIN_ENABLED_TENANTS",
            everChainEnabled: anyAnchor !== null,
            chainEnabledTenantCount: 0,
          };
        }

        // Cadence-end safety net — informational, never aborts.
        if (prevBoundary.getTime() > config.publishOffsetMs) {
          const maxPublishedRows = await tx.$queryRaw<{ max_published: Date | null }[]>`
            SELECT MAX(last_published_at) AS max_published
            FROM audit_chain_anchors
            WHERE last_published_at IS NOT NULL
              AND tenant_id = ANY(${tenantIds}::uuid[])
          `;
          const maxPublished = maxPublishedRows[0]?.max_published;
          if (!maxPublished || maxPublished.getTime() < prevBoundary.getTime()) {
            log.warn(
              {
                prevCadenceBoundary: prevBoundary.toISOString(),
                maxPublished,
                _logType: "audit-anchor-publisher.missing_prior_cadence",
              },
              "audit-anchor-publisher.missing_prior_cadence",
            );
            pendingEmits.push({
              action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
              metadata: {
                failureReason: "MISSING_PRIOR_CADENCE_PUBLICATION",
                prevCadenceBoundary: prevBoundary.toISOString(),
                maxPublishedAt: maxPublished?.toISOString() ?? null,
              },
            });
          }
        }

        // Every chain-enabled tenant is published. A pause holds chain
        // advancement in the outbox worker; it no longer holds publishing.
        // Ordered, so a retry over an unchanged chain signs the same bytes.
        const anchors = await tx.auditChainAnchor.findMany({
          where: { tenantId: { in: tenantIds } },
          orderBy: { tenantId: "asc" },
        });
        const rows: AnchorRow[] = anchors.map((a) => ({
          tenantId: a.tenantId,
          chainSeq: a.chainSeq,
          prevHash: Buffer.from(a.prevHash),
          epoch: a.epoch ?? 1,
        }));

        const prevManifestRow = await tx.systemSetting.findUnique({
          where: { key: SETTING_PREVIOUS_MANIFEST },
        });
        const previousManifest = prevManifestRow
          ? previousManifestSchema.parse(JSON.parse(prevManifestRow.value))
          : null;

        const manifest = buildManifest({
          tenants: rows,
          deploymentId: config.deploymentId,
          anchoredAt: boundary,
          previousManifest,
          tagSecret: config.tagSecret,
        });

        const canonicalBytes = canonicalize(manifest);
        const jws = sign(canonicalBytes, config.signingKey, config.signingKeyKid);

        const manifestSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
        artifactKey = buildManifestArtifactKey(boundary, config.signingKeyKid);
        const artifactBytes = Buffer.from(jws, "utf-8");
        tenantsInManifest = anchors.map((a) => a.tenantId);

        // Upload to all destinations, bounded as a whole. A rollback after
        // this point leaves the object stored; the marker keeps the retry
        // idempotent and versioning keeps the earlier PUT.
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new UploadTimeoutError()),
          config.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
        );
        try {
          for (const dest of config.destinations) {
            try {
              await untilAborted(
                dest.upload({
                  artifactBytes,
                  artifactKey,
                  contentType: "application/jose",
                  signal: controller.signal,
                }),
                controller.signal,
              );
            } catch (uploadErr) {
              log.error(
                {
                  destination: dest.name,
                  error: errorLogFields(uploadErr),
                  _logType: "audit-anchor-publisher.upload_failed",
                },
                "audit-anchor-publisher.upload_failed",
              );
              // Token, not narrative: this value is persisted to
              // audit_logs.metadata.failureReason, which the tenant reads via
              // /api/tenant/audit-logs. Which destination failed and with what
              // code is what diagnosis needs; the `error` field and `_logType`
              // above carry the rest.
              uploadFailedReason = `${dest.name}_UPLOAD_FAILED:${errorLogFields(uploadErr).code}`;
              throw new Error(uploadFailedReason);
            }
          }
        } finally {
          clearTimeout(timer);
        }
        uploaded = true;
        await config.hooks?.afterUpload?.();

        // Determine primary URI (first destination)
        const firstDestination = config.destinations[0];
        const primaryUri = firstDestination
          ? `${firstDestination.name}://${artifactKey}`
          : `local://${artifactKey}`;

        await tx.auditChainAnchor.updateMany({
          where: { tenantId: { in: tenantsInManifest } },
          data: { lastPublishedAt: now, publishPausedUntil: null },
        });

        const manifestPtr = JSON.stringify({ uri: primaryUri, sha256: manifestSha256 });
        await tx.systemSetting.upsert({
          where: { key: SETTING_PREVIOUS_MANIFEST },
          update: { value: manifestPtr },
          create: { key: SETTING_PREVIOUS_MANIFEST, value: manifestPtr },
        });
        await tx.systemSetting.upsert({
          where: { key: SETTING_LAST_PUBLISHED_BOUNDARY },
          update: { value: boundaryIso },
          create: { key: SETTING_LAST_PUBLISHED_BOUNDARY, value: boundaryIso },
        });

        return {
          kind: "published",
          manifestSha256,
          destinations: config.destinations.map((d) => d.name),
          tenantsCount: tenantsInManifest.length,
          chainEnabledTenantCount: tenantIds.length,
        };
      }, this.txOptions);

      await this.flushEmits(pendingEmits);

      // Success audit event AFTER the transaction commits
      if (outcome.kind === "published") {
        await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISHED, {
          manifestSha256: outcome.manifestSha256,
          destinations: outcome.destinations,
          tenantsCount: outcome.tenantsCount,
          artifactKey,
          anchoredAt: boundaryIso,
        });
      }

      return outcome;
    } catch (err) {
      await this.flushEmits(pendingEmits);

      if (!uploaded && isLockNotAvailable(err)) {
        return this.lockHeld(boundary, chainEnabledTenantCount);
      }

      // The catch covers the WHOLE publish transaction — set_config, every
      // Prisma read, the previous-manifest parse, the signing step and the
      // commit — so `err.message` may be a connection string, a query with its
      // bound parameters, or a parser echoing its input. `reason` reaches
      // audit_logs.metadata.failureReason, which the tenant reads; it is a
      // token. `uploadFailedReason` already carries the driver's code, and the
      // per-destination `upload_failed` line carries the original error.
      if (uploaded) {
        // Stored but not committed: the next manifest will not reference this
        // version, and the retry for the boundary re-PUTs the key. No pause —
        // the destination is healthy.
        const reason = `COMMIT_FAILED_AFTER_UPLOAD:${errorLogFields(err).code}`;
        log.error(
          {
            boundary: boundaryIso,
            artifactKey,
            error: errorLogFields(err),
            _logType: "audit-anchor-publisher.commit_failed_after_upload",
          },
          "audit-anchor-publisher.commit_failed_after_upload",
        );
        return this.fail(boundary, { reason, stage: "after_upload", chainEnabledTenantCount, artifactKey });
      }

      if (uploadFailedReason && tenantsInManifest.length > 0) {
        await this.persistPause(tenantsInManifest, now);
      }
      const reason = uploadFailedReason ?? `CADENCE_FAILED:${errorLogFields(err).code}`;
      return this.fail(boundary, {
        reason,
        stage: uploadFailedReason ? "upload" : "before_upload",
        chainEnabledTenantCount,
        artifactKey: artifactKey || null,
      });
    }
  }

  private lockHeld(boundary: Date, chainEnabledTenantCount: number | null): CadenceOutcome {
    getLogger().info(
      { boundary: boundary.toISOString(), _logType: "audit-anchor-publisher.lock_held" },
      "audit-anchor-publisher.lock_held",
    );
    return { kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE", chainEnabledTenantCount };
  }

  private async fail(
    boundary: Date,
    failure: { reason: string; stage: FailureStage; chainEnabledTenantCount: number | null; artifactKey: string | null },
  ): Promise<CadenceOutcome> {
    getLogger().error(
      { reason: failure.reason, stage: failure.stage, _logType: "audit-anchor-publisher.cadence_failed" },
      "audit-anchor-publisher.cadence_failed",
    );
    await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED, {
      failureReason: failure.reason,
      artifactKey: failure.artifactKey,
      anchoredAt: boundary.toISOString(),
    });
    return {
      kind: "failed",
      reason: failure.reason,
      stage: failure.stage,
      chainEnabledTenantCount: failure.chainEnabledTenantCount,
    };
  }

  private async flushEmits(pendingEmits: PendingEmit[]): Promise<void> {
    for (const { action, metadata } of pendingEmits.splice(0)) {
      await this.emitAudit(action, metadata);
    }
  }

  /**
   * Persist the pause after an upload failure, in a SEPARATE transaction — the
   * publish transaction rolled back, and its writes with it. It lasts until the
   * next boundary by the wall clock, holding chain advancement in the outbox
   * worker until a retry or the next boundary publishes.
   */
  private async persistPause(tenantIds: string[], now: Date): Promise<void> {
    const { config } = this;
    const pauseUntil = new Date(
      currentCadenceBoundary(now, config.cadenceMs, config.publishOffsetMs).getTime() + config.cadenceMs,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        // Guard against another instance having published between our
        // rollback and this write: its success set `lastPublishedAt` past
        // `now` and cleared the pause, which must not be overwritten.
        await tx.auditChainAnchor.updateMany({
          where: {
            tenantId: { in: tenantIds },
            OR: [
              { lastPublishedAt: null },
              { lastPublishedAt: { lt: now } },
            ],
          },
          data: { publishPausedUntil: pauseUntil },
        });
      }, this.txOptions);
    } catch (pauseErr) {
      // Observability only — the run already failed, and the next run's
      // safety net detects the missing cadence. Do not mask the original.
      getLogger().error(
        {
          error: errorLogFields(pauseErr),
          _logType: "audit-anchor-publisher.pause_persist_failed",
        },
        "audit-anchor-publisher.pause_persist_failed",
      );
    }
  }
}

// --- createPublisher factory ---

export function createPublisher(config: PublisherConfig): {
  publisher: AuditAnchorPublisher;
  prisma: PrismaClient;
  shutdown: () => Promise<void>;
} {
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 3,
    idleTimeoutMillis: WORKER_POOL_IDLE_TIMEOUT_MS,
    statement_timeout: WORKER_POOL_STATEMENT_TIMEOUT_MS,
    application_name: "passwd-sso-audit-anchor-publisher",
  });

  pool.on("error", (err) => {
    getLogger().error(
      {
        code: (err as NodeJS.ErrnoException | undefined)?.code,
        _logType: "audit-anchor-publisher.pool.error",
      },
      "audit-anchor-publisher.pool.error",
    );
  });

  const prisma = createPrismaClient(pool);
  const publisher = new AuditAnchorPublisher({ prisma, config });

  async function shutdown(): Promise<void> {
    await prisma.$disconnect();
    await pool.end();
  }

  return { publisher, prisma, shutdown };
}
