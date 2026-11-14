import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { AuditAction, Prisma, PrismaClient } from "@prisma/client";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  AUDIT_ANCHOR_MIRROR_BACKFILL_MAX,
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
  computeTenantTag,
  kidForPublicKey,
  publicKeyForSigningKey,
  sign,
  type AnchorRow,
  type Manifest,
} from "@/lib/audit/anchor-manifest";
import {
  ANCHOR_ARTIFACT_CONTENT_TYPE,
  buildManifestArtifactKey,
  parseManifestArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import {
  PublishedObjectUnverifiableError,
  createAnchorKeyCache,
  publishedStateFromListing,
  readVerifiedManifest,
  type OwnKey,
  type PublishedState,
  type VerifiedManifest,
} from "@/lib/audit/anchor-published-state";
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

/** The bound on a run's destination I/O fired. Its `code` is what the failure reason carries. */
class UploadTimeoutError extends Error {
  readonly code = "UPLOAD_TIMEOUT";
  constructor() {
    super("anchor destination I/O exceeded the run's time bound");
    this.name = "UploadTimeoutError";
  }
}

/** A failure named by a token: its `code` is what a log line or failure reason carries. */
class TokenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TokenError";
  }
}

/**
 * The fault token of a destination error. An AWS SDK service exception carries
 * its fault in `name` (`AccessDenied`) and has no `code`, so the shared reader
 * alone would report every S3 refusal as `unknown`.
 */
function destinationFaultCode(err: unknown): string {
  const fields = errorLogFields(err);
  if (fields.code !== "unknown") return fields.code;
  return typeof err === "object" && err !== null && "$metadata" in err ? fields.name : fields.code;
}

/**
 * A run that ends `failed`. Thrown inside the publish transaction so that it
 * rolls back. `reason` is a token: it reaches audit_logs.metadata.failureReason,
 * which the tenant reads. `pauseTenantIds` are paused after the rollback.
 */
class RunFailure extends Error {
  constructor(
    readonly reason: string,
    readonly stage: FailureStage,
    readonly pauseTenantIds: string[] = [],
  ) {
    super(reason);
    this.name = "RunFailure";
  }
}

// --- Constants ---

/** The publish lock's key, hashed by `advisoryXactLock`. */
export const ADVISORY_LOCK_KEY = "audit-anchor-publish";
const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";

export const SETTING_DEPLOYMENT_ID = "audit_anchor_deployment_id";
export const SETTING_UPLOAD_ATTEMPTS = "audit_anchor_upload_attempts";

/** Runs per boundary that may reach the publish transaction; the next one reports the cap. */
export const AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP = 3;

export const DEFAULT_LOCK_TIMEOUT_MS = 10 * MS_PER_SECOND;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 60 * MS_PER_SECOND;
export const DEFAULT_TX_TIMEOUT_MS = 90 * MS_PER_SECOND;

/** The dead-letter reason for an emit whose outbox write failed. */
export const PUBLISHER_AUDIT_DEAD_LETTER_REASON = "anchor_publisher_emit_failed";

// --- Public types ---

/**
 * Every chain-enabled tenant, with or without an anchor row — not the number a
 * run publishes. `null` only where the run failed before it could read the
 * tenants.
 */
type TenantCount = { chainEnabledTenantCount: number | null };

/** Where a failed run stopped. */
export type FailureStage = "before_upload" | "upload" | "after_upload";

export type CadenceOutcome =
  | ({ kind: "published"; manifestSha256: string; destinations: string[]; tenantsCount: number; adopted: boolean } & TenantCount)
  | ({ kind: "lock_held"; reason: "LOCK_HELD_BY_OTHER_INSTANCE" } & TenantCount)
  | ({ kind: "skipped_already_published"; reason: "BOUNDARY_ALREADY_PUBLISHED" } & TenantCount)
  | ({ kind: "skipped_no_tenants"; reason: "NO_CHAIN_ENABLED_TENANTS"; everChainEnabled: boolean } & TenantCount)
  | ({ kind: "upload_cap_reached"; reason: "UPLOAD_ATTEMPT_CAP_REACHED"; attempts: number } & TenantCount)
  | ({ kind: "failed"; reason: string; stage: FailureStage } & TenantCount);

/**
 * Test seams. Production passes none. `inTx` runs inside the publish
 * transaction once the advisory lock is held; `afterUpload` runs once the
 * primary holds the boundary's object and every mirror holds the same bytes,
 * before the database writes, so a throw there is a commit lost after the
 * upload.
 */
export type PublisherHooks = {
  inTx?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterUpload?: () => Promise<void>;
};

