/**
 * sweepOrphanBlobs decision cells (#1010, C4): a fake store and fake row read
 * around the real classification (parseObjectKey, the exact-key comparison,
 * the grace check), the real breaker and the real cursor handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  sweepOrphanBlobs,
  BLOB_SWEEP_REFUSAL,
  type BlobCursor,
  type BlobSweepDeps,
  type BlobSweepOptions,
  type AttachmentRefRow,
} from "../sweep-blob-orphans";
import { readAttachmentRefs } from "../sweep";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";
import { BLOB_STORAGE, type AttachmentBlobStore, type AttachmentBlobContext } from "@/lib/blob-store/types";
import { encodeObjectRef, decodeObjectRef, newBlobGeneration } from "@/lib/blob-store/object-ref";
import { isBypassStateRead, sqlText } from "@/__tests__/workers/retention-gc-tx-fakes";

const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRACE_MS = 60_000;
const NOW = new Date("2026-06-01T00:00:00Z");
const OLD = new Date(NOW.getTime() - GRACE_MS - 1);
const PREFIX = "sweep-test";

interface FakeObject {
  key: string;
  lastModified: Date;
}

/** An in-memory bucket: keys listed in order, an index string as the cursor. */
class FakeStore {
  objects: FakeObject[] = [];
  marker: string | null = DEPLOYMENT_ID;
  deleted: string[] = [];
  writes = 0;
  failDeleteOf = new Set<string>();
  listCalls: Array<{ cursor?: string; pageSize: number }> = [];

  asStore(): AttachmentBlobStore {
    return {
      backend: BLOB_STORAGE.S3,
      validateConfig: () => {},
      putObject: async () => {
        this.writes++;
        return new Uint8Array();
      },
      getObject: async () => Buffer.alloc(0),
      deleteObject: async (stored: Uint8Array, _context: AttachmentBlobContext) => {
        const key = decodeObjectRef(stored)?.key ?? "";
        if (this.failDeleteOf.has(key)) throw Object.assign(new Error(`cannot delete ${key}`), { name: "InternalError" });
        this.deleted.push(key);
        this.objects = this.objects.filter((o) => o.key !== key);
      },
      listObjects: async (prefix: string, { cursor, pageSize }: { cursor?: string; pageSize: number }) => {
        this.listCalls.push({ cursor, pageSize });
        const listed = this.objects.filter((o) => o.key.startsWith(prefix));
        const start = cursor ? Number(cursor) : 0;
        const objects = listed.slice(start, start + pageSize);
        const next = start + pageSize;
        return next < listed.length ? { objects, cursor: String(next) } : { objects };
      },
      readMarker: async () => this.marker,
      createMarker: async () => {
        this.writes++;
        return "created" as const;
      },
      toStored: (d) => (d instanceof Uint8Array ? d : new Uint8Array(d)),
      toBuffer: (d) => Buffer.from(d),
      toBase64: (d) => Buffer.from(d).toString("base64"),
    };
  }
}

/** Attachments rows by id: the ref each one stores. */
class FakeRows {
  rows = new Map<string, Uint8Array>();
  calls: string[][] = [];
  readRefs = async (ids: string[]): Promise<AttachmentRefRow[]> => {
    this.calls.push(ids);
    return ids.flatMap((id) => {
      const encryptedData = this.rows.get(id);
      return encryptedData ? [{ id, encryptedData }] : [];
    });
  };
}

function keyFor(attachmentId: string, generation = newBlobGeneration(), entryId = randomUUID()): string {
  return `${PREFIX}/personal/${entryId}/${attachmentId}/${generation}.bin`;
}

let store: FakeStore;
let rows: FakeRows;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let cursor: BlobCursor;

/** An object whose row references it; returns its key. */
function referenced(lastModified = OLD): string {
  const id = randomUUID();
  const key = keyFor(id);
  store.objects.push({ key, lastModified });
  rows.rows.set(id, encodeObjectRef({ key }));
  return key;
}

/** An object no row references; returns its key. */
function orphan(lastModified = OLD): string {
  const key = keyFor(randomUUID());
  store.objects.push({ key, lastModified });
  return key;
}

function deps(now = NOW): BlobSweepDeps {
  return { readRefs: rows.readRefs, store: store.asStore(), now: () => now, log } as BlobSweepDeps;
}

