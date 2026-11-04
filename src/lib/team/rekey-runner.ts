import { apiPath, ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import type { RekeyEntryState } from "@/lib/constants/team/rotate-key";
import { isRekeyPending, normalizeTeamKeyVersion, type ResolveTeamKey } from "@/lib/team/team-key-resolution";
import {
  REKEY_ENTRY_BLOCK,
  RekeyCurrentKeyUnavailableError,
  RekeyTransientError,
  buildAttachmentMigratePayload,
  buildEntryRekeyPayload,
  buildEntryUpgradePayload,
  liveCekWrapKey,
  type RekeyEntryBlock,
  type RekeyEntryData,
} from "@/lib/team/rekey-payload";
import {
  TeamAttachmentKeyError,
  ATTACHMENT_KEY_FAILURE,
  type TeamAttachmentDownload,
} from "@/lib/team/team-attachment-crypto";
import { REKEY_SKIP_REASON, type EntryAtVersion, type VersionHoldersDto } from "@/lib/team/rekey-report";

/**
 * The re-key pass runner (docs/archive/review/team-key-rotation-rekey-plan.md
 * C3): pages over the team's pending entries and re-keys each one, upgrading
 * v0 entries and migrating legacy attachments first. React-free — fetch, the
 * key resolver, step-up re-authentication and sleep are injected.
 */

// ─── Response classification (the C3 status table) ─────────────────────────

export const REKEY_ACTION = {
  /** The entry (or attachment) needs nothing more: not pending, or gone. */
  DONE: "done",
  /** The team key changed or a rotation is in flight: drop cached keys, pause, re-fetch. */
  REFRESH_KEYS: "refresh_keys",
  /** A concurrent change: re-GET and retry once. */
  RETRY_ONCE: "retry_once",
  /** The entry must be re-keyed rather than edited: re-GET and re-key. */
  REKEY_INSTEAD: "rekey_instead",
  /** v0 or ItemKey moved under the request: re-GET, upgrade again if v0, retry once. */
  UPGRADE_RETRY: "upgrade_retry",
  /** Legacy attachments remain: migrate them, then retry. */
  MIGRATE_RETRY: "migrate_retry",
  /** The attachment is already mode 2. */
  MIGRATE_DONE: "migrate_done",
  /** Skip the entry and report it. */
  SKIP: "skip",
  /** Stop the pass and report. */
  STOP: "stop",
  /** 429: wait for Retry-After, then retry. */
  RATE_LIMITED: "rate_limited",
  /** Step-up required: re-authenticate and resume. */
  STEP_UP: "step_up",
} as const;

export type RekeyAction = (typeof REKEY_ACTION)[keyof typeof REKEY_ACTION];

const ACTION_BY_CODE: Readonly<Record<string, RekeyAction>> = {
  [API_ERROR.TEAM_KEY_VERSION_CHANGED]: REKEY_ACTION.REFRESH_KEYS,
  [API_ERROR.TEAM_KEY_VERSION_MISMATCH]: REKEY_ACTION.REFRESH_KEYS,
  [API_ERROR.REKEY_SNAPSHOT_MISMATCH]: REKEY_ACTION.RETRY_ONCE,
  [API_ERROR.REKEY_SET_MISMATCH]: REKEY_ACTION.RETRY_ONCE,
  [API_ERROR.ITEM_KEY_CHANGED]: REKEY_ACTION.RETRY_ONCE,
  [API_ERROR.ITEM_KEY_VERSION_INVALID]: REKEY_ACTION.RETRY_ONCE,
  [API_ERROR.MIGRATE_CAS_FAILED]: REKEY_ACTION.RETRY_ONCE,
  [API_ERROR.ENTRY_REKEY_REQUIRED]: REKEY_ACTION.REKEY_INSTEAD,
  [API_ERROR.ENTRY_UPGRADE_REQUIRED]: REKEY_ACTION.UPGRADE_RETRY,
  [API_ERROR.CEK_KEY_VERSION_MISMATCH]: REKEY_ACTION.UPGRADE_RETRY,
  [API_ERROR.REKEY_ATTACHMENTS_UNMIGRATED]: REKEY_ACTION.MIGRATE_RETRY,
  [API_ERROR.MIGRATE_NOT_LEGACY]: REKEY_ACTION.MIGRATE_DONE,
  [API_ERROR.ITEM_KEY_IV_REUSED]: REKEY_ACTION.SKIP,
  [API_ERROR.MIGRATE_HASH_MISMATCH]: REKEY_ACTION.SKIP,
  [API_ERROR.MIGRATE_LENGTH_CHANGED]: REKEY_ACTION.SKIP,
  [API_ERROR.MIGRATE_METADATA_CHANGED]: REKEY_ACTION.SKIP,
  [API_ERROR.BLOB_REF_INVALID]: REKEY_ACTION.SKIP,
  [API_ERROR.REKEY_NOT_PENDING]: REKEY_ACTION.DONE,
  [API_ERROR.SESSION_STEP_UP_REQUIRED]: REKEY_ACTION.STEP_UP,
  [API_ERROR.RATE_LIMIT_EXCEEDED]: REKEY_ACTION.RATE_LIMITED,
};

/**
 * Map a non-2xx response to the runner's action. `ACTOR_NOT_PERMITTED`,
 * `REKEY_POSTCHECK_FAILED` and every unlisted code stop the pass.
 */
export function classifyRekeyResponse(status: number, code: string | undefined): RekeyAction {
  if (status === 404) return REKEY_ACTION.DONE;
  if (status === 429) return REKEY_ACTION.RATE_LIMITED;
  return (code !== undefined ? ACTION_BY_CODE[code] : undefined) ?? REKEY_ACTION.STOP;
}

// ─── Result ────────────────────────────────────────────────────────────────

export const REKEY_STOP_REASON = {
  /** A key or request failed for a retryable reason; nothing more was sent. */
  TRANSIENT: "transient",
  /** The server refused with a code that stops the pass. */
  REFUSED: "refused",
  /** Re-authentication was not completed. */
  STEP_UP_DECLINED: "step_up_declined",
  /** The actor cannot resolve the team's current key. */
  CURRENT_KEY_UNAVAILABLE: "current_key_unavailable",
  /** Rate limited, or rotations kept interrupting, past the retry budget. */
  RETRY_BUDGET_EXHAUSTED: "retry_budget_exhausted",
  /** The caller aborted the pass (its control unmounted); nothing more is sent. */
  CANCELLED: "cancelled",
} as const;

export type RekeyStopReason = (typeof REKEY_STOP_REASON)[keyof typeof REKEY_STOP_REASON];

/** GET /api/teams/[teamId]/rekey */
export interface RekeyListResponse {
  pendingCount: number;
  stateCounts: Record<RekeyEntryState, number>;
  holders: Record<string, { id: string; name: string | null; email: string | null }[]>;
  /** Holders of every pending version, the caller's own included (D36). */
  versionHolders: Record<string, VersionHoldersDto>;
  retainedHistoryCount: number;
  entryIds: string[];
}

export interface RekeyPassResult {
  status: "completed" | "stopped";
  stop?: { reason: RekeyStopReason; code?: string; entryId?: string };
  rekeyed: string[];
  undecryptable: EntryAtVersion[];
  keyInvalid: EntryAtVersion[];
  notHeld: EntryAtVersion[];
  skipped: { entryId: string; reason: string }[];
  retained: { entryId: string; historyId: string; teamKeyVersion: number }[];
  /** Entries the runner opened (or tried to) per team key version. */
  attemptedByVersion: Map<number, number>;
  /** The last list response (final counts after a completed pass). */
  list?: RekeyListResponse;
}

export interface RekeyProgress {
  processed: number;
  rekeyed: number;
  pendingCount: number;
}

export interface RekeyRunnerDeps {
  teamId: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  resolveKey: ResolveTeamKey;
  /** Drop cached team (and ItemKey) keys after a team key version change. */
  invalidateTeamKeys: () => void;
  /** Open step-up re-authentication; true once the session is fresh. */
  reauthenticate: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Checked between steps: once aborted, the pass sends nothing more. */
  signal?: AbortSignal;
  pageLimit?: number;
  onProgress?: (progress: RekeyProgress) => void;
}

/** Pause before re-fetching after a rotation was in flight or just committed. */
export const REKEY_ROTATION_PAUSE_MS = 3 * MS_PER_SECOND;
const DEFAULT_RETRY_AFTER_MS = 5 * MS_PER_SECOND;
const MAX_RATE_LIMIT_WAITS = 10;
const MAX_ROTATION_WAITS = 5;
const MAX_STEPS_PER_ENTRY = 20;

// ─── Runner ────────────────────────────────────────────────────────────────

type EntryOutcome =
  | { kind: "done" }
  | { kind: "rekeyed" }
  | { kind: "skipped" }
  | { kind: "stop"; reason: RekeyStopReason; code?: string };

class StopPass extends Error {
  constructor(readonly reason: RekeyStopReason, readonly code?: string) {
    super(reason);
    this.name = "StopPass";
  }
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * MS_PER_SECOND : DEFAULT_RETRY_AFTER_MS;
}

export async function runRekeyPass(deps: RekeyRunnerDeps): Promise<RekeyPassResult> {
  const { teamId } = deps;
  const result: RekeyPassResult = {
    status: "completed",
    rekeyed: [],
    undecryptable: [],
    keyInvalid: [],
    notHeld: [],
    skipped: [],
    retained: [],
    attemptedByVersion: new Map(),
  };
  let rateWaits = 0;
  let rotationWaits = 0;
  let teamKeyChanged = false;
  let processed = 0;

  const throwIfCancelled = () => {
    if (deps.signal?.aborted) throw new StopPass(REKEY_STOP_REASON.CANCELLED);
  };
  const waitRateLimit = async (res: Response) => {
    if (++rateWaits > MAX_RATE_LIMIT_WAITS) {
      throw new StopPass(REKEY_STOP_REASON.RETRY_BUDGET_EXHAUSTED, API_ERROR.RATE_LIMIT_EXCEEDED);
    }
    await deps.sleep(retryAfterMs(res));
  };
  const refreshKeys = async (code: string | undefined) => {
    if (++rotationWaits > MAX_ROTATION_WAITS) {
      throw new StopPass(REKEY_STOP_REASON.RETRY_BUDGET_EXHAUSTED, code);
    }
    deps.invalidateTeamKeys();
    teamKeyChanged = true;
    // A rotation in flight answers TEAM_KEY_VERSION_MISMATCH; wait it out.
    await deps.sleep(REKEY_ROTATION_PAUSE_MS);
  };
  const reauthenticate = async () => {
    const ok = await deps.reauthenticate();
    throwIfCancelled();
    if (!ok) throw new StopPass(REKEY_STOP_REASON.STEP_UP_DECLINED);
  };
  // Every request goes through here, so an aborted pass stops before its next
  // request — after a sleep or a re-authentication as well.
  const fetchOrStop = async (path: string, init?: RequestInit): Promise<Response> => {
    throwIfCancelled();
    try {
      return await deps.fetch(path, init);
    } catch {
      throw new StopPass(REKEY_STOP_REASON.TRANSIENT);
    }
  };
  const record = (bucket: EntryAtVersion[], entryId: string, teamKeyVersion: number) => {
    if (!bucket.some((e) => e.entryId === entryId)) bucket.push({ entryId, teamKeyVersion });
  };
  const recordSkip = (entryId: string, reason: string) => {
    if (!result.skipped.some((s) => s.entryId === entryId)) result.skipped.push({ entryId, reason });
  };
  const recordBlock = (entryId: string, block: RekeyEntryBlock, version: number) => {
    if (block === REKEY_ENTRY_BLOCK.UNDECRYPTABLE) record(result.undecryptable, entryId, version);
    else if (block === REKEY_ENTRY_BLOCK.KEY_INVALID) record(result.keyInvalid, entryId, version);
    else if (block === REKEY_ENTRY_BLOCK.NOT_HELD) record(result.notHeld, entryId, version);
    else recordSkip(entryId, block);
  };
  const countAttempt = (version: number) => {
    result.attemptedByVersion.set(version, (result.attemptedByVersion.get(version) ?? 0) + 1);
  };

  type MigrateStep = { kind: "continue" } | { kind: "skip" } | { kind: "retry"; code: string | undefined };
  const CONTINUE: MigrateStep = { kind: "continue" };
  const SKIP: MigrateStep = { kind: "skip" };

  /** Migrate one legacy attachment; the entry is re-read after every step. */
  const migrateAttachment = async (
    data: RekeyEntryData,
    attachmentId: string,
  ): Promise<MigrateStep> => {
    const { entry } = data;
    // The live wrap first: an entry the actor cannot open goes to its own
    // report bucket (not held, broken key, undecryptable) before anything is
    // downloaded.
    const live = await liveCekWrapKey(teamId, entry, deps.resolveKey);
    if (!live.ok) {
      recordBlock(entry.id, live.block, normalizeTeamKeyVersion(entry.teamKeyVersion));
      return SKIP;
    }
    const { cekWrapKey } = live;
    const dl = await fetchOrStop(apiPath.teamPasswordAttachmentById(teamId, entry.id, attachmentId));
    if (!dl.ok) {
      const err = await readApiErrorBody(dl);
      const action = classifyRekeyResponse(dl.status, err?.error);
      if (action === REKEY_ACTION.DONE) return CONTINUE;
      if (action === REKEY_ACTION.RATE_LIMITED) {
        await waitRateLimit(dl);
        return CONTINUE;
      }
      if (action === REKEY_ACTION.REFRESH_KEYS) {
        await refreshKeys(err?.error);
        return CONTINUE;
      }
      if (action === REKEY_ACTION.SKIP) {
        recordSkip(entry.id, err?.error ?? String(dl.status));
        return SKIP;
      }
      throw new StopPass(REKEY_STOP_REASON.REFUSED, err?.error ?? String(dl.status));
    }
    const download = (await dl.json()) as TeamAttachmentDownload;
    let body;
    try {
      body = await buildAttachmentMigratePayload(
        teamId,
        entry.id,
        download,
        { itemKeyId: entry.itemKeyId ?? null, itemKeyVersion: entry.itemKeyVersion, cekWrapKey },
        deps.resolveKey,
      );
    } catch (e) {
      if (e instanceof TeamAttachmentKeyError) {
        if (e.reason === ATTACHMENT_KEY_FAILURE.TRANSIENT) throw new StopPass(REKEY_STOP_REASON.TRANSIENT);
        recordSkip(entry.id, REKEY_SKIP_REASON.ATTACHMENT_UNOPENABLE);
        return SKIP;
      }
      throw e;
    }
    // @stepup id:team-attachment-migrate-put
    const res = await fetchOrStop(
      apiPath.teamPasswordAttachmentMigrate(teamId, entry.id, attachmentId),
      jsonInit("PUT", body),
    );
    if (res.ok) return CONTINUE;
    const err = await readApiErrorBody(res);
    if (err?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
      await reauthenticate();
      return CONTINUE;
    }
    return migrateRefusal(res, err?.error, entry.id);
  };

  const migrateRefusal = async (
    res: Response,
    code: string | undefined,
    entryId: string,
  ): Promise<MigrateStep> => {
    const action = classifyRekeyResponse(res.status, code);
    switch (action) {
      case REKEY_ACTION.DONE:
      case REKEY_ACTION.MIGRATE_DONE:
        return CONTINUE;
      case REKEY_ACTION.RATE_LIMITED:
        await waitRateLimit(res);
        return CONTINUE;
      case REKEY_ACTION.REFRESH_KEYS:
        await refreshKeys(code);
        return CONTINUE;
      case REKEY_ACTION.RETRY_ONCE:
      case REKEY_ACTION.UPGRADE_RETRY:
        return { kind: "retry", code };
      case REKEY_ACTION.SKIP:
        recordSkip(entryId, code ?? String(res.status));
        return SKIP;
      default:
        throw new StopPass(REKEY_STOP_REASON.REFUSED, code ?? String(res.status));
    }
  };

  const processEntry = async (entryId: string): Promise<EntryOutcome> => {
    let retryUsed = false;
    let attempted = false;
    const retryOnce = (code: string | undefined): boolean => {
      if (retryUsed) {
        recordSkip(entryId, code ?? REKEY_SKIP_REASON.RETRY_EXHAUSTED);
        return false;
      }
      retryUsed = true;
      return true;
    };

    for (let step = 0; step < MAX_STEPS_PER_ENTRY; step++) {
      const got = await fetchOrStop(apiPath.teamPasswordRekey(teamId, entryId));
      if (!got.ok) {
        const err = await readApiErrorBody(got);
        const action = classifyRekeyResponse(got.status, err?.error);
        if (action === REKEY_ACTION.DONE) return { kind: "done" };
        if (action === REKEY_ACTION.RATE_LIMITED) {
          await waitRateLimit(got);
          continue;
        }
        if (action === REKEY_ACTION.REFRESH_KEYS) {
          await refreshKeys(err?.error);
          continue;
        }
        return { kind: "stop", reason: REKEY_STOP_REASON.REFUSED, code: err?.error ?? String(got.status) };
      }
      const data = (await got.json()) as RekeyEntryData;
      const { entry } = data;
      if (
        entry.itemKeyTeamKeyVersion !== undefined &&
        !isRekeyPending({ ...entry, itemKeyTeamKeyVersion: entry.itemKeyTeamKeyVersion }, data.teamKeyVersion)
      ) {
        return { kind: "done" };
      }
      const version = normalizeTeamKeyVersion(entry.teamKeyVersion);
      if (!attempted) {
        attempted = true;
        countAttempt(version);
      }

      // v0 → v1 first (D23): the re-key POST refuses a v0 entry.
      if (entry.itemKeyVersion < 1) {
        const upgrade = await buildEntryUpgradePayload(
          teamId,
          entry,
          data.nextItemKeyVersion,
          data.teamKeyVersion,
          deps.resolveKey,
        );
        if (upgrade.kind === "blocked") {
          recordBlock(entryId, upgrade.block, upgrade.teamKeyVersion);
          return { kind: "skipped" };
        }
        const res = await fetchOrStop(apiPath.teamPasswordById(teamId, entryId), jsonInit("PUT", upgrade.body));
        if (res.ok) continue;
        const err = await readApiErrorBody(res);
        const action = classifyRekeyResponse(res.status, err?.error);
        if (action === REKEY_ACTION.DONE) return { kind: "done" };
        if (action === REKEY_ACTION.RATE_LIMITED) {
          await waitRateLimit(res);
          continue;
        }
        if (action === REKEY_ACTION.REFRESH_KEYS) {
          await refreshKeys(err?.error);
          continue;
        }
        if (action === REKEY_ACTION.REKEY_INSTEAD) continue;
        if (action === REKEY_ACTION.RETRY_ONCE || action === REKEY_ACTION.UPGRADE_RETRY) {
          if (retryOnce(err?.error)) continue;
          return { kind: "skipped" };
        }
        if (action === REKEY_ACTION.SKIP) {
          recordSkip(entryId, err?.error ?? String(res.status));
          return { kind: "skipped" };
        }
        return { kind: "stop", reason: REKEY_STOP_REASON.REFUSED, code: err?.error ?? String(res.status) };
      }

      // Legacy attachments next (D24), each re-read after.
      const legacy = data.attachments.find((a) => a.encryptionMode !== ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED);
      if (legacy) {
        const migrated = await migrateAttachment(data, legacy.id);
        if (migrated.kind === "skip") return { kind: "skipped" };
        if (migrated.kind === "retry" && !retryOnce(migrated.code)) return { kind: "skipped" };
        continue;
      }

      const built = await buildEntryRekeyPayload(teamId, data, deps.resolveKey);
      if (built.kind === "blocked") {
        if (built.block === REKEY_ENTRY_BLOCK.NEEDS_UPGRADE || built.block === REKEY_ENTRY_BLOCK.NEEDS_MIGRATION) {
          continue;
        }
        recordBlock(entryId, built.block, built.teamKeyVersion);
        return { kind: "skipped" };
      }

      // @stepup id:team-entry-rekey-post
      const res = await fetchOrStop(apiPath.teamPasswordRekey(teamId, entryId), jsonInit("POST", built.body));
      if (res.ok) {
        result.rekeyed.push(entryId);
        for (const r of built.retained) {
          result.retained.push({ entryId, historyId: r.id, teamKeyVersion: r.teamKeyVersion });
        }
        return { kind: "rekeyed" };
      }
      const err = await readApiErrorBody(res);
      if (err?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
        await reauthenticate();
        continue;
      }
      const action = classifyRekeyResponse(res.status, err?.error);
      switch (action) {
        case REKEY_ACTION.DONE:
          return { kind: "done" };
        case REKEY_ACTION.RATE_LIMITED:
          await waitRateLimit(res);
          continue;
        case REKEY_ACTION.REFRESH_KEYS:
          await refreshKeys(err?.error);
          continue;
        case REKEY_ACTION.MIGRATE_RETRY:
        case REKEY_ACTION.REKEY_INSTEAD:
          continue;
        case REKEY_ACTION.RETRY_ONCE:
        case REKEY_ACTION.UPGRADE_RETRY:
          if (retryOnce(err?.error)) continue;
          return { kind: "skipped" };
        case REKEY_ACTION.SKIP:
          recordSkip(entryId, err?.error ?? String(res.status));
          return { kind: "skipped" };
        default:
          return { kind: "stop", reason: REKEY_STOP_REASON.REFUSED, code: err?.error ?? String(res.status) };
      }
    }
    recordSkip(entryId, REKEY_SKIP_REASON.RETRY_EXHAUSTED);
    return { kind: "skipped" };
  };

  const stopWith = (reason: RekeyStopReason, code?: string, entryId?: string): RekeyPassResult => {
    result.status = "stopped";
    result.stop = { reason, ...(code !== undefined ? { code } : {}), ...(entryId ? { entryId } : {}) };
    return result;
  };

  // Entries finished in this sweep (re-keyed, done or skipped): a skipped
  // entry stays pending, and keyset paging moves past it so it does not
  // starve the page.
  const finished = new Set<string>();
  let after: string | undefined;
  for (;;) {
    let list: RekeyListResponse;
    try {
      const query = new URLSearchParams();
      if (after) query.set("after", after);
      if (deps.pageLimit) query.set("limit", String(deps.pageLimit));
      const qs = query.toString();
      const res = await fetchOrStop(`${apiPath.teamRekey(teamId)}${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const err = await readApiErrorBody(res);
        if (res.status === 429) {
          await waitRateLimit(res);
          continue;
        }
        return stopWith(REKEY_STOP_REASON.REFUSED, err?.error ?? String(res.status));
      }
      list = (await res.json()) as RekeyListResponse;
    } catch (e) {
      if (e instanceof StopPass) return stopWith(e.reason, e.code);
      throw e;
    }
    result.list = list;
    if (list.entryIds.length === 0) return result;

    for (const entryId of list.entryIds) {
      if (finished.has(entryId)) continue;
      let outcome: EntryOutcome;
      try {
        outcome = await processEntry(entryId);
      } catch (e) {
        if (e instanceof StopPass) return stopWith(e.reason, e.code, entryId);
        if (e instanceof RekeyTransientError) return stopWith(REKEY_STOP_REASON.TRANSIENT, undefined, entryId);
        if (e instanceof RekeyCurrentKeyUnavailableError) {
          return stopWith(REKEY_STOP_REASON.CURRENT_KEY_UNAVAILABLE, e.reason, entryId);
        }
        throw e;
      }
      if (outcome.kind === "stop") return stopWith(outcome.reason, outcome.code, entryId);
      finished.add(entryId);
      processed++;
      deps.onProgress?.({ processed, rekeyed: result.rekeyed.length, pendingCount: list.pendingCount });
      if (teamKeyChanged) break;
    }

    if (teamKeyChanged) {
      // A rotation re-opened every entry: start over from the first page.
      teamKeyChanged = false;
      finished.clear();
      after = undefined;
      continue;
    }
    after = list.entryIds[list.entryIds.length - 1];
  }
}
