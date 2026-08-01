/**
 * The single adjudicator for "is this tenant's audit chain intact?".
 *
 * There used to be three walks — the maintenance endpoint's, the periodic
 * worker's, and a hand-copy inside an integration test. They disagreed about
 * what counted as intact: only one bailed at the first tamper, only one
 * detected gaps, none compared the walk's final hash against the anchor. A
 * predicate with several implementations is decided by whichever one you
 * happen to ask, and the weakest answer is the one an attacker gets.
 *
 * This module owns the decision. Callers supply rows and bounds; it returns a
 * verdict. It performs no I/O so it can be tested directly against fixtures
 * built with the same hash primitives production uses.
 */

import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";

/** Genesis seed for a walk that starts at chain_seq 1. */
export const GENESIS_PREV_HASH: Buffer = Buffer.from([0x00]);

export const CHAIN_VERIFY_REASON = {
  TAMPER_DETECTED: "TAMPER_DETECTED",
  GAP_DETECTED: "GAP_DETECTED",
  TIMESTAMP_VIOLATION: "TIMESTAMP_VIOLATION",
  /** Walk's final hash disagrees with the anchor's recorded head. */
  ANCHOR_HASH_MISMATCH: "ANCHOR_HASH_MISMATCH",
  /** Chained rows exist but the anchor row that attests to them does not. */
  ANCHOR_MISSING: "ANCHOR_MISSING",
  /** Stopped at the row cap without covering the requested range. */
  TRUNCATED: "TRUNCATED",
  /** Covered less than the requested range for any other reason. */
  RANGE_INCOMPLETE: "RANGE_INCOMPLETE",
} as const;

export type ChainVerifyReason =
  (typeof CHAIN_VERIFY_REASON)[keyof typeof CHAIN_VERIFY_REASON];

export interface ChainVerifyRow {
  id: string;
  created_at: Date;
  chain_seq: bigint | string;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array | null;
  metadata: unknown;
}

export interface ChainVerifyInput {
  rows: ChainVerifyRow[];
  /** Hash the first row must chain from — genesis, or seq fromSeq-1's hash. */
  seedPrevHash: Buffer;
  fromSeq: number;
  toSeq: number;
  /**
   * The anchor's recorded head hash. Compared against the walk's final hash
   * only when the walk covered the whole chain (see anchorComparable below) —
   * a partial range legitimately ends somewhere else. Pass null when the
   * caller cannot supply it; the comparison is then skipped and the verdict
   * says so via `anchorChecked`.
   */
  anchorPrevHash?: Uint8Array | null;
  /**
   * True when [fromSeq, toSeq] is the entire chain the anchor attests to, so
   * the final hash is expected to equal anchorPrevHash.
   */
  anchorComparable: boolean;
  /** Row cap the caller's query used, to tell truncation from deletion. */
  rowCap: number;
}

export interface ChainVerifyOutcome {
  ok: boolean;
  reason?: ChainVerifyReason;
  totalVerified: number;
  walkedThrough: number;
  verifiedUpToSeq?: number;
  truncated: boolean;
  incomplete: boolean;
  /** Whether the anchor head comparison actually ran. */
  anchorChecked: boolean;
  firstTamperedSeq: number | null;
  firstGapAfterSeq: number | null;
  firstTimestampViolationSeq: number | null;
  /** A row whose stored chain_prev_hash disagrees with its predecessor. */
  firstBrokenLinkSeq: number | null;
}