function opts(overrides: Partial<BlobSweepOptions> = {}): BlobSweepOptions {
  return {
    mode: BLOB_SWEEP_MODE.DELETE,
    graceMs: GRACE_MS,
    maxObjects: 1000,
    maxDeletes: 1000,
    pageSize: 1000,
    maxDeleteRatio: 0.5,
    deploymentId: DEPLOYMENT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("BLOB_OBJECT_PREFIX", PREFIX);
  store = new FakeStore();
  rows = new FakeRows();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  cursor = { sawReferenced: false };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("classification", () => {
  it("keeps a referenced object and deletes an unreferenced one", async () => {
    const live = referenced();
    const gone = orphan();
    const result = await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(store.deleted).toEqual([gone]);
    expect(store.objects.map((o) => o.key)).toEqual([live]);
    expect(result).toMatchObject({ listed: 2, referenced: 1, deleted: 1 });
    expect(result.refused).toBeUndefined();
  });

  it("keeps an object at put + grace - 1 ms and deletes it at put + grace + 1 ms", async () => {
    referenced();
    const put = new Date(NOW.getTime() - GRACE_MS);
    const key = orphan(put);
    const young = await sweepOrphanBlobs(deps(new Date(put.getTime() + GRACE_MS - 1)), opts(), cursor);
    expect(young).toMatchObject({ young: 1, deleted: 0 });
    expect(store.deleted).toEqual([]);
    cursor = { sawReferenced: false };
    await sweepOrphanBlobs(deps(new Date(put.getTime() + GRACE_MS + 1)), opts(), cursor);
    expect(store.deleted).toEqual([key]);
  });

  it("deletes an object at exactly put + grace (the boundary is inclusive)", async () => {
    referenced();
    const put = new Date(NOW.getTime() - GRACE_MS);
    const key = orphan(put);
    const result = await sweepOrphanBlobs(deps(new Date(put.getTime() + GRACE_MS)), opts(), cursor);
    expect(result).toMatchObject({ young: 0, deleted: 1 });
    expect(store.deleted).toEqual([key]);
  });

  it("keeps and counts an unparseable key, and never reads a row for it", async () => {
    const live = referenced();
    const unparseableId = randomUUID();
    // A valid attachment id behind a non-UUID entry segment: a read of it would show.
    store.objects.push({ key: `${PREFIX}/personal/not-a-uuid/${unparseableId}/${newBlobGeneration()}.bin`, lastModified: OLD });
    store.objects.push({ key: `${PREFIX}/.passwd-sso-deployment`, lastModified: OLD });
    const result = await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(result).toMatchObject({ unparseable: 2, deleted: 0 });
    expect(store.deleted).toEqual([]);
    expect(rows.calls).toEqual([[live.split("/")[3]]]);
  });

  it("deletes the old generation of a live attachment and keeps the generation its row names", async () => {
    const id = randomUUID();
    const entryId = randomUUID();
    const oldKey = keyFor(id, newBlobGeneration(), entryId);
    const newKey = keyFor(id, newBlobGeneration(), entryId);
    store.objects.push({ key: oldKey, lastModified: OLD }, { key: newKey, lastModified: OLD });
    rows.rows.set(id, encodeObjectRef({ key: newKey }));
    await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(store.deleted).toEqual([oldKey]);
  });

  it.each([
    ["a longer key", (key: string) => `${key}.extra`],
    ["a prefix of the key", (key: string) => key.slice(0, -".bin".length)],
  ])("compares the whole key: a ref naming %s does not keep the object", async (_label, refFor) => {
    referenced();
    const id = randomUUID();
    const key = keyFor(id);
    store.objects.push({ key, lastModified: OLD });
    rows.rows.set(id, encodeObjectRef({ key: refFor(key) }));
    await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(store.deleted).toEqual([key]);
  });

  it("matches an uppercase attachment id in the key to its row", async () => {
    referenced();
    const id = randomUUID();
    const key = keyFor(id.toUpperCase());
    store.objects.push({ key, lastModified: OLD });
    rows.rows.set(id, encodeObjectRef({ key }));
    await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(rows.calls.flat()).toContain(id);
    expect(store.deleted).toEqual([]);
  });
});

describe("modes and the marker", () => {
  it("report mode deletes nothing, writes nothing, and counts wouldDelete", async () => {
    referenced();
    orphan();
    orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ mode: BLOB_SWEEP_MODE.REPORT }), cursor);
    expect(result).toMatchObject({ wouldDelete: 2, deleted: 0 });
    expect(store.deleted).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it.each([
    ["absent", null, BLOB_SWEEP_REFUSAL.MARKER_MISSING],
    ["another deployment's", "11111111-1111-4111-8111-111111111111", BLOB_SWEEP_REFUSAL.MARKER_MISMATCH],
  ])("refuses when the marker is %s, listing and writing nothing", async (_label, marker, refused) => {
    referenced();
    orphan();
    store.marker = marker;
    const result = await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(result.refused).toBe(refused);
    expect(store.deleted).toEqual([]);
    expect(store.writes).toBe(0);
    expect(store.listCalls).toEqual([]);
  });

  it("deletes when the marker matches (the allow side of the marker cells)", async () => {
    referenced();
    const gone = orphan();
    store.marker = DEPLOYMENT_ID;
    expect((await sweepOrphanBlobs(deps(), opts(), cursor)).refused).toBeUndefined();
    expect(store.deleted).toEqual([gone]);
  });
});

describe("the breaker", () => {
  it("does not trip on 20 unreferenced keys at ratio 1.0 with one referenced key", async () => {
    referenced();
    for (let i = 0; i < 20; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 1 }), cursor);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(20);
  });

  it("trips on an empty database: unreferenced keys and no referenced key, even at or below 20", async () => {
    for (let i = 0; i < 3; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 1 }), cursor);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it("deletes an all-orphan tail tick after a tick of the same pass saw a reference", async () => {
    referenced();
    referenced();
    const tail = [orphan(), orphan()];
    const first = await sweepOrphanBlobs(deps(), opts({ maxObjects: 2, pageSize: 2 }), cursor);
    expect(first).toMatchObject({ referenced: 2, deleted: 0 });
    expect(cursor.value).toBeDefined();
    const second = await sweepOrphanBlobs(deps(), opts({ maxObjects: 2, pageSize: 2 }), cursor);
    expect(second.refused).toBeUndefined();
    expect(store.deleted).toEqual(tail);
  });

  it("trips on the same all-orphan tail when it starts a new pass", async () => {
    referenced();
    referenced();
    orphan();
    orphan();
    await sweepOrphanBlobs(deps(), opts({ maxObjects: 2, pageSize: 2 }), cursor);
    // A restart (or a completed pass) clears the cursor and its evidence.
    cursor = { value: "2", sawReferenced: false };
    const result = await sweepOrphanBlobs(deps(), opts({ maxObjects: 2, pageSize: 2 }), cursor);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it.each([
    ["an empty bucket", () => {}],
    ["a young and unparseable only tick", () => {
      orphan(NOW);
      store.objects.push({ key: `${PREFIX}/personal/x/y.bin`, lastModified: OLD });
    }],
  ])("does not refuse %s and counts 0", async (_label, seed) => {
    seed();
    const result = await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(0);
  });

  // The 20-key floor at the default ratio: 20 orphans of 21 old keys are
  // above 0.5 but not above the floor; 21 orphans are above both.
  it("does not trip on 20 unreferenced keys with one referenced at ratio 0.5 (the floor)", async () => {
    referenced();
    for (let i = 0; i < 20; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 0.5 }), cursor);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(20);
  });

  it("trips on 21 unreferenced keys with one referenced at ratio 0.5 (one past the floor)", async () => {
    referenced();
    for (let i = 0; i < 21; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 0.5 }), cursor);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it("trips on 21 unreferenced keys above the ratio", async () => {
    for (let i = 0; i < 20; i++) referenced();
    for (let i = 0; i < 21; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 0.5 }), cursor);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it("does not trip on 21 unreferenced keys at exactly the ratio", async () => {
    for (let i = 0; i < 21; i++) referenced();
    for (let i = 0; i < 21; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeleteRatio: 0.5 }), cursor);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(21);
  });

  it("does not trip at exactly maxDeletes", async () => {
    for (let i = 0; i < 10; i++) referenced();
    for (let i = 0; i < 3; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeletes: 3, maxDeleteRatio: 1 }), cursor);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(3);
  });

  it("trips over maxDeletes whatever the ratio", async () => {
    for (let i = 0; i < 10; i++) referenced();
    for (let i = 0; i < 4; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ maxDeletes: 3, maxDeleteRatio: 1 }), cursor);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it("trips on a wrong database spread over many small pages (cumulative counts, not per page)", async () => {
    referenced();
    for (let i = 0; i < 30; i++) orphan();
    const result = await sweepOrphanBlobs(deps(), opts({ pageSize: 2 }), cursor);
    expect(store.listCalls.length).toBeGreaterThan(10);
    expect(result.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(store.deleted).toEqual([]);
  });

  it("deletes a contiguous orphan block inside a mostly-referenced tick", async () => {
    for (let i = 0; i < 30; i++) referenced();
    const block = Array.from({ length: 25 }, () => orphan());
    for (let i = 0; i < 30; i++) referenced();
    const result = await sweepOrphanBlobs(deps(), opts({ pageSize: 10 }), cursor);
    expect(result.refused).toBeUndefined();
    expect(store.deleted).toEqual(block);
  });

  it("a tripped tick still advances the cursor, and the next tick processes later keys", async () => {
    referenced();
    for (let i = 0; i < 3; i++) orphan();
    const later = referenced();
    const tripped = await sweepOrphanBlobs(deps(), opts({ maxObjects: 4, pageSize: 4, maxDeletes: 2 }), cursor);
    expect(tripped.refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    expect(cursor.value).toBe("4");
    const next = await sweepOrphanBlobs(deps(), opts({ maxObjects: 4, pageSize: 4, maxDeletes: 2 }), cursor);
    expect(next).toMatchObject({ listed: 1, referenced: 1 });
    expect(rows.calls.at(-1)).toEqual([later.split("/")[3]]);
    // The listing completed: the next tick starts a new pass.
    expect(cursor).toEqual({ value: undefined, sawReferenced: false });
  });

  it("lists at most maxObjects per tick, cutting the page to fit", async () => {
    for (let i = 0; i < 7; i++) referenced();
    const result = await sweepOrphanBlobs(deps(), opts({ maxObjects: 5, pageSize: 3 }), cursor);
    expect(result.listed).toBe(5);
    expect(store.listCalls.map((c) => c.pageSize)).toEqual([3, 2]);
    expect(cursor.value).toBe("5");
  });
});

