/**
 * sweepOnce's two dedicated sweeps (#1009 team key prune, #1010 orphan-blob
 * sweep), driven through sweepOnce with a fake Prisma whose every
 * `$transaction` gets a fresh tx holding its own GUC state — the same model as
 * sweep-dispatch-bypass.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

const { logError, logInfo, logWarn, storeRef } = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  storeRef: { current: null as unknown },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: logInfo, error: logError, warn: logWarn }),
}));
vi.mock("@/lib/blob-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blob-store")>();
  return { ...actual, getAttachmentBlobStore: () => storeRef.current ?? actual.getAttachmentBlobStore() };
});

import { sweepOnce, PRUNE_AUDIT_MAX_HOLDERS, type SweepOpts } from "../sweep";
import type { BlobCursor } from "../sweep-blob-orphans";
import { BLOB_SWEEP_MODE } from "@/lib/blob-store/constants";
import { BLOB_STORAGE, type AttachmentBlobStore } from "@/lib/blob-store/types";
import { encodeObjectRef, newBlobGeneration } from "@/lib/blob-store/object-ref";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { documentedMetadataKeys } from "@/__tests__/helpers/audit-log-reference";
import { applySetConfigs, isBypassStateRead, sqlText, type GucState } from "@/__tests__/workers/retention-gc-tx-fakes";

const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OLD = new Date(Date.now() - 10 * 86_400_000);

type PruneRow = { pruned_tenant_id: string; pruned_team_id: string; pruned_key_version: number; pruned_user_ids: string[] };

interface FakeTx {
  calls: Array<{ name: string; args: unknown[] }>;
  gucs: GucState;
}

function makePrisma(opts: { pruneRows?: PruneRow[]; pruneError?: Error; attachmentRows?: Map<string, Uint8Array> } = {}) {
  const txs: FakeTx[] = [];
  function makeTx() {
    const state: FakeTx = { calls: [], gucs: { bypass_rls: null, purpose: null, tenant_id: null, tables: null } };
    txs.push(state);
    const record = (name: string, impl: (...args: never[]) => unknown) =>
      async (...args: unknown[]) => {
        state.calls.push({ name, args });
        return (impl as (...a: unknown[]) => unknown)(...args);
      };
    return {
      $executeRaw: record("$executeRaw", (strings: TemplateStringsArray, ...values: unknown[]) => {
        applySetConfigs(state.gucs, strings, values);
        return 1;
      }),
      $queryRaw: record("$queryRaw", (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = sqlText(strings);
        if (isBypassStateRead(text)) return [{ ...state.gucs }];
        if (text.includes("SELECT EXISTS")) return [{ ok: true }];
        if (text.includes("team_member_key_prune")) {
          if (opts.pruneError) throw opts.pruneError;
          return opts.pruneRows ?? [];
        }
        if (text.includes("FROM attachments")) {
          const ids = values[0] as string[];
          return ids.flatMap((id) => {
            const data = opts.attachmentRows?.get(id);
            return data ? [{ id, encrypted_data: data }] : [];
          });
        }
        return [];
      }),
      $executeRawUnsafe: record("$executeRawUnsafe", () => 0),
      $queryRawUnsafe: record("$queryRawUnsafe", () => []),
      tenant: { findMany: record("tenant.findMany", () => []) },
      auditOutbox: { create: record("auditOutbox.create", () => ({})) },
    };
  }
  const workerPrisma = {
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx())),
  } as unknown as Parameters<typeof sweepOnce>[0];
  return { workerPrisma, txs };
}

const BASE: SweepOpts = { intervalMs: 1, emitHeartbeatAudit: false };

function pruneTxs(txs: FakeTx[]): FakeTx[] {
  return txs.filter((t) => t.calls.some((c) => c.name === "$queryRaw" && sqlText(c.args[0]).includes("team_member_key_prune")));
}

function audits(txs: FakeTx[]) {
  return txs.flatMap((t) =>
    t.calls
      .filter((c) => c.name === "auditOutbox.create")
      .map((c) => (c.args[0] as { data: { tenantId: string; payload: Record<string, unknown> } }).data),
  );
}

beforeEach(() => {
  logError.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
  storeRef.current = null;
});

describe("team key prune dispatch (#1009)", () => {
  it.each([
    ["absent", {}],
    ["false", { teamKeyPrune: false }],
  ])("never calls team_member_key_prune when the flag is %s", async (_label, flag) => {
    const { workerPrisma, txs } = makePrisma();
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, ...flag });
    expect(pruneTxs(txs)).toEqual([]);
    expect(counts).not.toHaveProperty("team_member_keys");
  });

  it("calls it once, under its own bypass grant, when the flag is on (positive control)", async () => {
    const { workerPrisma, txs } = makePrisma();
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, teamKeyPrune: true });
    const [tx] = pruneTxs(txs);
    expect(pruneTxs(txs)).toHaveLength(1);
    expect(tx.gucs.bypass_rls).toBe("on");
    expect(tx.gucs.tables).toBe(BYPASS_GRANT.RETENTION_TEAM_KEY_PRUNE.tables);
    expect(counts.team_member_keys).toBe(0);
  });

  it("emits one TEAM_MEMBER_KEY_PRUNED row per team in the prune's transaction and counts rows", async () => {
    const [tenantA, tenantB, teamA, teamB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [u1, u2] = [randomUUID(), randomUUID()].sort();
    const { workerPrisma, txs } = makePrisma({
      pruneRows: [
        { pruned_tenant_id: tenantA, pruned_team_id: teamA, pruned_key_version: 2, pruned_user_ids: [u1, u2] },
        { pruned_tenant_id: tenantA, pruned_team_id: teamA, pruned_key_version: 1, pruned_user_ids: [u1] },
        { pruned_tenant_id: tenantB, pruned_team_id: teamB, pruned_key_version: 1, pruned_user_ids: [u2] },
      ],
    });
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, teamKeyPrune: true });
    expect(counts.team_member_keys).toBe(4);
    const [tx] = pruneTxs(txs);
    expect(audits([tx])).toEqual([
      {
        tenantId: tenantA,
        payload: expect.objectContaining({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.TEAM_MEMBER_KEY_PRUNED,
          teamId: teamA,
          targetId: teamA,
          metadata: { keyVersions: [1, 2], rows: 3, holderUserIds: [u1, u2], holderUserIdsOmitted: 0 },
        }),
      },
      {
        tenantId: tenantB,
        payload: expect.objectContaining({
          teamId: teamB,
          metadata: { keyVersions: [1], rows: 1, holderUserIds: [u2], holderUserIdsOmitted: 0 },
        }),
      },
    ]);
  });

  it("emits exactly the metadata keys audit-log-reference.md documents", async () => {
    const { workerPrisma, txs } = makePrisma({
      pruneRows: [{ pruned_tenant_id: randomUUID(), pruned_team_id: randomUUID(), pruned_key_version: 1, pruned_user_ids: [randomUUID()] }],
    });
    await sweepOnce(workerPrisma, 100, { ...BASE, teamKeyPrune: true });
    const metadata = audits(txs)[0].payload.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(documentedMetadataKeys(AUDIT_ACTION.TEAM_MEMBER_KEY_PRUNED));
  });

  it("bounds holderUserIds and counts the rest", async () => {
    const holders = Array.from({ length: PRUNE_AUDIT_MAX_HOLDERS + 5 }, () => randomUUID());
    const { workerPrisma, txs } = makePrisma({
      pruneRows: [{ pruned_tenant_id: randomUUID(), pruned_team_id: randomUUID(), pruned_key_version: 1, pruned_user_ids: holders }],
    });
    await sweepOnce(workerPrisma, 100, { ...BASE, teamKeyPrune: true });
    const metadata = audits(txs)[0].payload.metadata as { holderUserIds: string[]; holderUserIdsOmitted: number; rows: number };
    expect(metadata.holderUserIds).toEqual([...holders].sort().slice(0, PRUNE_AUDIT_MAX_HOLDERS));
    expect(metadata.holderUserIdsOmitted).toBe(5);
    expect(metadata.rows).toBe(holders.length);
  });

  it("records -1 and logs the driver SQLSTATE, not Prisma's P2010 wrapper, when the prune fails", async () => {
    // The shape the pg adapter produces for a $queryRaw failure.
    const pruneError = Object.assign(new Error("raw query failed"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "42501", code: "42501" } } },
    });
    const { workerPrisma } = makePrisma({ pruneError });
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, teamKeyPrune: true });
    expect(counts.team_member_keys).toBe(-1);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ table: "team_member_keys", code: "42501", _logType: "retention-gc.entry_failed" }),
      "retention-gc.entry_failed",
    );
  });
});

describe("orphan-blob sweep dispatch (#1010)", () => {
  const PREFIX = "dispatch";
  let objects: Array<{ key: string; lastModified: Date }>;
  let marker: string | null;
  let deleted: string[];

  function fakeStore(backend: AttachmentBlobStore["backend"] = BLOB_STORAGE.S3): AttachmentBlobStore {
    return {
      backend,
      validateConfig: () => {},
      putObject: async () => new Uint8Array(),
      getObject: async () => Buffer.alloc(0),
      deleteObject: async (stored) => {
        deleted.push(JSON.parse(Buffer.from(stored).toString("utf8")).key);
      },
      listObjects: async (_prefix, { cursor, pageSize }) => {
        const start = cursor ? Number(cursor) : 0;
        const next = start + pageSize;
        const page = objects.slice(start, next);
        return next < objects.length ? { objects: page, cursor: String(next) } : { objects: page };
      },
      readMarker: async () => marker,
      createMarker: async () => "created" as const,
      toStored: (d) => (d instanceof Uint8Array ? d : new Uint8Array(d)),
      toBuffer: (d) => Buffer.from(d),
      toBase64: (d) => Buffer.from(d).toString("base64"),
    };
  }

  function seed(referenced: number, orphans: number) {
    const rows = new Map<string, Uint8Array>();
    const orphanKeys: string[] = [];
    for (let i = 0; i < referenced + orphans; i++) {
      const id = randomUUID();
      const key = `${PREFIX}/personal/${randomUUID()}/${id}/${newBlobGeneration()}.bin`;
      objects.push({ key, lastModified: OLD });
      if (i < referenced) rows.set(id, encodeObjectRef({ key }));
      else orphanKeys.push(key);
    }
    return { rows, orphanKeys };
  }

  const blobSweep = (mode: typeof BLOB_SWEEP_MODE.REPORT | typeof BLOB_SWEEP_MODE.DELETE = BLOB_SWEEP_MODE.DELETE) => ({
    mode,
    graceMs: 3_600_000,
    maxObjects: 100,
    maxDeletes: 1000,
    maxDeleteRatio: 0.5,
    deploymentId: DEPLOYMENT_ID,
  });

  beforeEach(() => {
    vi.stubEnv("BLOB_OBJECT_PREFIX", PREFIX);
    objects = [];
    marker = DEPLOYMENT_ID;
    deleted = [];
    storeRef.current = fakeStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not run, and records nothing, when the mode is off or absent", async () => {
    const { workerPrisma } = makePrisma();
    seed(1, 1);
    for (const opts of [BASE, { ...BASE, blobSweep: { mode: BLOB_SWEEP_MODE.OFF } }]) {
      const counts = await sweepOnce(workerPrisma, 100, { ...opts, blobCursor: { sawReferenced: false } });
      expect(counts).not.toHaveProperty("attachment_objects");
    }
    expect(deleted).toEqual([]);
  });

  it("does not run on the DB backend", async () => {
    storeRef.current = fakeStore(BLOB_STORAGE.DB);
    const { workerPrisma } = makePrisma();
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, blobSweep: blobSweep(), blobCursor: { sawReferenced: false } });
    expect(counts).not.toHaveProperty("attachment_objects");
  });

  it.each([
    ["marker_missing", () => { marker = null; }, () => seed(1, 1)],
    ["marker_mismatch", () => { marker = "11111111-1111-4111-8111-111111111111"; }, () => seed(1, 1)],
    ["breaker", () => {}, () => seed(0, 2)],
  ])("records -1 for a %s refusal and deletes nothing", async (_label, setMarker, seedRows) => {
    setMarker();
    const { rows } = seedRows();
    const { workerPrisma } = makePrisma({ attachmentRows: rows });
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, blobSweep: blobSweep(), blobCursor: { sawReferenced: false } });
    expect(counts.attachment_objects).toBe(-1);
    expect(deleted).toEqual([]);
  });

  it("records 0 in report mode", async () => {
    const { rows } = seed(2, 2);
    const { workerPrisma } = makePrisma({ attachmentRows: rows });
    const counts = await sweepOnce(workerPrisma, 100, {
      ...BASE,
      blobSweep: blobSweep(BLOB_SWEEP_MODE.REPORT),
      blobCursor: { sawReferenced: false },
    });
    expect(counts.attachment_objects).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("records the deleted count on a completed delete tick, reading rows under its own grant", async () => {
    const { rows, orphanKeys } = seed(3, 2);
    const { workerPrisma, txs } = makePrisma({ attachmentRows: rows });
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, blobSweep: blobSweep(), blobCursor: { sawReferenced: false } });
    expect(counts.attachment_objects).toBe(2);
    expect(deleted).toEqual(orphanKeys);
    const readTxs = txs.filter((t) => t.calls.some((c) => c.name === "$queryRaw" && sqlText(c.args[0]).includes("FROM attachments")));
    expect(readTxs.map((t) => t.gucs.tables)).toEqual([BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP.tables]);
  });

  it("refuses (-1) without the worker's cursor", async () => {
    const { rows } = seed(1, 1);
    const { workerPrisma } = makePrisma({ attachmentRows: rows });
    const counts = await sweepOnce(workerPrisma, 100, { ...BASE, blobSweep: blobSweep() });
    expect(counts.attachment_objects).toBe(-1);
    expect(deleted).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ table: "attachment_objects", code: "RETENTION_GC_BLOB_CURSOR_MISSING" }),
      "retention-gc.entry_failed",
    );
  });

  it("consecutive calls with the same opts object cover a bucket of 3 x maxObjects", async () => {
    const maxObjects = 100;
    const rows = new Map<string, Uint8Array>();
    const orphanKeys: string[] = [];
    // A referenced key at the head of each tick's window; orphans in the
    // last tick's window only, so only a cursor that advanced reaches them.
    for (let tick = 0; tick < 3; tick++) {
      for (let i = 0; i < maxObjects; i++) {
        const id = randomUUID();
        const key = `${PREFIX}/personal/${randomUUID()}/${id}/${newBlobGeneration()}.bin`;
        objects.push({ key, lastModified: OLD });
        if (tick === 2 && i >= 90) orphanKeys.push(key);
        else rows.set(id, encodeObjectRef({ key }));
      }
    }
    const { workerPrisma } = makePrisma({ attachmentRows: rows });
    const blobCursor: BlobCursor = { sawReferenced: false };
    const opts: SweepOpts = { ...BASE, blobSweep: { ...blobSweep(), maxObjects }, blobCursor };
    const results = [];
    for (let tick = 0; tick < 3; tick++) results.push((await sweepOnce(workerPrisma, 100, opts)).attachment_objects);
    expect(results).toEqual([0, 0, 10]);
    expect(deleted).toEqual(orphanKeys);
    // The third tick finished the listing: a new pass starts next.
    expect(blobCursor).toEqual({ value: undefined, sawReferenced: false });
  });
});
