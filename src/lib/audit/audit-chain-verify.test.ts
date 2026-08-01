import { describe, it, expect } from "vitest";
import {
  verifyChainRows,
  GENESIS_PREV_HASH,
  CHAIN_VERIFY_REASON,
  type ChainVerifyRow,
} from "./audit-chain-verify";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "./audit-chain";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

/**
 * Build a genuinely-chained run. Fixtures go through the same primitives
 * production uses, so a change to the hash construction that this module did
 * not follow surfaces here as a tamper rather than as a still-green test.
 */
function buildChain(
  seqs: number[],
  opts: { createdAtFor?: (seq: number, index: number) => Date } = {},
): { rows: ChainVerifyRow[]; headHash: Buffer } {
  let prevHash: Buffer = GENESIS_PREV_HASH;
  const rows = seqs.map((seq, index) => {
    const createdAt =
      opts.createdAtFor?.(seq, index) ?? new Date(BASE_TIME.getTime() + index * 1000);
    const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
    const metadata = { action: "TEST_EVENT", seq };
    const eventHash = computeEventHash(
      prevHash,
      computeCanonicalBytes(
        buildChainInput({ id, createdAt, chainSeq: BigInt(seq), prevHash, payload: metadata }),
      ),
    );
    const row: ChainVerifyRow = {
      id,
      created_at: createdAt,
      chain_seq: String(seq),
      event_hash: eventHash,
      chain_prev_hash: prevHash,
      metadata,
    };
    prevHash = eventHash;
    return row;
  });
  return { rows, headHash: prevHash };
}

function tamper(hash: Uint8Array): Buffer {
  const corrupted = Buffer.from(hash);
  corrupted[0] ^= 0xff;
  return corrupted;
}

/** Full-chain walk with the anchor head supplied — the worker's shape. */
function verifyFull(
  rows: ChainVerifyRow[],
  anchorSeq: number,
  anchorPrevHash: Uint8Array | null,
  rowCap = 10_000,
) {
  return verifyChainRows({
    rows,
    seedPrevHash: GENESIS_PREV_HASH,
    fromSeq: 1,
    toSeq: anchorSeq,
    anchorPrevHash,
    anchorComparable: true,
    rowCap,
  });
}

