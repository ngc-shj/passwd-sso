import type { Prisma } from "@prisma/client";
import { itemKeyIdsMatch } from "@/lib/team/team-item-key";

/**
 * Post-write verification of a team entry re-key
 * (docs/archive/review/team-key-rotation-rekey-plan.md C2). The re-key POST
 * runs it in its transaction after the writes, on rows re-read from the
 * database, so a write that missed a row, or wrote one it should have left,
 * rolls the whole re-key back instead of committing an entry whose rows
 * disagree about which ItemKey opens them.
 */

/** Which invariant the post-check found broken (token-shaped: it is logged as the error code). */
export const REKEY_INCONSISTENCY = {
  ENTRY_MISSING: "entry_missing",
  ENTRY_WITHOUT_ITEM_KEY: "entry_without_item_key",
  ENTRY_MARKER_NOT_CURRENT: "entry_marker_not_current",
  ENTRY_HIGH_WATER_MISMATCH: "entry_high_water_mismatch",
  RETAINED_ROW_MISSING: "retained_row_missing",
  RETAINED_ROW_CARRIES_NEW_ID: "retained_row_carries_new_id",
  HISTORY_ROW_NOT_REKEYED: "history_row_not_rekeyed",
  ATTACHMENT_NOT_REKEYED: "attachment_not_rekeyed",
} as const;

export type RekeyInconsistency = (typeof REKEY_INCONSISTENCY)[keyof typeof REKEY_INCONSISTENCY];

export class RekeyConsistencyError extends Error {
  constructor(readonly code: RekeyInconsistency) {
    super(`Re-key post-check failed: ${code}`);
    this.name = "RekeyConsistencyError";
  }
}

/**
 * Throw RekeyConsistencyError unless, after a re-key of `entryId`:
 *  - the entry holds an ItemKey (id, wrap) created at its own team key version;
 *  - every history row not in `retainedIds` carries the entry's ItemKey id,
 *    item key version, team key version and wrap bytes;
 *  - every attachment is mode 2 with its CEK under the entry's ItemKey id,
 *    item key version and team key version;
 *  - every retained row exists and does NOT carry the entry's ItemKey id.
 */
export async function assertEntryRekeyConsistent(
  tx: Pick<Prisma.TransactionClient, "teamPasswordEntry" | "teamPasswordEntryHistory" | "attachment">,
  entryId: string,
  retainedIds: readonly string[],
): Promise<void> {
  const entry = await tx.teamPasswordEntry.findUnique({
    where: { id: entryId },
    select: {
      teamKeyVersion: true,
      itemKeyVersion: true,
      encryptedItemKey: true,
      itemKeyIv: true,
      itemKeyAuthTag: true,
      itemKeyId: true,
      itemKeyTeamKeyVersion: true,
      itemKeyVersionHighWater: true,
    },
  });
  if (!entry) throw new RekeyConsistencyError(REKEY_INCONSISTENCY.ENTRY_MISSING);
  if (
    entry.itemKeyId === null ||
    entry.itemKeyVersion < 1 ||
    !entry.encryptedItemKey ||
    !entry.itemKeyIv ||
    !entry.itemKeyAuthTag
  ) {
    throw new RekeyConsistencyError(REKEY_INCONSISTENCY.ENTRY_WITHOUT_ITEM_KEY);
  }
  if (entry.itemKeyTeamKeyVersion !== entry.teamKeyVersion) {
    throw new RekeyConsistencyError(REKEY_INCONSISTENCY.ENTRY_MARKER_NOT_CURRENT);
  }
  if (entry.itemKeyVersionHighWater !== entry.itemKeyVersion) {
    throw new RekeyConsistencyError(REKEY_INCONSISTENCY.ENTRY_HIGH_WATER_MISMATCH);
  }

  const retained = new Set(retainedIds);
  const history = await tx.teamPasswordEntryHistory.findMany({
    where: { entryId },
    select: {
      id: true,
      teamKeyVersion: true,
      itemKeyVersion: true,
      encryptedItemKey: true,
      itemKeyIv: true,
      itemKeyAuthTag: true,
      itemKeyId: true,
    },
  });
  const historyIds = new Set(history.map((h) => h.id));
  for (const id of retained) {
    if (!historyIds.has(id)) throw new RekeyConsistencyError(REKEY_INCONSISTENCY.RETAINED_ROW_MISSING);
  }
  for (const h of history) {
    const carriesEntryKey = itemKeyIdsMatch(h.itemKeyId, entry.itemKeyId);
    if (retained.has(h.id)) {
      if (carriesEntryKey) throw new RekeyConsistencyError(REKEY_INCONSISTENCY.RETAINED_ROW_CARRIES_NEW_ID);
      continue;
    }
    if (
      !carriesEntryKey ||
      h.itemKeyVersion !== entry.itemKeyVersion ||
      h.teamKeyVersion !== entry.teamKeyVersion ||
      h.encryptedItemKey !== entry.encryptedItemKey ||
      h.itemKeyIv !== entry.itemKeyIv ||
      h.itemKeyAuthTag !== entry.itemKeyAuthTag
    ) {
      throw new RekeyConsistencyError(REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED);
    }
  }

  const attachments = await tx.attachment.findMany({
    where: { teamPasswordEntryId: entryId },
    select: { encryptionMode: true, cekItemKeyId: true, cekKeyVersion: true, keyVersion: true },
  });
  for (const a of attachments) {
    if (
      a.encryptionMode !== 2 ||
      !itemKeyIdsMatch(a.cekItemKeyId, entry.itemKeyId) ||
      a.cekKeyVersion !== entry.itemKeyVersion ||
      a.keyVersion !== entry.teamKeyVersion
    ) {
      throw new RekeyConsistencyError(REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED);
    }
  }
}