export type PublisherConfig = {
  databaseUrl: string;
  deploymentId: string;
  signingKey: Buffer;
  tagSecret: Buffer;
  destinations: AnchorDestination[];
  cadenceMs: number;
  publishOffsetMs: number;
  /** `SET LOCAL lock_timeout` before the advisory lock. Default 10 s. */
  lockTimeoutMs?: number;
  /** One bound on all destination I/O of a run, armed at its first destination call. Default 60 s. */
  uploadTimeoutMs?: number;
  /** Bound on each transaction. Default 90 s. */
  txTimeoutMs?: number;
  /** Wall clock in epoch ms. Default `Date.now`. */
  now?: () => number;
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

// --- Internals ---

const uploadAttemptsSchema = z.object({
  boundary: z.string(),
  count: z.number().int().positive(),
});

const UNREADABLE = Symbol("unreadable");

function parseUploadAttempts(raw: string): z.infer<typeof uploadAttemptsSchema> | typeof UNREADABLE {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  const parsed = uploadAttemptsSchema.safeParse(json);
  return parsed.success ? parsed.data : UNREADABLE;
}

type PendingEmit = { action: AuditAction; metadata: Record<string, unknown> };

type AttemptGate =
  | { kind: "no_tenants"; chainEnabledTenantCount: number }
  | { kind: "counted"; attempts: number; countUnreadable: boolean; chainEnabledTenantCount: number };

/** How the latest manifest on the run's own date differs from this publisher's. */
type OtherIdentity = { artifactKey: string; kidMatches: boolean; deploymentMatches: boolean };

/** Rows f–j of the decision table; rows a–e are thrown as a RunFailure. */
type Decision =
  | { kind: "skip"; otherIdentity?: OtherIdentity }
  | { kind: "adopt"; state: PublishedState; latest: VerifiedManifest }
  | { kind: "publish"; state: PublishedState };

type PublishTxResult =
  | { kind: "no_tenants"; chainEnabledTenantCount: number }
  | { kind: "skip"; otherIdentity?: OtherIdentity; chainEnabledTenantCount: number }
  | {
      kind: "published";
      published: VerifiedManifest;
      /** The primary's bytes were not written by this run. */
      adopted: boolean;
      /** The manifest this run chained to, when it built the bytes itself. */
      chainedTo: VerifiedManifest | null;
      state: PublishedState;
      /** The primary's listing the decision was made from. */
      listedKeys: string[];
      /** The published high-water the decision was made from, before this run's write. */
      highWater: Date | null;
      chainEnabledTenantCount: number;
    };

/** The previous manifest a stored one names could not be read back and held to its hash. */
const PREVIOUS_UNAVAILABLE = Symbol("previous manifest unavailable");
type ComparedTo = VerifiedManifest | null | typeof PREVIOUS_UNAVAILABLE;

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

type RunTenants = {
  /** Every chain-enabled tenant: what the cadence line reports. */
  chainEnabledCount: number;
  /** Those of them that have an anchor row: the tenants a run publishes. */
  anchoredIds: string[];
};

/**
 * The run's tenant set: the chain-enabled tenants that have an anchor row.
 * The outbox worker creates the row with a tenant's first chained event, so
 * an enabled tenant without one has nothing to anchor yet. A run with no
 * anchored tenant takes the no-tenant path: a zero-tenant manifest covers no
 * row, so it could never settle and every restart would be a counted adopt.
 */
async function chainEnabledTenants(tx: Prisma.TransactionClient): Promise<RunTenants> {
  const tenants = await tx.tenant.findMany({
    where: { auditChainEnabled: true },
    select: { id: true },
  });
  const anchors = await tx.auditChainAnchor.findMany({
    where: { tenantId: { in: tenants.map((t) => t.id) } },
    select: { tenantId: true },
  });
  return { chainEnabledCount: tenants.length, anchoredIds: anchors.map((a) => a.tenantId) };
}

/**
 * The published high-water: the greatest `last_published_at` of ANY anchor
 * row, whatever its tenant's flag — a disabled tenant's row still records a
 * publish.
 */
async function publishedHighWater(tx: Prisma.TransactionClient): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ max_published: Date | null }[]>`
    SELECT MAX(last_published_at) AS max_published FROM audit_chain_anchors
  `;
  return rows[0]?.max_published ?? null;
}

function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The artifact key a `previousManifest.uri` names: what follows `://`. */
function artifactKeyOfUri(uri: string): string {
  return uri.slice(uri.indexOf("://") + 3);
}

/** The manifest key a `previousManifest.uri` names, or null when it names none. */
function previousManifestKey(manifest: Manifest): { date: string; kid: string } | null {
  const uri = manifest.previousManifest?.uri;
  if (uri === undefined) return null;
  return parseManifestArtifactKey(artifactKeyOfUri(uri));
}

/**
 * One deadline for all destination I/O of a run, armed at the run's first
 * destination call: the listings, the reads, the creates and the mirror
 * backfill share it, so a run's worst case does not grow with their number.
 */