describe("verifyChainRows", () => {
  it("accepts an intact chain that ends on the anchor head", () => {
    const { rows, headHash } = buildChain([1, 2, 3]);

    const out = verifyFull(rows, 3, headHash);

    expect(out.ok).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(out.totalVerified).toBe(3);
    expect(out.anchorChecked).toBe(true);
  });

  // ─── The whole-chain rewrite ──────────────────────────────

  it("rejects a chain rewritten end-to-end whose hashes are internally consistent", () => {
    // The attacker's chain verifies perfectly against itself: every row was
    // re-hashed from genesis, so per-row checks, gap checks and back-pointers
    // all agree. The anchor's recorded head is the only value that did not move
    // with them, and comparing against it is the only thing that says no.
    const { rows: forged } = buildChain([1, 2, 3]);
    const { headHash: genuineHead } = buildChain([1, 2, 3], {
      createdAtFor: (_seq, index) => new Date(BASE_TIME.getTime() + index * 5000),
    });

    const out = verifyFull(forged, 3, genuineHead);

    expect(out.ok).toBe(false);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.ANCHOR_HASH_MISMATCH);
    // Nothing is wrong *within* the forged chain — which is exactly why the
    // per-row signals stay clean and only the anchor catches it.
    expect(out.firstTamperedSeq).toBeNull();
    expect(out.firstGapAfterSeq).toBeNull();
    expect(out.firstBrokenLinkSeq).toBeNull();
    expect(out.totalVerified).toBe(3);
  });

  it("does not compare the anchor head on a partial range", () => {
    // A walk bounded by from/to legitimately ends somewhere other than the
    // chain head, so comparing there would fail every partial verification.
    const { rows } = buildChain([1, 2, 3]);
    const out = verifyChainRows({
      rows: rows.slice(0, 2),
      seedPrevHash: GENESIS_PREV_HASH,
      fromSeq: 1,
      toSeq: 2,
      anchorPrevHash: Buffer.alloc(32, 0xaa),
      anchorComparable: false,
      rowCap: 10_000,
    });

    expect(out.ok).toBe(true);
    expect(out.anchorChecked).toBe(false);
  });

  it("reports anchorChecked=false when no anchor head is supplied", () => {
    const { rows } = buildChain([1, 2, 3]);

    const out = verifyFull(rows, 3, null);

    expect(out.ok).toBe(true);
    // Green here is a weaker statement than green with the anchor compared,
    // and the flag is what lets a caller tell the two apart.
    expect(out.anchorChecked).toBe(false);
  });

  // ─── Per-row integrity ────────────────────────────────────

  it("bails at the first tampered row without counting later rows", () => {
    const { rows, headHash } = buildChain([1, 2, 3]);
    rows[1].event_hash = tamper(rows[1].event_hash);

    const out = verifyFull(rows, 3, headHash);

    expect(out.reason).toBe(CHAIN_VERIFY_REASON.TAMPER_DETECTED);
    expect(out.firstTamperedSeq).toBe(2);
    expect(out.totalVerified).toBe(1);
  });

  it("detects a back-pointer edited on its own", () => {
    // event_hash is recomputed from the running prevHash, so a chain_prev_hash
    // rewritten by itself leaves every hash check passing. Only comparing the
    // stored back-pointer catches it.
    const { rows, headHash } = buildChain([1, 2, 3]);
    rows[2].chain_prev_hash = tamper(rows[2].chain_prev_hash!);

    const out = verifyFull(rows, 3, headHash);

    expect(out.ok).toBe(false);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.TAMPER_DETECTED);
    expect(out.firstBrokenLinkSeq).toBe(3);
    expect(out.firstTamperedSeq).toBeNull();
  });

  it("treats a null back-pointer as broken rather than skipping it", () => {
    const { rows, headHash } = buildChain([1, 2]);
    rows[1].chain_prev_hash = null;

    const out = verifyFull(rows, 2, headHash);

    expect(out.ok).toBe(false);
    expect(out.firstBrokenLinkSeq).toBe(2);
  });

  it("reports a chain_seq gap", () => {
    const { rows, headHash } = buildChain([1, 3]);

    const out = verifyFull(rows, 3, headHash);

    expect(out.reason).toBe(CHAIN_VERIFY_REASON.GAP_DETECTED);
    expect(out.firstGapAfterSeq).toBe(1);
  });

  it("reports a backwards created_at", () => {
    const { rows, headHash } = buildChain([1, 2, 3], {
      createdAtFor: (seq) => new Date(BASE_TIME.getTime() + (seq === 3 ? 0 : seq * 1000)),
    });

    const out = verifyFull(rows, 3, headHash);

    expect(out.reason).toBe(CHAIN_VERIFY_REASON.TIMESTAMP_VIOLATION);
    expect(out.firstTimestampViolationSeq).toBe(3);
  });

  // ─── Coverage ─────────────────────────────────────────────

  it("fails closed when rows above the walk are missing", () => {
    const { rows, headHash } = buildChain([1, 2]);

    const out = verifyFull(rows, 5, headHash);

    expect(out.ok).toBe(false);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.RANGE_INCOMPLETE);
    expect(out.truncated).toBe(false);
    // The head comparison cannot be trusted on an incomplete walk, so it is
    // not run — the shortfall is the finding.
    expect(out.anchorChecked).toBe(false);
  });

  it("fails closed when every row is gone but the anchor still claims a head", () => {
    const out = verifyFull([], 5, Buffer.alloc(32, 0xbb));

    expect(out.ok).toBe(false);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.RANGE_INCOMPLETE);
    expect(out.totalVerified).toBe(0);
  });

  it("distinguishes hitting the row cap from rows being deleted", () => {
    const { rows, headHash } = buildChain([1, 2]);

    const capped = verifyFull(rows, 5, headHash, 2);
    expect(capped.reason).toBe(CHAIN_VERIFY_REASON.TRUNCATED);
    expect(capped.truncated).toBe(true);

    const deleted = verifyFull(rows, 5, headHash, 10_000);
    expect(deleted.reason).toBe(CHAIN_VERIFY_REASON.RANGE_INCOMPLETE);
    expect(deleted.truncated).toBe(false);
  });

  it("fails closed on an inverted range rather than passing vacuously", () => {
    const out = verifyChainRows({
      rows: [],
      seedPrevHash: GENESIS_PREV_HASH,
      fromSeq: 50,
      toSeq: 40,
      anchorPrevHash: null,
      anchorComparable: false,
      rowCap: 10_000,
    });

    // coveredUpToSeq (49) exceeds toSeq (40), so a naive `covered < toSeq`
    // would call this verified having read nothing.
    expect(out.ok).toBe(false);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.RANGE_INCOMPLETE);
  });

  it("ranks a tamper above the coverage shortfall its own bail causes", () => {
    const { rows, headHash } = buildChain([1, 2, 3]);
    rows[0].event_hash = tamper(rows[0].event_hash);

    const out = verifyFull(rows, 3, headHash);

    // Bailing at seq 1 also leaves the walk short of toSeq; the operator needs
    // to see the tamper, not the shortfall it produced.
    expect(out.incomplete).toBe(true);
    expect(out.reason).toBe(CHAIN_VERIFY_REASON.TAMPER_DETECTED);
  });
});
