/**
 * countDbStoredAttachments (`--count-db-blobs`, #1020) against an in-memory
 * attachments table: the SQL count for rows over MAX_OBJECT_REF_BYTES, keyset
 * pages for the rest judged by decodeObjectRef, every transaction under the
 * orphan sweep's grant. The real SQL and RLS are covered by
 * retention-gc-count-db-blobs.integration.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { countDbStoredAttachments } from "../sweep";
import { encodeObjectRef, MAX_OBJECT_REF_BYTES } from "@/lib/blob-store/object-ref";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { applySetConfigs, isBypassStateRead, sqlText, type GucState } from "@/__tests__/workers/retention-gc-tx-fakes";

type Row = { id: string; data: Uint8Array };

/**
 * The size comparison the query's SQL states against its bound parameter,
 * read from the statement text (the fragment just before the first bound
 * value), so the fake applies the operator the code wrote rather than one of
 * its own.
 */
function sizeComparison(strings: TemplateStringsArray): (length: number, bound: number) => boolean {
  const m = /octet_length\(encrypted_data\)\s*(<=|>=|<|>|=)\s*$/.exec(strings[0]);
  if (!m) throw new Error(`no size comparison before the bound in: ${strings[0]}`);
  const op = m[1];
  return (length, bound) =>
    op === "<=" ? length <= bound : op === ">=" ? length >= bound : op === "<" ? length < bound : op === ">" ? length > bound : length === bound;
}

interface Tx {
  gucs: GucState;
  queries: Array<{ text: string; values: unknown[] }>;
}

/** A workerPrisma whose transactions answer the bypass read and the two attachments queries from `rows`. */
function makePrisma(rows: Row[]) {
  const txs: Tx[] = [];
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  function makeTx() {
    const state: Tx = { gucs: { bypass_rls: null, purpose: null, tenant_id: null, tables: null }, queries: [] };
    txs.push(state);
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        applySetConfigs(state.gucs, strings, values);
        return 1;
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = sqlText(strings);
        if (isBypassStateRead(text)) return [{ ...state.gucs }];
        state.queries.push({ text, values });
        if (text.includes("count(*)")) {
          const [bound] = values as [number];
          const over = sizeComparison(strings);
          return [{ total: BigInt(sorted.length), over_bound: BigInt(sorted.filter((r) => over(r.data.length, bound)).length) }];
        }
        if (text.includes("ORDER BY id")) {
          const [bound, afterOrLimit, maybeLimit] = values as [number, string | number, number?];
          const afterId = maybeLimit === undefined ? null : (afterOrLimit as string);
          const limit = maybeLimit ?? (afterOrLimit as number);
          const within = sizeComparison(strings);
          return sorted
            .filter((r) => within(r.data.length, bound) && (afterId === null || r.id > afterId))
            .slice(0, limit)
            .map((r) => ({ id: r.id, encrypted_data: r.data }));
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
  }
  const workerPrisma = {
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx())),
  } as unknown as Parameters<typeof countDbStoredAttachments>[0];
  return { workerPrisma, txs };
}

const ciphertext = (): Row => ({ id: randomUUID(), data: randomBytes(64) });
const ref = (): Row => ({ id: randomUUID(), data: encodeObjectRef({ key: `personal/${randomUUID()}/${randomUUID()}.bin` }) });
/** A row just over the bound that WOULD decode as a ref: only its size may judge it. */
const overBound = (): Row => {
  const key = "k".repeat(MAX_OBJECT_REF_BYTES + 1 - '{"key":""}'.length);
  return { id: randomUUID(), data: Buffer.from(JSON.stringify({ key }), "utf8") };
};

/** A ref of exactly MAX_OBJECT_REF_BYTES: a reference, judged by decoding. */
const maximalRef = (): Row => ({ id: randomUUID(), data: encodeObjectRef({ key: "a".repeat(MAX_OBJECT_REF_BYTES - '{"key":""}'.length) }) });
/** Exactly MAX_OBJECT_REF_BYTES of attachment bytes: paged and judged database-stored. */
const atBoundBlob = (): Row => ({ id: randomUUID(), data: Buffer.alloc(MAX_OBJECT_REF_BYTES, 0xff) });