class DestinationBound {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number) {}

  /** Run one destination call under the deadline; rejects when it fires, whether or not `work` honours the signal. */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { signal } = this.controller;
    // Not started at all once the deadline has fired: a call started with an
    // aborted signal would reject with nobody awaiting it.
    if (signal.aborted) return Promise.reject(signal.reason);
    this.timer ??= setTimeout(() => this.controller.abort(new UploadTimeoutError()), this.timeoutMs);
    return untilAborted((async () => work(signal))(), signal);
  }

  release(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

// --- Publisher class ---

export class AuditAnchorPublisher {
  private readonly prisma: PrismaClient;
  private readonly config: PublisherConfig;

  // Per instance, never module-level: two publishers in one process (a test,
  // a key change) must not share what the other resolved or reported.
  private derivedOwnKey: OwnKey | null = null;
  private otherIdentityReportedFor: string | null = null;

  constructor(deps: { prisma: PrismaClient; config: PublisherConfig }) {
    this.prisma = deps.prisma;
    this.config = deps.config;
  }

  /** The source of truth: the first configured destination. */
  private get primary(): AnchorDestination {
    const primary = this.config.destinations[0];
    if (!primary) throw new TokenError("NO_DESTINATION");
    return primary;
  }

  private get mirrors(): AnchorDestination[] {
    return this.config.destinations.slice(1);
  }

  /**
   * Derived on first use, inside a run. The entrypoint derives the same key for
   * its boot line, so a signing key that is not a key stops the process at boot
   * (scripts/audit-anchor-publisher.ts); this getter alone would fail the run.
   */
  private get ownKey(): OwnKey {
    this.derivedOwnKey ??= {
      publicKey: publicKeyForSigningKey(this.config.signingKey),
      keyCache: createAnchorKeyCache(),
    };
    return this.derivedOwnKey;
  }

  private get ownKid(): string {
    return kidForPublicKey(this.ownKey.publicKey);
  }

  private get lockTimeoutMs(): number {
    return this.config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  private get txOptions(): { timeout: number } {
    return { timeout: this.config.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS };
  }

  private wallClock(): Date {
    return new Date((this.config.now ?? Date.now)());
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
        VALUES (${SETTING_DEPLOYMENT_ID}, ${deploymentId}, now())
        ON CONFLICT (key) DO NOTHING
      `;

      const rows = await tx.$queryRaw<{ value: string }[]>`
        SELECT value FROM system_settings WHERE key = ${SETTING_DEPLOYMENT_ID}
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
   * the create undoes it. Takes the publish lock, and does not count a run
   * with nothing to publish.
   */
  private async claimAttempt(boundary: Date): Promise<AttemptGate> {
    let tenantCount: number | null = null;
    try {
      return await this.prisma.$transaction(async (tx): Promise<AttemptGate> => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        const tenants = await chainEnabledTenants(tx);
        tenantCount = tenants.chainEnabledCount;
        await setLockTimeout(tx, this.lockTimeoutMs);
        await advisoryXactLock(tx, ADVISORY_LOCK_KEY);

        if (tenants.anchoredIds.length === 0) {
          return { kind: "no_tenants", chainEnabledTenantCount: tenants.chainEnabledCount };
        }

        // Read-then-write is safe under the advisory lock every publisher
        // takes. A stored value that does not parse cannot say how many runs
        // reached the publish transaction, so this boundary is treated as past
        // the cap: the value is overwritten with the first count past it, and
        // the next boundary starts again at 1. Failing the run instead would
        // leave the value in place and wedge every boundary, uncounted.
        const boundaryIso = boundary.toISOString();
        const storedRow = await tx.systemSetting.findUnique({ where: { key: SETTING_UPLOAD_ATTEMPTS } });
        const previous = storedRow ? parseUploadAttempts(storedRow.value) : null;
        const countUnreadable = previous === UNREADABLE;
        const count = countUnreadable
          ? AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP + 1
          : previous?.boundary === boundaryIso
            ? previous.count + 1
            : 1;
        const value = JSON.stringify({ boundary: boundaryIso, count });
        await tx.systemSetting.upsert({
          where: { key: SETTING_UPLOAD_ATTEMPTS },
          update: { value },
          create: { key: SETTING_UPLOAD_ATTEMPTS, value },
        });
        return { kind: "counted", attempts: count, countUnreadable, chainEnabledTenantCount: tenants.chainEnabledCount };
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
    const bound = new DestinationBound(this.config.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
    try {
      return await this.runBounded(boundary, bound);
    } finally {
      bound.release();
    }
  }

  private async listPrimary(bound: DestinationBound): Promise<string[]> {
    const primary = this.primary;
    try {
      return await bound.run((signal) => primary.list(signal));
    } catch (err) {
      throw this.readFailure(primary, err);
    }
  }

  /** Rows a and b: a destination read that failed, or an object that does not verify. */
  private readFailure(dest: AnchorDestination, err: unknown): RunFailure {
    if (err instanceof PublishedObjectUnverifiableError) {
      getLogger().error(
        {
          artifactKey: err.artifactKey,
          detail: err.detail,
          _logType: "audit-anchor-publisher.published_object_unverifiable",
        },
        "audit-anchor-publisher.published_object_unverifiable",
      );
      return new RunFailure(`CADENCE_FAILED:${err.code}`, "before_upload");
    }
    return new RunFailure(`${dest.name}_READ_FAILED:${destinationFaultCode(err)}`, "before_upload");
  }

  private isOurs(manifest: VerifiedManifest): boolean {
    return manifest.kid === this.ownKid && manifest.manifest.deploymentId === this.config.deploymentId;
  }

  private otherIdentityOf(manifest: VerifiedManifest): OtherIdentity {
    return {
      artifactKey: manifest.artifactKey,
      kidMatches: manifest.kid === this.ownKid,
      deploymentMatches: manifest.manifest.deploymentId === this.config.deploymentId,
    };
  }

  /**
   * The decision table for `boundary`, first match wins, from what the primary
   * holds (`listedKeys`) and the published high-water. `last_published_at` can
   * make a run refuse (d1, d2) or adopt again (i); it never produces a skip.
   * Rows a–e throw a RunFailure.
   */
  private async decide(
    boundary: Date,
    highWater: Date | null,
    listedKeys: string[],
    bound: DestinationBound,
  ): Promise<Decision> {
    const { config } = this;
    const primary = this.primary;
    const ownKey = this.ownKey;
    const refuse = (code: string) => new RunFailure(`CADENCE_FAILED:${code}`, "before_upload");

    let state: PublishedState;
    try {
      state = await bound.run((signal) => publishedStateFromListing(primary, ownKey, listedKeys, signal));
    } catch (err) {
      throw this.readFailure(primary, err);
    }
    const { latest } = state;

    const wallBoundary = currentCadenceBoundary(this.wallClock(), config.cadenceMs, config.publishOffsetMs);
    const highWaterBoundary =
      highWater === null ? null : currentCadenceBoundary(highWater, config.cadenceMs, config.publishOffsetMs);
    const date = utcDate(boundary);

    if (latest && latest.date > utcDate(wallBoundary)) throw refuse("PUBLISHED_OBJECT_AHEAD");
    if (highWaterBoundary) {
      // No publish this clock allows wrote it.
      if (highWaterBoundary.getTime() > wallBoundary.getTime()) throw refuse("LAST_PUBLISHED_AHEAD_OF_CLOCK");
      // The database records a publish the primary does not hold.
      if (!latest || latest.date < utcDate(highWaterBoundary)) throw refuse("DESTINATION_BEHIND_DATABASE");
    }
    if (latest && latest.kid !== this.ownKid && state.ownKidHasPublished) throw refuse("LATEST_UNDER_RETIRED_KEY");

    if (!latest || latest.date < date) return { kind: "publish", state };
    if (latest.date > date) {
      getLogger().warn(
        {
          boundary: boundary.toISOString(),
          latestArtifactKey: latest.artifactKey,
          _logType: "audit-anchor-publisher.stale_boundary",
        },
        "audit-anchor-publisher.stale_boundary",
      );
      return { kind: "skip" };
    }
    if (!this.isOurs(latest)) return { kind: "skip", otherIdentity: this.otherIdentityOf(latest) };
    const settled = highWaterBoundary !== null && highWaterBoundary.getTime() >= boundary.getTime();
    return settled ? { kind: "skip" } : { kind: "adopt", state, latest };
  }

  /**
   * A skip is never the healthy line. One on an object another identity
   * published (row g) is warned every run and written as one audit row per
   * boundary per publisher instance.
   */
  private async skipAlreadyPublished(
    boundary: Date,
    otherIdentity: OtherIdentity | undefined,
    chainEnabledTenantCount: number,
  ): Promise<CadenceOutcome> {
    const boundaryIso = boundary.toISOString();
    if (otherIdentity) {
      getLogger().warn(
        { boundary: boundaryIso, ...otherIdentity, _logType: "audit-anchor-publisher.published_by_other_identity" },
        "audit-anchor-publisher.published_by_other_identity",
      );
      if (this.otherIdentityReportedFor !== boundaryIso) {
        this.otherIdentityReportedFor = boundaryIso;
        await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED, {
          failureReason: "PUBLISHED_BY_OTHER_IDENTITY",
          artifactKey: otherIdentity.artifactKey,
          anchoredAt: boundaryIso,
        });
      }
    }
    return { kind: "skipped_already_published", reason: "BOUNDARY_ALREADY_PUBLISHED", chainEnabledTenantCount };
  }

  /**
   * The value a publish for `boundary` writes to `last_published_at`: the wall
   * clock clamped into [boundary, boundary + cadence), so it always maps to
   * the boundary whose object was stored — a run that crosses into the next
   * boundary must not record a publish the destination does not hold.
   */
  private publishTime(boundary: Date): Date {
    const first = boundary.getTime();
    const last = first + this.config.cadenceMs - 1;
    return new Date(Math.min(Math.max(this.wallClock().getTime(), first), last));
  }

  /** Give every mirror the primary's bytes; one holding other bytes for the key fails the run. */
  private async mirrorToSecondaries(published: VerifiedManifest, coveredTenantIds: string[], bound: DestinationBound): Promise<void> {
    for (const secondary of this.mirrors) {
      let result: "created" | "exists";
      try {
        result = await bound.run((signal) =>
          secondary.create({
            artifactBytes: published.bytes,
            artifactKey: published.artifactKey,
            contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
            signal,
          }),
        );
      } catch (err) {
        throw this.uploadFailure(secondary, err, coveredTenantIds);
      }
      if (result === "created") continue;

      let stored: Buffer | null;
      try {
        stored = await bound.run((signal) => secondary.read(published.artifactKey, signal));
      } catch (err) {
        throw new RunFailure(`${secondary.name}_READ_FAILED:${destinationFaultCode(err)}`, "upload", coveredTenantIds);
      }
      if (!stored?.equals(published.bytes)) {
        throw new RunFailure(`${secondary.name}_MIRROR_DIVERGED`, "upload", coveredTenantIds);
      }
    }
  }

  private uploadFailure(dest: AnchorDestination, err: unknown, pauseTenantIds: string[]): RunFailure {
    getLogger().error(
      {
        destination: dest.name,
        error: errorLogFields(err),
        _logType: "audit-anchor-publisher.upload_failed",
      },
      "audit-anchor-publisher.upload_failed",
    );
    // Which destination failed and with what code is what diagnosis needs;
    // the line above carries the rest.
    return new RunFailure(`${dest.name}_UPLOAD_FAILED:${destinationFaultCode(err)}`, "upload", pauseTenantIds);
  }

  private async runBounded(boundary: Date, bound: DestinationBound): Promise<CadenceOutcome> {
    const { config } = this;
    const log = getLogger();
    const boundaryIso = boundary.toISOString();
    let chainEnabledTenantCount: number | null = null;

    // Steps 1 and 2: what only the database knows, read without the lock, then
    // what the primary holds. Nothing is counted yet.
    let everChainEnabled: boolean;
    try {
      const view = await this.prisma.$transaction(async (tx) => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        return {
          tenants: await chainEnabledTenants(tx),
          highWater: await publishedHighWater(tx),
          anyAnchor: (await tx.auditChainAnchor.findFirst({ select: { tenantId: true } })) !== null,
        };
      }, this.txOptions);
      chainEnabledTenantCount = view.tenants.chainEnabledCount;

      const listedKeys = await this.listPrimary(bound);
      // Every skipped_no_tenants of this run reports this one value. A
      // manifest key at the primary counts, so deleting the anchor rows does
      // not turn the skip healthy; the listing alone decides, nothing is read.
      everChainEnabled = view.anyAnchor || listedKeys.some((key) => parseManifestArtifactKey(key) !== null);
      if (view.tenants.anchoredIds.length === 0) return this.noTenants(everChainEnabled, chainEnabledTenantCount);

      const decision = await this.decide(boundary, view.highWater, listedKeys, bound);
      if (decision.kind === "skip") {
        return await this.skipAlreadyPublished(boundary, decision.otherIdentity, chainEnabledTenantCount);
      }
    } catch (err) {
      const reason = err instanceof RunFailure ? err.reason : `CADENCE_FAILED:${errorLogFields(err).code}`;
      return this.fail(boundary, { reason, stage: "before_upload", chainEnabledTenantCount, artifactKey: null });
    }

    // Step 3: the attempt count, committed before anything is created.
    let gate: AttemptGate;
    try {
      gate = await this.claimAttempt(boundary);
    } catch (err) {
      if (err instanceof LockHeldSignal) {
        return this.lockHeld(boundary, err.chainEnabledTenantCount);
      }
      const reason = `CADENCE_FAILED:${errorLogFields(err).code}`;
      return this.fail(boundary, { reason, stage: "before_upload", chainEnabledTenantCount, artifactKey: null });
    }

    if (gate.kind === "no_tenants") return this.noTenants(everChainEnabled, gate.chainEnabledTenantCount);
    if (gate.attempts > AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP) {
      log.error(
        {
          boundary: boundaryIso,
          attempts: gate.attempts,
          countUnreadable: gate.countUnreadable,
          _logType: "audit-anchor-publisher.upload_cap_reached",
        },
        "audit-anchor-publisher.upload_cap_reached",
      );
      // One row per boundary: only the first run past the cap writes it.
      if (gate.attempts === AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP + 1) {
        await this.emitAudit(AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED, {
          failureReason: gate.countUnreadable ? "UPLOAD_ATTEMPT_COUNT_UNREADABLE" : "UPLOAD_ATTEMPT_CAP_REACHED",
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

    // Step 4: the publish transaction. Under the lock the database and the
    // primary are read again and the table decided again, so a second
    // instance that waited behind a publish skips.
    const primary = this.primary;
    const prevBoundary = new Date(boundary.getTime() - config.cadenceMs);
    const pendingEmits: PendingEmit[] = [];
    chainEnabledTenantCount = gate.chainEnabledTenantCount;
    let artifactKey: string | null = null;
    // The primary holds the boundary's object, written by this run or found there.
    let primaryStored = false;
    let uploaded = false;

    try {
      const result = await this.prisma.$transaction(async (tx): Promise<PublishTxResult> => {
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH, { tenantId: SYSTEM_TENANT_ID });
        const tenants = await chainEnabledTenants(tx);
        const tenantIds = tenants.anchoredIds;
        const tenantCount = tenants.chainEnabledCount;
        chainEnabledTenantCount = tenantCount;
        await setLockTimeout(tx, this.lockTimeoutMs);
        await advisoryXactLock(tx, ADVISORY_LOCK_KEY);
        await config.hooks?.inTx?.(tx);

        if (tenantIds.length === 0) return { kind: "no_tenants", chainEnabledTenantCount: tenantCount };
        const highWater = await publishedHighWater(tx);
        const listedKeys = await this.listPrimary(bound);
        const decision = await this.decide(boundary, highWater, listedKeys, bound);
        if (decision.kind === "skip") return { ...decision, chainEnabledTenantCount: tenantCount };

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
                anchoredAt: boundaryIso,
              },
            });
          }
        }

        let published: VerifiedManifest;
        let adopted = true;
        let chainedTo: VerifiedManifest | null = null;
        if (decision.kind === "adopt") {
          published = decision.latest;
          artifactKey = published.artifactKey;
          primaryStored = true;
        } else {
          // Every chain-enabled tenant with an anchor row is published. A
          // pause holds chain advancement in the outbox worker; it does not
          // hold publishing.
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

          // The prefix holds one chain: a previous manifest from another
          // deployment id is chained to, and said.
          const previous = decision.state.latest;
          if (previous && previous.manifest.deploymentId !== config.deploymentId) {
            log.warn(
              {
                boundary: boundaryIso,
                previousArtifactKey: previous.artifactKey,
                _logType: "audit-anchor-publisher.previous_manifest_deployment_changed",
              },
              "audit-anchor-publisher.previous_manifest_deployment_changed",
            );
          }

          const manifest = buildManifest({
            tenants: rows,
            deploymentId: config.deploymentId,
            anchoredAt: boundary,
            previousManifest: previous
              ? { uri: `${primary.name}://${previous.artifactKey}`, sha256: previous.sha256 }
              : null,
            tagSecret: config.tagSecret,
          });
          const canonicalBytes = canonicalize(manifest);
          const artifactBytes = Buffer.from(sign(canonicalBytes, config.signingKey), "utf-8");
          const key = buildManifestArtifactKey(boundary, this.ownKid);
          artifactKey = key;

          // Create-only. A rollback after this point leaves the object stored;
          // the retry finds it and adopts it instead of writing a second one.
          let created: "created" | "exists";
          try {
            created = await bound.run((signal) =>
              primary.create({ artifactBytes, artifactKey: key, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS, signal }),
            );
          } catch (err) {
            throw this.uploadFailure(primary, err, anchors.map((a) => a.tenantId));
          }

          if (created === "created") {
            primaryStored = true;
            published = {
              artifactKey: key,
              date: utcDate(boundary),
              kid: this.ownKid,
              bytes: artifactBytes,
              manifest,
              sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
            };
            adopted = false;
            chainedTo = previous;
          } else {
            // The key is taken: what is stored decides, not what this run signed.
            try {
              published = await bound.run((signal) =>
                readVerifiedManifest(primary, key, this.ownKey, listedKeys, signal),
              );
            } catch (err) {
              throw this.readFailure(primary, err);
            }
            if (!this.isOurs(published)) {
              return {
                kind: "skip",
                otherIdentity: this.otherIdentityOf(published),
                chainEnabledTenantCount: tenantCount,
              };
            }
            primaryStored = true;
          }
        }

        // The anchor rows the stored manifest covers, by tag and whatever
        // their tenant's flag is now: an adopted manifest may predate a
        // change to the chain-enabled set.
        const tags = new Set(published.manifest.tenants.map((t) => t.tenantTag));
        const anchorRows = await tx.auditChainAnchor.findMany({ select: { tenantId: true } });
        const coveredTenantIds = anchorRows
          .map((a) => a.tenantId)
          .filter((id) => tags.has(computeTenantTag(id, config.tagSecret)));

        await this.mirrorToSecondaries(published, coveredTenantIds, bound);
        uploaded = true;
        await config.hooks?.afterUpload?.();

        await tx.auditChainAnchor.updateMany({
          where: { tenantId: { in: coveredTenantIds } },
          data: { lastPublishedAt: this.publishTime(boundary), publishPausedUntil: null },
        });

        return {
          kind: "published",
          published,
          adopted,
          chainedTo,
          state: decision.state,
          listedKeys,
          highWater,
          chainEnabledTenantCount: tenantCount,
        };
      }, this.txOptions);

      if (result.kind === "no_tenants") return this.noTenants(everChainEnabled, result.chainEnabledTenantCount);
      if (result.kind === "skip") {
        return await this.skipAlreadyPublished(boundary, result.otherIdentity, result.chainEnabledTenantCount);
      }

      // The rows go out AFTER the transaction commits, and only with a
      // publish: a failed run would otherwise write them on every retry.
      const { published } = result;
      const destinations = config.destinations.map((d) => d.name);
      const comparedTo = result.adopted
        ? await this.namedPrevious(published, result.listedKeys, bound)
        : result.chainedTo;
      pendingEmits.push(
        ...this.publishedEmits(result, comparedTo, boundaryIso),
        ...(await this.unsettledEmits(result, comparedTo, boundaryIso, bound)),
      );
      pendingEmits.push({
        action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISHED,
        metadata: {
          manifestSha256: published.sha256,
          destinations,
          tenantsCount: published.manifest.tenants.length,
          artifactKey: published.artifactKey,
          anchoredAt: boundaryIso,
          adopted: result.adopted,
          genesis: published.manifest.previousManifest === null,
        },
      });
      await this.flushEmits(pendingEmits);
      await this.backfillMirrors([...result.state.manifestKeys, published.artifactKey], bound);

      return {
        kind: "published",
        manifestSha256: published.sha256,
        destinations,
        tenantsCount: published.manifest.tenants.length,
        adopted: result.adopted,
        chainEnabledTenantCount: result.chainEnabledTenantCount,
      };
    } catch (err) {
      if (!uploaded && isLockNotAvailable(err)) {
        return this.lockHeld(boundary, chainEnabledTenantCount);
      }

      // The catch covers the WHOLE publish transaction — set_config, every
      // Prisma read, the signing step and the commit — so `err.message` may be
      // a connection string or a query with its bound parameters. `reason`
      // reaches audit_logs.metadata.failureReason, which the tenant reads; it
      // is a token.
      if (uploaded) {
        // Stored but not committed: the retry for the boundary adopts the
        // object. No pause — the destinations are healthy.
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

      if (err instanceof RunFailure) {
        if (err.pauseTenantIds.length > 0) await this.persistPause(err.pauseTenantIds, this.wallClock());
        return this.fail(boundary, { reason: err.reason, stage: err.stage, chainEnabledTenantCount, artifactKey });
      }
      const reason = `CADENCE_FAILED:${errorLogFields(err).code}`;
      const stage = primaryStored ? "upload" : "before_upload";
      return this.fail(boundary, { reason, stage, chainEnabledTenantCount, artifactKey });
    }
  }

  /**
   * The manifest a stored one names as its previous, for the comparison a
   * fresh publish makes against the manifest it chained to. An adopt can be
   * forced from the database (a commit failed after the create), so it must
   * not be a way around that comparison. Read from the primary and held to
   * the hash the stored manifest carries; null for a genesis manifest. Never
   * throws: one that is missing, unverifiable or of another hash is reported
   * by a row, and the publish stands.
   */
  private async namedPrevious(
    stored: VerifiedManifest,
    listedKeys: string[],
    bound: DestinationBound,
  ): Promise<ComparedTo> {
    const named = stored.manifest.previousManifest;
    if (named === null) return null;
    const primary = this.primary;
    const previousArtifactKey = artifactKeyOfUri(named.uri);
    let detail: string;
    try {
      const previous = await bound.run((signal) =>
        readVerifiedManifest(primary, previousArtifactKey, this.ownKey, listedKeys, signal),
      );
      if (previous.sha256 === named.sha256) return previous;
      detail = "HASH_MISMATCH";
    } catch (err) {
      detail = err instanceof PublishedObjectUnverifiableError ? err.detail : destinationFaultCode(err);
    }
    getLogger().warn(
      {
        artifactKey: stored.artifactKey,
        detail,
        _logType: "audit-anchor-publisher.previous_manifest_unavailable",
      },
      "audit-anchor-publisher.previous_manifest_unavailable",
    );
    return PREVIOUS_UNAVAILABLE;
  }

  /**
   * The comparison rows of the manifests stored after the published high-water
   * and before the published one. Each was stored by a run whose commit failed
   * and never adopted by a run that committed, so no published outcome
   * compared it with its predecessor — and a database writer can arrange that
   * (a row lock held through every attempt of a boundary). Without this the
   * next publish compares only against a manifest that already lacks what was
   * dropped. Walks back from `comparedTo` by `previousManifest` until a
   * manifest dated on or before the high-water's date, which a publish
   * settled, or the genesis one. No cap of its own: the reads share the run's
   * bound, and a read that fails or outlasts it ends the walk with the
   * unavailable row.
   */
  private async unsettledEmits(
    result: Extract<PublishTxResult, { kind: "published" }>,
    comparedTo: ComparedTo,
    anchoredAt: string,
    bound: DestinationBound,
  ): Promise<PendingEmit[]> {
    const { cadenceMs, publishOffsetMs } = this.config;
    const settledDate =
      result.highWater === null ? null : utcDate(currentCadenceBoundary(result.highWater, cadenceMs, publishOffsetMs));
    const emits: PendingEmit[] = [];
    let stored = comparedTo;
    while (stored !== null && stored !== PREVIOUS_UNAVAILABLE && (settledDate === null || stored.date > settledDate)) {
      const previous = await this.namedPrevious(stored, result.listedKeys, bound);
      emits.push(...this.comparisonEmits(stored, previous, result.published.artifactKey, anchoredAt));
      stored = previous;
    }
    return emits;
  }

  /**
   * What `compared` lost against `comparedTo`, the manifest it chains to.
   * `artifactKey` is the manifest of the publish writing the rows and
   * `comparedArtifactKey` the manifest each row is about: the same one, or an
   * earlier manifest no publish settled.
   */
  private comparisonEmits(
    compared: VerifiedManifest,
    comparedTo: ComparedTo,
    artifactKey: string,
    anchoredAt: string,
  ): PendingEmit[] {
    const emits: PendingEmit[] = [];
    const failed = (failureReason: string, extra: Record<string, unknown> = {}) =>
      emits.push({
        action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
        metadata: { failureReason, artifactKey, anchoredAt, comparedArtifactKey: compared.artifactKey, ...extra },
      });

    if (comparedTo === PREVIOUS_UNAVAILABLE) {
      failed("PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON");
    } else if (comparedTo) {
      const current = new Map(compared.manifest.tenants.map((t) => [t.tenantTag, t]));
      let dropped = 0;
      let regressed = 0;
      let epochChanged = 0;
      for (const before of comparedTo.manifest.tenants) {
        const now = current.get(before.tenantTag);
        if (!now) dropped++;
        // A chainSeq is comparable within one epoch only, and no code path
        // writes `epoch`: a change is reported in its own right.
        else if (now.epoch !== before.epoch) epochChanged++;
        else if (BigInt(now.chainSeq) < BigInt(before.chainSeq)) regressed++;
      }
      if (dropped > 0) failed("TENANT_DROPPED_FROM_MANIFEST", { count: dropped });
      if (regressed > 0) failed("CHAIN_SEQ_REGRESSION", { count: regressed });
      if (epochChanged > 0) failed("EPOCH_CHANGED", { count: epochChanged });
    }
    return emits;
  }

  /**
   * The detection rows of one published outcome. Drops, regressions and epoch
   * changes compare against `comparedTo`: the manifest a fresh publish chained
   * to, or the one an adopted manifest names.
   */
  private publishedEmits(
    result: Extract<PublishTxResult, { kind: "published" }>,
    comparedTo: ComparedTo,
    anchoredAt: string,
  ): PendingEmit[] {
    const { published, state } = result;
    const emits: PendingEmit[] = [];
    const failed = (failureReason: string, extra: Record<string, unknown> = {}) =>
      emits.push({
        action: AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_FAILED,
        metadata: { failureReason, artifactKey: published.artifactKey, anchoredAt, ...extra },
      });

    const previousKey = previousManifestKey(published.manifest);
    if (previousKey && previousKey.kid !== published.kid) {
      emits.push({
        action: AUDIT_ACTION.AUDIT_ANCHOR_KEY_ROTATED,
        metadata: { oldKid: previousKey.kid, newKid: published.kid, anchoredAt, artifactKey: published.artifactKey },
      });
    }
    if (previousKey) {
      const count = state.manifestKeys.filter((key) => parseManifestArtifactKey(key)?.date === previousKey.date).length;
      if (count > 1) failed("MULTIPLE_MANIFESTS_FOR_DATE", { date: previousKey.date, count });
    }
    if (!state.ownPublicKeyArchived) failed("OWN_PUBLIC_KEY_NOT_ARCHIVED");

    emits.push(...this.comparisonEmits(published, comparedTo, published.artifactKey, anchoredAt));
    return emits;
  }

  /**
   * Copy to each mirror the manifest keys the primary holds and it lacks,
   * newest first and at most AUDIT_ANCHOR_MIRROR_BACKFILL_MAX per run, so
   * planted old-dated keys cannot starve recent gaps. A byte copy: nothing is
   * re-verified and an object the mirror already lists is not compared. A
   * failure is logged and changes nothing; the next publishing run continues.
   */
  private async backfillMirrors(primaryManifestKeys: string[], bound: DestinationBound): Promise<void> {
    const primary = this.primary;
    for (const mirror of this.mirrors) {
      try {
        const held = new Set(await bound.run((signal) => mirror.list(signal)));
        const missing = [...new Set(primaryManifestKeys)]
          .filter((key) => !held.has(key))
          .sort()
          .reverse()
          .slice(0, AUDIT_ANCHOR_MIRROR_BACKFILL_MAX);
        for (const artifactKey of missing) {
          const artifactBytes = await bound.run((signal) => primary.read(artifactKey, signal));
          if (artifactBytes === null) throw new TokenError("PRIMARY_OBJECT_MISSING");
          const result = await bound.run((signal) =>
            mirror.create({ artifactBytes, artifactKey, contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS, signal }),
          );
          if (result === "exists") {
            const stored = await bound.run((signal) => mirror.read(artifactKey, signal));
            if (!stored?.equals(artifactBytes)) throw new TokenError("MIRROR_DIVERGED");
          }
        }
      } catch (err) {
        getLogger().warn(
          {
            destination: mirror.name,
            error: errorLogFields(err),
            _logType: "audit-anchor-publisher.mirror_backfill_failed",
          },
          "audit-anchor-publisher.mirror_backfill_failed",
        );
      }
    }
  }

  /** No chain-enabled tenant has an anchor row; `chainEnabledTenantCount` still counts the enabled ones. */
  private noTenants(everChainEnabled: boolean, chainEnabledTenantCount: number): CadenceOutcome {
    return {
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled,
      chainEnabledTenantCount,
    };
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