export function verifyChainRows(input: ChainVerifyInput): ChainVerifyOutcome {
  const { rows, seedPrevHash, fromSeq, toSeq, anchorComparable, rowCap } = input;

  let prevHash: Buffer = seedPrevHash;
  let prevSeq: number | null = null;
  let prevCreatedAt: Date | null = null;
  let totalVerified = 0;
  let walkedThrough = 0;
  let firstTamperedSeq: number | null = null;
  let firstGapAfterSeq: number | null = null;
  let firstTimestampViolationSeq: number | null = null;
  let firstBrokenLinkSeq: number | null = null;

  for (const row of rows) {
    const seq = Number(row.chain_seq);

    // Gaps are informational — they do not bail, because the rows that follow
    // are still individually checkable against their own predecessors.
    if (prevSeq !== null && firstGapAfterSeq === null && seq !== prevSeq + 1) {
      firstGapAfterSeq = prevSeq;
    }

    if (
      prevCreatedAt !== null &&
      row.created_at < prevCreatedAt &&
      firstTimestampViolationSeq === null
    ) {
      firstTimestampViolationSeq = seq;
    }

    // The stored back-pointer must agree with the hash we actually carried
    // forward. Recomputing event_hash from our own running prevHash would not
    // notice a chain_prev_hash edited on its own, so check it separately.
    // A null back-pointer cannot be reconciled and is treated as broken rather
    // than skipped — "no evidence" is not "evidence of integrity".
    if (firstBrokenLinkSeq === null) {
      if (row.chain_prev_hash === null) {
        firstBrokenLinkSeq = seq;
      } else if (!prevHash.equals(Buffer.from(row.chain_prev_hash))) {
        firstBrokenLinkSeq = seq;
      }
    }

    const payload =
      row.metadata != null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};

    const computed = computeEventHash(
      prevHash,
      computeCanonicalBytes(
        buildChainInput({
          id: row.id,
          createdAt: row.created_at,
          chainSeq: BigInt(row.chain_seq),
          prevHash,
          payload,
        }),
      ),
    );

    if (!computed.equals(Buffer.from(row.event_hash))) {
      // C15 (OWASP A08-2): stop here. Past a tamper the walk would re-seed
      // from a hash the attacker chose, so every later row would "verify"
      // against the attacker's own chain.
      firstTamperedSeq = seq;
      break;
    }

    prevHash = Buffer.from(row.event_hash);
    prevSeq = seq;
    prevCreatedAt = row.created_at;
    totalVerified++;
    walkedThrough++;
  }

  const coveredUpToSeq = prevSeq !== null ? prevSeq : fromSeq - 1;
  const incomplete = fromSeq > toSeq || coveredUpToSeq < toSeq;
  const truncated = rows.length >= rowCap && incomplete;

  // The anchor's head hash is the only thing that survives a rewrite of every
  // row: an attacker who re-hashes the chain from genesis produces a walk that
  // is internally consistent end to end. Comparable only when the walk really
  // covered the whole chain — a partial range ends somewhere else by design.
  const anchorPrevHash =
    input.anchorPrevHash != null ? Buffer.from(input.anchorPrevHash) : null;
  const anchorChecked = anchorComparable && anchorPrevHash !== null && !incomplete;
  const anchorMismatch = anchorChecked && !prevHash.equals(anchorPrevHash!);

  const integrityOk =
    firstTamperedSeq === null &&
    firstGapAfterSeq === null &&
    firstTimestampViolationSeq === null &&
    firstBrokenLinkSeq === null &&
    !anchorMismatch;

  const ok = integrityOk && !incomplete;

  let reason: ChainVerifyReason | undefined;
  if (!ok) {
    if (firstTamperedSeq !== null) {
      reason = CHAIN_VERIFY_REASON.TAMPER_DETECTED;
    } else if (anchorMismatch) {
      reason = CHAIN_VERIFY_REASON.ANCHOR_HASH_MISMATCH;
    } else if (firstBrokenLinkSeq !== null) {
      reason = CHAIN_VERIFY_REASON.TAMPER_DETECTED;
    } else if (firstGapAfterSeq !== null) {
      reason = CHAIN_VERIFY_REASON.GAP_DETECTED;
    } else if (firstTimestampViolationSeq !== null) {
      reason = CHAIN_VERIFY_REASON.TIMESTAMP_VIOLATION;
    } else if (truncated) {
      reason = CHAIN_VERIFY_REASON.TRUNCATED;
    } else {
      reason = CHAIN_VERIFY_REASON.RANGE_INCOMPLETE;
    }
  }

  return {
    ok,
    reason,
    totalVerified,
    walkedThrough,
    verifiedUpToSeq: prevSeq !== null ? prevSeq : undefined,
    truncated,
    incomplete,
    anchorChecked,
    firstTamperedSeq,
    firstGapAfterSeq,
    firstTimestampViolationSeq,
    firstBrokenLinkSeq,
  };
}