describe("countDbStoredAttachments", () => {
  it("judges a row of exactly MAX_OBJECT_REF_BYTES by decoding it, on both sides of the SQL bound", async () => {
    const rows = [maximalRef(), atBoundBlob()];
    expect(rows.map((r) => r.data.length)).toEqual([MAX_OBJECT_REF_BYTES, MAX_OBJECT_REF_BYTES]);
    const { workerPrisma } = makePrisma(rows);
    // The ref is not database-stored; the blob is, though it is not over the bound.
    await expect(countDbStoredAttachments(workerPrisma, 10)).resolves.toEqual({ total: 2, dbStored: 1 });
  });

  it("counts every row, and as database-stored the ciphertext rows and the rows over the bound", async () => {
    const rows = [ciphertext(), ciphertext(), ciphertext(), ref(), ref(), overBound()];
    expect(rows[5].data.length).toBe(MAX_OBJECT_REF_BYTES + 1);
    const { workerPrisma } = makePrisma(rows);
    await expect(countDbStoredAttachments(workerPrisma, 2)).resolves.toEqual({ total: 6, dbStored: 4 });
  });

  it("reads every row within the bound across pages, one transaction each, and stops on a short page", async () => {
    const rows = [ciphertext(), ref(), ciphertext(), ref(), ciphertext()];
    const { workerPrisma, txs } = makePrisma(rows);
    await expect(countDbStoredAttachments(workerPrisma, 2)).resolves.toEqual({ total: 5, dbStored: 3 });
    // One count, then pages of 2, 2 and 1.
    expect(txs.map((t) => t.queries.length)).toEqual([1, 1, 1, 1]);
    const afterIds = txs.slice(1).map((t) => (t.queries[0].values.length === 3 ? t.queries[0].values[1] : null));
    const ids = rows.map((r) => r.id).sort();
    expect(afterIds).toEqual([null, ids[1], ids[3]]);
  });

  it("asks one more page when the last page is exactly full", async () => {
    const { workerPrisma, txs } = makePrisma([ciphertext(), ref()]);
    await expect(countDbStoredAttachments(workerPrisma, 2)).resolves.toEqual({ total: 2, dbStored: 1 });
    expect(txs).toHaveLength(3);
  });

  it("never fetches a value over MAX_OBJECT_REF_BYTES", async () => {
    const { workerPrisma, txs } = makePrisma([overBound(), ciphertext()]);
    await countDbStoredAttachments(workerPrisma, 10);
    const bounds = txs.flatMap((t) => t.queries.map((q) => q.values[0]));
    expect(bounds).toEqual([MAX_OBJECT_REF_BYTES, MAX_OBJECT_REF_BYTES]);
  });

  it("runs every transaction under the orphan sweep's grant", async () => {
    const { workerPrisma, txs } = makePrisma([ciphertext(), ref(), ref()]);
    await countDbStoredAttachments(workerPrisma, 2);
    expect(txs.length).toBeGreaterThan(1);
    for (const t of txs) {
      expect(t.gucs.bypass_rls).toBe("on");
      expect(t.gucs.tables).toBe(BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP.tables);
    }
  });

  it("reports zero for an empty table", async () => {
    const { workerPrisma } = makePrisma([]);
    await expect(countDbStoredAttachments(workerPrisma)).resolves.toEqual({ total: 0, dbStored: 0 });
  });

  it.each([0, -1, 1.5])("refuses a page size of %s before any query", async (pageSize) => {
    const { workerPrisma, txs } = makePrisma([ciphertext()]);
    await expect(countDbStoredAttachments(workerPrisma, pageSize)).rejects.toThrow("pageSize must be a positive integer");
    expect(txs).toHaveLength(0);
  });
});
