import type { RekeyEntryState } from "@/lib/constants/team/rotate-key";

/**
 * Reports of the rotation and the re-key pass as data
 * (docs/archive/review/team-key-rotation-rekey-plan.md C1, C3). Rendered
 * through i18n by RekeyReportView; every issue names its exits, least
 * privilege first.
 */

/** What a reader of the report can do about an issue. */
export const REKEY_EXIT = {
  /** Another holder of the version (named when known) runs the re-key. */
  ANOTHER_HOLDER_REKEYS: "another_holder_rekeys",
  /** Restore a history row saved under the current team key version. */
  RESTORE_CURRENT_VERSION_ROW: "restore_current_version_row",
  /** Compare the distributed key with a team admin. */
  COMPARE_KEYS_WITH_ADMIN: "compare_keys_with_admin",
  /** Temporarily promote a holder so they can re-key (audited with the entry ids). */
  TEMPORARY_PROMOTION: "temporary_promotion",
  /** Delete the entry (ordinary entry delete). */
  DELETE_ENTRY: "delete_entry",
  /** Run the pass again later (the entry changed or a write was refused). */
  RETRY_PASS: "retry_pass",
} as const;

export type RekeyExit = (typeof REKEY_EXIT)[keyof typeof REKEY_EXIT];

/** The kind of a reported problem. */
export const REKEY_ISSUE = {
  /** The entry failed AES-GCM authentication under a key the actor's wrap authenticated. */
  UNDECRYPTABLE: "undecryptable",
  /** The actor's own member-key row at the version fails to unwrap. */
  KEY_INVALID: "key_invalid",
  /** The actor does not hold the version; a holder who can re-key does. */
  NEEDS_REKEYER_HOLDER: "needs_rekeyer_holder",
  /** Only holders whose role cannot re-key hold the version. */
  HOLDER_CANNOT_REKEY: "holder_cannot_rekey",
  /** No active member holds the version. */
  UNRECOVERABLE: "unrecoverable",
  /** The pass skipped the entry (a refusal or an attachment no key opens). */
  SKIPPED: "skipped",
} as const;

export type RekeyIssue = (typeof REKEY_ISSUE)[keyof typeof REKEY_ISSUE];

/** Why the pass skipped an entry (a server refusal code or a client finding). */
export const REKEY_SKIP_REASON = {
  ATTACHMENT_UNOPENABLE: "attachment_unopenable",
  RETRY_EXHAUSTED: "retry_exhausted",
} as const;

export interface RekeyReportItem {
  issue: RekeyIssue;
  /** Team key version concerned (absent for counts spanning versions). */
  teamKeyVersion?: number;
  /** Entries concerned, when known individually. */
  entryIds: string[];
  count: number;
  exits: RekeyExit[];
  /** Holders named by ANOTHER_HOLDER_REKEYS, per team key version. */
  holdersByVersion?: Record<number, string[]>;
  /** Skip reason (server error code or REKEY_SKIP_REASON). */
  reason?: string;
  /**
   * UNRECOVERABLE only: a member whose team membership is deactivated (e.g.
   * left the tenant) still holds the version, so the delete exit warns.
   */
  deactivatedHolder?: boolean;
}

export interface RekeyReport {
  items: RekeyReportItem[];
  /** Versions at which "your distributed key may be wrong" is shown. */
  keySuspectVersions: number[];
}

export interface EntryAtVersion {
  entryId: string;
  teamKeyVersion: number;
}

export interface RekeyReportInput {
  undecryptable?: readonly EntryAtVersion[];
  keyInvalid?: readonly EntryAtVersion[];
  /** Entries the actor attempted per version (the suspicion denominator). */
  attemptedByVersion?: ReadonlyMap<number, number>;
  /**
   * Other active holders of each version the actor holds. A version with an
   * empty list: the actor is its only holder. Absent: not known.
   */
  otherHoldersByVersion?: Readonly<Record<number, readonly string[]>>;
  /** Per-state counts from GET /api/teams/[teamId]/rekey. */
  stateCounts?: Readonly<Partial<Record<RekeyEntryState, number>>>;
  /** Re-keyer holders per version for "needs re-keyer holder". */
  rekeyerHoldersByVersion?: Readonly<Record<number, readonly string[]>>;
  skipped?: readonly { entryId: string; reason: string }[];
  /** Whether a deactivated member holds a version no active member holds. */
  deactivatedHolder?: boolean;
}

/** Holders of one pending version, from GET /api/teams/[teamId]/rekey (`versionHolders`, D36). */
export interface VersionHoldersDto {
  callerHolds: boolean;
  activeHolderCount: number;
  /** Other active holders (the caller excluded), bounded. */
  holders: { id: string; name: string | null; email: string | null; canRekey: boolean }[];
  deactivatedHolderCount: number;
}

/**
 * The report's holder inputs from the server's per-version holders: the
 * other holders of each version the caller holds (an empty list when the
 * caller is the only active holder), and whether a deactivated member holds
 * a version no active member holds.
 */