describe("failures and logging", () => {
  it("throws when the row read runs without the RLS bypass, deleting nothing", async () => {
    referenced();
    orphan();
    const offTx = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$queryRaw"
            ? async (strings: TemplateStringsArray) => {
                if (isBypassStateRead(sqlText(strings))) return [{ bypass_rls: "off" }];
                throw new Error("reached the attachments read");
              }
            : undefined,
      },
    ) as Prisma.TransactionClient;
    const readRefs = (ids: string[]) => readAttachmentRefs(offTx, ids);
    await expect(sweepOrphanBlobs({ ...deps(), readRefs }, opts(), cursor)).rejects.toThrow(
      "retention-gc sweep requires the RLS bypass state its entry declares",
    );
    expect(store.deleted).toEqual([]);
  });

  it("counts a delete failure without throwing and deletes the rest", async () => {
    referenced();
    const failing = orphan();
    const ok = orphan();
    store.failDeleteOf.add(failing);
    const result = await sweepOrphanBlobs(deps(), opts(), cursor);
    expect(result).toMatchObject({ deleted: 1, deleteFailed: 1 });
    expect(store.deleted).toEqual([ok]);
  });

  it("resets the cursor and throws a coded error when listing fails", async () => {
    cursor = { value: "3", sawReferenced: true };
    const failing = store.asStore();
    failing.listObjects = async () => {
      throw Object.assign(new Error(`AccessDenied for ${PREFIX}/personal/x`), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    };
    await expect(sweepOrphanBlobs({ ...deps(), store: failing }, opts(), cursor)).rejects.toMatchObject({
      code: "RETENTION_GC_BLOB_LIST_FAILED",
    });
    expect(cursor).toEqual({ value: undefined, sawReferenced: false });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: "AccessDenied", code: "unknown" }, httpStatusCode: 403 }),
      "retention-gc.blob_sweep_list_failed",
    );
  });

  it("no logger argument contains any listed key", async () => {
    const keys = [referenced(), orphan(), orphan(NOW)];
    store.failDeleteOf.add(keys[1]);
    await sweepOrphanBlobs(deps(), opts(), cursor);
    // A breaker refusal logs too.
    for (let i = 0; i < 3; i++) keys.push(orphan());
    cursor = { sawReferenced: false };
    expect((await sweepOrphanBlobs(deps(), opts({ maxDeletes: 1 }), cursor)).refused).toBe(BLOB_SWEEP_REFUSAL.BREAKER);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(log.error).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    for (const key of keys) expect(logged).not.toContain(key.split("/")[3]);
  });
});