export function holderInputsFrom(
  versionHolders: Readonly<Record<string, VersionHoldersDto>>,
  unknownName: string,
): Pick<RekeyReportInput, "otherHoldersByVersion" | "deactivatedHolder"> {
  const otherHoldersByVersion: Record<number, string[]> = {};
  let deactivatedHolder = false;
  for (const [version, v] of Object.entries(versionHolders)) {
    otherHoldersByVersion[Number(version)] = v.holders.map((h) => h.name || h.email || unknownName);
    if (v.activeHolderCount === 0 && v.deactivatedHolderCount > 0) deactivatedHolder = true;
  }
  return { otherHoldersByVersion, deactivatedHolder };
}

/**
 * "Your distributed key for v may be wrong": more than half of the actor's
 * entries at v, and at least 2, failed.
 */
export function isKeySuspect(failed: number, attempted: number): boolean {
  return failed >= 2 && failed * 2 > attempted;
}

/**
 * Exits of an `undecryptable` / `key_invalid` claim. Never DELETE_ENTRY: the
 * actor's distributed key may itself be wrong, so another holder decides.
 */
function holderClaimExits(otherHolders: readonly string[] | undefined): RekeyExit[] {
  if (otherHolders === undefined) {
    return [
      REKEY_EXIT.ANOTHER_HOLDER_REKEYS,
      REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW,
      REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN,
    ];
  }
  if (otherHolders.length > 0) return [REKEY_EXIT.ANOTHER_HOLDER_REKEYS];
  // The actor is the only active holder of the version.
  return [REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN];
}

function groupByVersion(entries: readonly EntryAtVersion[]): Map<number, string[]> {
  const byVersion = new Map<number, string[]>();
  for (const e of entries) {
    const ids = byVersion.get(e.teamKeyVersion) ?? [];
    ids.push(e.entryId);
    byVersion.set(e.teamKeyVersion, ids);
  }
  return new Map([...byVersion].sort(([a], [b]) => a - b));
}

export function buildRekeyReport(input: RekeyReportInput): RekeyReport {
  const items: RekeyReportItem[] = [];
  const otherHolders = input.otherHoldersByVersion;

  for (const [issue, entries] of [
    [REKEY_ISSUE.KEY_INVALID, input.keyInvalid ?? []],
    [REKEY_ISSUE.UNDECRYPTABLE, input.undecryptable ?? []],
  ] as const) {
    for (const [version, entryIds] of groupByVersion(entries)) {
      const holders = otherHolders?.[version];
      items.push({
        issue,
        teamKeyVersion: version,
        entryIds,
        count: entryIds.length,
        exits: holderClaimExits(holders),
        ...(holders && holders.length > 0 ? { holdersByVersion: { [version]: [...holders] } } : {}),
      });
    }
  }

  const keySuspectVersions: number[] = [];
  for (const [version, entryIds] of groupByVersion(input.undecryptable ?? [])) {
    const attempted = input.attemptedByVersion?.get(version) ?? entryIds.length;
    if (isKeySuspect(entryIds.length, attempted)) keySuspectVersions.push(version);
  }

  const counts = input.stateCounts ?? {};
  const needsRekeyer = counts.needs_rekeyer_holder ?? 0;
  if (needsRekeyer > 0) {
    const holdersByVersion: Record<number, string[]> = {};
    for (const [v, names] of Object.entries(input.rekeyerHoldersByVersion ?? {})) {
      holdersByVersion[Number(v)] = [...names];
    }
    items.push({
      issue: REKEY_ISSUE.NEEDS_REKEYER_HOLDER,
      entryIds: [],
      count: needsRekeyer,
      exits: [REKEY_EXIT.ANOTHER_HOLDER_REKEYS],
      holdersByVersion,
    });
  }
  const cannotRekey = counts.holder_cannot_rekey ?? 0;
  if (cannotRekey > 0) {
    items.push({
      issue: REKEY_ISSUE.HOLDER_CANNOT_REKEY,
      entryIds: [],
      count: cannotRekey,
      exits: [
        REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW,
        REKEY_EXIT.DELETE_ENTRY,
        REKEY_EXIT.TEMPORARY_PROMOTION,
      ],
    });
  }
  const unrecoverable = counts.unrecoverable ?? 0;
  if (unrecoverable > 0) {
    items.push({
      issue: REKEY_ISSUE.UNRECOVERABLE,
      entryIds: [],
      count: unrecoverable,
      exits: [REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.DELETE_ENTRY],
      deactivatedHolder: input.deactivatedHolder === true,
    });
  }

  const skippedByReason = new Map<string, string[]>();
  for (const s of input.skipped ?? []) {
    const ids = skippedByReason.get(s.reason) ?? [];
    ids.push(s.entryId);
    skippedByReason.set(s.reason, ids);
  }
  for (const [reason, entryIds] of skippedByReason) {
    items.push({
      issue: REKEY_ISSUE.SKIPPED,
      entryIds,
      count: entryIds.length,
      exits: [REKEY_EXIT.RETRY_PASS],
      reason,
    });
  }

  return { items, keySuspectVersions };
}
