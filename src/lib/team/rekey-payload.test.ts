import { describe, expect, it, vi } from "vitest";
import {
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
} from "@/lib/crypto/crypto-team";
import { decryptData, encryptData } from "@/lib/crypto/crypto-client";
import { AAD_VERSION, buildItemKeyWrapAAD, buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKey,
  makeTeamKeys,
  sealAttachmentCek,
  sealEntryV0,
  sealEntryV1,
  sealHistoryRow,
  swapBlobAndOverview,
} from "@/__tests__/helpers/team-key-fixtures";
import { base64ToBytes } from "@/lib/team/team-attachment-crypto";

// Real Web Crypto; the spy records each raw key buffer handed out so the
// zeroization cell sees the real bytes.
// `failDeriveAt` makes the n-th deriveItemEncryptionKey call (1-based) throw.
const rawRefs = vi.hoisted(() => ({
  refs: [] as Uint8Array[],
  deriveCalls: 0,
  failDeriveAt: null as number | null,
}));
vi.mock("@/lib/crypto/crypto-team", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/crypto/crypto-team")>();
  const record = <A extends unknown[]>(fn: (...a: A) => Promise<Uint8Array>) =>
    async (...args: A) => {
      const raw = await fn(...args);
      rawRefs.refs.push(raw);
      return raw;
    };
  return {
    ...real,
    unwrapItemKey: record(real.unwrapItemKey),
    unwrapTeamAttachmentCek: record(real.unwrapTeamAttachmentCek),
    deriveItemEncryptionKey: async (raw: Uint8Array) => {
      rawRefs.deriveCalls += 1;
      if (rawRefs.deriveCalls === rawRefs.failDeriveAt) throw new Error("derive failed");
      return real.deriveItemEncryptionKey(raw);
    },
    generateItemKey: () => {
      const raw = real.generateItemKey();
      rawRefs.refs.push(raw);
      return raw;
    },
  };
});

import {
  REKEY_ENTRY_BLOCK,
  RekeyTransientError,
  buildEntryRekeyPayload,
  buildEntryUpgradePayload,
  type RekeyEntryData,
} from "./rekey-payload";

const ENTRY = "e0000000-0000-4000-8000-000000000001";
const CURRENT = 3;

interface Fixture {
  data: RekeyEntryData;
  keys: Map<number, CryptoKey>;
  liveItemKey: Uint8Array;
  liveId: string;
}

async function baseFixture(): Promise<Fixture> {
  const keys = await makeTeamKeys([2, CURRENT]);
  const liveItemKey = generateItemKey();
  const liveId = crypto.randomUUID();
  const entry = await sealEntryV1({
    entryId: ENTRY,
    teamKey: keys.get(2)!,
    teamKeyVersion: 2,
    itemKey: liveItemKey,
    itemKeyVersion: 2,
    itemKeyId: liveId,
    blob: '{"title":"live"}',
    overview: '{"title":"live"}',
  });
  return {
    keys,
    liveItemKey,
    liveId,
    data: {
      entry: { ...entry, itemKeyTeamKeyVersion: 2 },
      history: [],
      attachments: [],
      nextItemKeyVersion: 3,
      teamKeyVersion: CURRENT,
    },
  };
}

async function newContentKey(teamKey: CryptoKey, encryptedItemKey: { ciphertext: string; iv: string; authTag: string }) {
  const raw = await unwrapItemKey(encryptedItemKey, teamKey, buildItemKeyWrapAAD(TEAM_ID, ENTRY, CURRENT));
  return { raw, content: await deriveItemEncryptionKey(raw), cekWrap: await deriveItemCekWrapKey(raw) };
}

function payloadOf(result: Awaited<ReturnType<typeof buildEntryRekeyPayload>>) {
  if (result.kind !== "payload") throw new Error(`expected payload, got ${result.block}`);
  return result;
}

describe("buildEntryRekeyPayload", () => {
  it("wraps a new ItemKey with a fresh IV under the CURRENT team key at nextItemKeyVersion and re-encrypts blob and overview", async () => {
    const f = await baseFixture();

    const { body } = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect(body).toMatchObject({
      teamKeyVersion: CURRENT,
      newItemKeyVersion: 3,
      snapshot: { blobIv: f.data.entry.blobIv, overviewIv: f.data.entry.overviewIv, itemKeyIv: f.data.entry.itemKeyIv, itemKeyVersion: 2 },
    });
    expect(body.encryptedItemKey.iv).not.toBe(f.data.entry.itemKeyIv);
    const next = await newContentKey(f.keys.get(CURRENT)!, body.encryptedItemKey);
    expect(Array.from(next.raw)).not.toEqual(Array.from(f.liveItemKey));
    expect(await decryptData(body.encryptedBlob, next.content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 3))).toBe('{"title":"live"}');
    expect(
      await decryptData(body.encryptedOverview, next.content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.OVERVIEW, 3)),
    ).toBe('{"title":"live"}');
  });

  // Review SS2: a live v1+ entry is always sealed at the entry AAD, so the
  // re-key opens it strictly. A server-reported label other than AAD_VERSION
  // is blocked, never honoured — at 0 it would open an unbound ciphertext
  // under the live ItemKey (e.g. a legacy history row's, D80) as live content.
  it("an honest live entry at aadVersion 1 is re-keyed: label 1, its plaintext unchanged", async () => {
    const f = await baseFixture();
    expect(f.data.entry.aadVersion).toBe(AAD_VERSION);

    const { body } = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));
    const next = await newContentKey(f.keys.get(CURRENT)!, body.encryptedItemKey);

    expect({
      aadVersion: body.aadVersion,
      blob: await decryptData(body.encryptedBlob, next.content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 3)),
      overview: await decryptData(body.encryptedOverview, next.content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.OVERVIEW, 3)),
    }).toEqual({ aadVersion: AAD_VERSION, blob: '{"title":"live"}', overview: '{"title":"live"}' });
  });

  it.each([
    ["0", 0],
    ["2", 2],
    ["2.5", 2.5],
    ['"1" (a string)', "1"],
    ["null", null],
    ["undefined", undefined],
  ])("blocks (does not throw) a live v1+ entry reported at aadVersion %s", async (_label, aadVersion) => {
    const f = await baseFixture();
    f.data.entry = { ...f.data.entry, aadVersion: aadVersion as number };

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 2 });
  });

  it("blocks the laundering shape: live reported at 0 with no-AAD ciphertexts under the live content key", async () => {
    const f = await baseFixture();
    const liveContent = await deriveItemEncryptionKey(f.liveItemKey);
    const blob = await encryptData('{"title":"substituted"}', liveContent);
    const overview = await encryptData('{"title":"substituted"}', liveContent);
    f.data.entry = {
      ...f.data.entry,
      aadVersion: 0,
      encryptedBlob: blob.ciphertext,
      blobIv: blob.iv,
      blobAuthTag: blob.authTag,
      encryptedOverview: overview.ciphertext,
      overviewIv: overview.iv,
      overviewAuthTag: overview.authTag,
    };

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 2 });
  });

  it("control for the laundering cell: the same no-AAD ciphertexts labelled 1 do not open strictly either", async () => {
    const f = await baseFixture();
    const liveContent = await deriveItemEncryptionKey(f.liveItemKey);
    const blob = await encryptData('{"title":"substituted"}', liveContent);
    f.data.entry = { ...f.data.entry, encryptedBlob: blob.ciphertext, blobIv: blob.iv, blobAuthTag: blob.authTag };

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 2 });
  });

  it("re-keys history rows by their own wrap and by trial with the live ItemKey, and retains the rest", async () => {
    const f = await baseFixture();
    const onlyOtherHolderKey = await makeTeamKey(); // version 1: only another member holds it
    const ownWrapKey = generateItemKey();
    const unknownKey = generateItemKey();
    const ownId = crypto.randomUUID();
    f.data.history = [
      // Opens with its own wrap (team key v2 is held).
      await sealHistoryRow({ id: "h-own", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: ownWrapKey, itemKeyVersion: 1, itemKeyId: ownId, blob: "own" }),
      // Its wrap is under v1 (not held), but the blob is under the live ItemKey: trial.
      {
        ...(await sealHistoryRow({ id: "h-trial", entryId: ENTRY, teamKey: onlyOtherHolderKey, teamKeyVersion: 1, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: null, blob: "trial" })),
      },
      // A version only another member holds, under a key nobody here holds.
      await sealHistoryRow({ id: "h-other", entryId: ENTRY, teamKey: onlyOtherHolderKey, teamKeyVersion: 1, itemKey: unknownKey, itemKeyVersion: 1, itemKeyId: null, blob: "other" }),
      // Its own wrap opens, but the blob is corrupt.
      {
        ...(await sealHistoryRow({ id: "h-corrupt", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: ownWrapKey, itemKeyVersion: 1, itemKeyId: ownId, blob: "corrupt" })),
        blobAuthTag: "0".repeat(32),
      },
      // A legacy row under a different v1 ItemKey wrapped under the live version, which nobody can unwrap.
      {
        ...(await sealHistoryRow({ id: "h-legacy", entryId: ENTRY, teamKey: await makeTeamKey(), teamKeyVersion: 2, itemKey: unknownKey, itemKeyVersion: 1, itemKeyId: null, blob: "legacy" })),
      },
    ];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect(result.body.history.map((h) => h.id)).toEqual(["h-own", "h-trial"]);
    expect(result.body.retainHistoryIds).toEqual(["h-other", "h-corrupt", "h-legacy"]);
    expect(result.retained).toEqual([
      { id: "h-other", teamKeyVersion: 1 },
      { id: "h-corrupt", teamKeyVersion: 2 },
      { id: "h-legacy", teamKeyVersion: 2 },
    ]);
    const next = await newContentKey(f.keys.get(CURRENT)!, result.body.encryptedItemKey);
    const aad = buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 3);
    expect(await decryptData(result.body.history[0].encryptedBlob, next.content, aad)).toBe("own");
    expect(await decryptData(result.body.history[1].encryptedBlob, next.content, aad)).toBe("trial");
    expect(result.body.history[0].snapshotBlobIv).toBe(f.data.history[0].blobIv);
  });

  it("re-keys a v0 history row with the team key at its own version", async () => {
    const f = await baseFixture();
    f.data.history = [
      await sealHistoryRow({ id: "h-v0", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: null, itemKeyVersion: 0, itemKeyId: null, blob: "v0" }),
    ];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect(result.body.history.map((h) => h.id)).toEqual(["h-v0"]);
  });

  // S-R5-2 (D80): a legacy row (one the history restore refuses) is re-keyed
  // under the new ItemKey still WITHOUT AAD and labelled 0, so departed holders
  // of the old ItemKey lose it while it stays unrestorable. The row below is a
  // no-AAD ciphertext under the live ItemKey.
  it.each([
    ["0", 0],
    ["undefined", undefined],
    ["null", null],
    ['"1" (a string)', "1"],
  ])("re-keys a history row labelled aadVersion %s without AAD at label 0", async (_label, aadVersion) => {
    const f = await baseFixture();
    const sealed = await sealHistoryRow({ id: "h-legacy", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: f.liveId, blob: "x" });
    const noAad = await encryptData("legacy", await deriveItemEncryptionKey(f.liveItemKey));
    f.data.history = [{
      ...sealed,
      encryptedBlob: noAad.ciphertext,
      blobIv: noAad.iv,
      blobAuthTag: noAad.authTag,
      aadVersion: aadVersion as number,
    }];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));
    const next = await newContentKey(f.keys.get(CURRENT)!, result.body.encryptedItemKey);
    const [row] = result.body.history;

    expect({
      ids: result.body.history.map((h) => ({ id: h.id, aadVersion: h.aadVersion })),
      retained: result.body.retainHistoryIds,
      openedWithoutAad: await decryptData(row.encryptedBlob, next.content),
    }).toEqual({ ids: [{ id: "h-legacy", aadVersion: 0 }], retained: [], openedWithoutAad: "legacy" });
  });

  it("re-keys a legacy v0 history row (no AAD, under the team key) without AAD at label 0", async () => {
    const f = await baseFixture();
    const noAad = await encryptData("legacy-v0", f.keys.get(2)!);
    f.data.history = [{
      id: "h-legacy-v0",
      encryptedBlob: noAad.ciphertext,
      blobIv: noAad.iv,
      blobAuthTag: noAad.authTag,
      aadVersion: 0,
      teamKeyVersion: 2,
      itemKeyVersion: 0,
      encryptedItemKey: null,
      itemKeyIv: null,
      itemKeyAuthTag: null,
      itemKeyId: null,
    }];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));
    const next = await newContentKey(f.keys.get(CURRENT)!, result.body.encryptedItemKey);

    expect({
      ids: result.body.history.map((h) => ({ id: h.id, aadVersion: h.aadVersion })),
      openedWithoutAad: await decryptData(result.body.history[0].encryptedBlob, next.content),
    }).toEqual({ ids: [{ id: "h-legacy-v0", aadVersion: 0 }], openedWithoutAad: "legacy-v0" });
  });

  // F-R6-2: the legacy v0 row resolves the team key at its own version, so a
  // transient failure there stops the pass (as for any row) rather than
  // retaining it under the old key by timing.
  it.each([
    { reason: "transient", outcome: "throws RekeyTransientError" },
    { reason: "not_available", outcome: "retains the row" },
  ] as const)("legacy v0 history row whose team key version is $reason → $outcome", async ({ reason }) => {
    const f = await baseFixture();
    const noAad = await encryptData("legacy-v0", f.keys.get(2)!);
    f.data.history = [{
      id: "h-legacy-v0",
      encryptedBlob: noAad.ciphertext,
      blobIv: noAad.iv,
      blobAuthTag: noAad.authTag,
      aadVersion: 0,
      teamKeyVersion: 1,
      itemKeyVersion: 0,
      encryptedItemKey: null,
      itemKeyIv: null,
      itemKeyAuthTag: null,
      itemKeyId: null,
    }];

    const built = buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys, { 1: reason }));
    if (reason === "transient") {
      await expect(built).rejects.toBeInstanceOf(RekeyTransientError);
      return;
    }
    const result = payloadOf(await built);
    expect({ history: result.body.history, retained: result.body.retainHistoryIds }).toEqual({ history: [], retained: ["h-legacy-v0"] });
  });

  // T18: an AAD-bound ciphertext labelled 0 is still treated as legacy — opened
  // without AAD, which fails, so it is retained — never opened strictly and
  // upgraded to label 1.
  it("retains (not upgrades) an AAD-bound ciphertext labelled aadVersion 0", async () => {
    const f = await baseFixture();
    const bound = await sealHistoryRow({ id: "h-bound-0", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: f.liveId, blob: "bound" });
    f.data.history = [{ ...bound, aadVersion: 0 }];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect({ history: result.body.history, retained: result.body.retainHistoryIds }).toEqual({ history: [], retained: ["h-bound-0"] });
  });

  it("control: the same row at aadVersion 1, sealed at entry AAD, is re-keyed at strict AAD and label 1", async () => {
    const f = await baseFixture();
    f.data.history = [
      await sealHistoryRow({ id: "h-bound", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: f.liveId, blob: "bound" }),
    ];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));
    const next = await newContentKey(f.keys.get(CURRENT)!, result.body.encryptedItemKey);

    expect({
      ids: result.body.history.map((h) => ({ id: h.id, aadVersion: h.aadVersion })),
      openedStrict: await decryptData(result.body.history[0].encryptedBlob, next.content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 3)),
    }).toEqual({ ids: [{ id: "h-bound", aadVersion: AAD_VERSION }], openedStrict: "bound" });
  });

  it("retains (not re-keys) a no-AAD ciphertext labelled aadVersion 1: history rows open at strict AAD", async () => {
    const f = await baseFixture();
    const sealed = await sealHistoryRow({ id: "h-mislabelled", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: f.liveId, blob: "x" });
    const noAad = await encryptData("legacy", await deriveItemEncryptionKey(f.liveItemKey));
    f.data.history = [{ ...sealed, encryptedBlob: noAad.ciphertext, blobIv: noAad.iv, blobAuthTag: noAad.authTag }];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect(result.body.retainHistoryIds).toEqual(["h-mislabelled"]);
  });

  it("retains history rows at a key_invalid version and still re-keys the entry", async () => {
    const f = await baseFixture();
    const keys = new Map(f.keys);
    const v1Key = await makeTeamKey();
    keys.set(1, v1Key);
    f.data.history = [
      await sealHistoryRow({ id: "h-v1", entryId: ENTRY, teamKey: v1Key, teamKeyVersion: 1, itemKey: generateItemKey(), itemKeyVersion: 1, itemKeyId: null, blob: "x" }),
    ];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(keys, { 1: "key_invalid" })));

    expect(result.body.retainHistoryIds).toEqual(["h-v1"]);
  });

  it("re-wraps each mode-2 CEK under the new ItemKey: by matching id, and by trial", async () => {
    const f = await baseFixture();
    const cekA = crypto.getRandomValues(new Uint8Array(32));
    const cekB = crypto.getRandomValues(new Uint8Array(32));
    const historyKey = generateItemKey();
    const historyId = crypto.randomUUID();
    f.data.history = [
      await sealHistoryRow({ id: "h1", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: historyKey, itemKeyVersion: 1, itemKeyId: historyId, blob: "h" }),
    ];
    f.data.attachments = [
      await sealAttachmentCek({ id: "a-match", entryId: ENTRY, itemKey: historyKey, itemKeyVersion: 1, itemKeyId: historyId, cek: cekA.slice() }),
      // Legacy id-less CEK under the live ItemKey: found by trial.
      await sealAttachmentCek({ id: "a-trial", entryId: ENTRY, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: null, cek: cekB.slice() }),
    ];

    const { body } = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    const next = await newContentKey(f.keys.get(CURRENT)!, body.encryptedItemKey);
    expect(body.attachmentCekRewraps.map((a) => [a.id, a.snapshotCekIv])).toEqual([
      ["a-match", f.data.attachments[0].cekIv],
      ["a-trial", f.data.attachments[1].cekIv],
    ]);
    for (const [i, cek] of [cekA, cekB].entries()) {
      const rewrap = body.attachmentCekRewraps[i];
      const opened = await unwrapTeamAttachmentCek(
        { ciphertext: base64ToBytes(rewrap.cekEncrypted), iv: rewrap.cekIv, authTag: rewrap.cekAuthTag },
        next.cekWrap,
        { teamId: TEAM_ID, entryId: ENTRY, attachmentId: rewrap.id, itemKeyVersion: 3, cekWrapAadVersion: 1 },
      );
      expect(Array.from(opened)).toEqual(Array.from(cek));
    }
  });

  it("blocks (skip and report) when an attachment CEK opens with no held ItemKey", async () => {
    const f = await baseFixture();
    f.data.attachments = [
      await sealAttachmentCek({ id: "a", entryId: ENTRY, itemKey: generateItemKey(), itemKeyVersion: 1, itemKeyId: null, cek: new Uint8Array(32) }),
    ];

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.ATTACHMENT_UNOPENABLE, teamKeyVersion: 2 });
  });

  it("blocks key_invalid when the actor's key row at the live entry's version fails to unwrap", async () => {
    const f = await baseFixture();

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys, { 2: "key_invalid" }));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.KEY_INVALID, teamKeyVersion: 2 });
  });

  it("blocks undecryptable when the live blob fails authentication under the held key", async () => {
    const f = await baseFixture();
    f.data.entry = { ...f.data.entry, blobAuthTag: "0".repeat(32) };

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 2 });
  });

  // T8: the live entry opens each field at its own vaultType and ItemKey version.
  it.each([
    ["blob and overview swapped", (f: Fixture) => Promise.resolve(swapBlobAndOverview(f.data.entry))],
    ["sealed at a wrong ItemKey version", async (f: Fixture) => ({
      ...(await sealEntryV1({
        entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey, itemKeyVersion: 2,
        itemKeyId: f.liveId, blob: '{"title":"live"}', overview: '{"title":"live"}', aadItemKeyVersion: 1,
      })),
      itemKeyTeamKeyVersion: 2,
    })],
  ])("blocks undecryptable when the live entry's fields are %s", async (_name, mutate) => {
    const f = await baseFixture();
    f.data.entry = await mutate(f);

    const result = await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 2 });
  });

  // T8: a restorable history row opens at its own vaultType and ItemKey version.
  it.each([
    ["sealed at the overview vaultType", { aadVaultType: "overview" as const }],
    ["sealed at a wrong ItemKey version", { aadItemKeyVersion: 1 }],
  ])("retains a history row %s", async (_name, change) => {
    const f = await baseFixture();
    f.data.history = [
      await sealHistoryRow({
        id: "h-wrong", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: f.liveItemKey,
        itemKeyVersion: 2, itemKeyId: f.liveId, blob: "x", ...change,
      }),
    ];

    const result = payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    expect({ history: result.body.history, retained: result.body.retainHistoryIds }).toEqual({ history: [], retained: ["h-wrong"] });
  });

  it("throws RekeyTransientError on a transient key failure (no payload)", async () => {
    const f = await baseFixture();

    await expect(
      buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys, { 2: "transient" })),
    ).rejects.toBeInstanceOf(RekeyTransientError);
  });

  it("asks for an upgrade or a migration first", async () => {
    const f = await baseFixture();
    const v0 = await sealEntryV0({ entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, blob: "b", overview: "o" });

    expect(
      await buildEntryRekeyPayload(TEAM_ID, { ...f.data, entry: v0 }, makeResolver(f.keys)),
    ).toMatchObject({ kind: "blocked", block: REKEY_ENTRY_BLOCK.NEEDS_UPGRADE });
    expect(
      await buildEntryRekeyPayload(
        TEAM_ID,
        { ...f.data, attachments: [{ ...(await sealAttachmentCek({ id: "a", entryId: ENTRY, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: null, cek: new Uint8Array(32) })), encryptionMode: 1 }] },
        makeResolver(f.keys),
      ),
    ).toMatchObject({ kind: "blocked", block: REKEY_ENTRY_BLOCK.NEEDS_MIGRATION });
  });

  it("zeroes every raw ItemKey and CEK buffer it handled", async () => {
    const f = await baseFixture();
    f.data.attachments = [
      await sealAttachmentCek({ id: "a", entryId: ENTRY, itemKey: f.liveItemKey, itemKeyVersion: 2, itemKeyId: f.liveId, cek: crypto.getRandomValues(new Uint8Array(32)) }),
    ];
    rawRefs.refs.length = 0;

    payloadOf(await buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys)));

    // live ItemKey unwrap, new ItemKey, the CEK unwrap
    expect(rawRefs.refs.length).toBe(3);
    for (const raw of rawRefs.refs) expect(raw.every((b) => b === 0)).toBe(true);
  });

  it.each([
    ["the live ItemKey", 1],
    ["a history row's own ItemKey", 2],
  ])("zeroes %s when deriving from it throws", async (_label, failAt) => {
    const f = await baseFixture();
    f.data.history = [
      await sealHistoryRow({ id: "h-own", entryId: ENTRY, teamKey: f.keys.get(2)!, teamKeyVersion: 2, itemKey: generateItemKey(), itemKeyVersion: 1, itemKeyId: crypto.randomUUID(), blob: "own" }),
    ];
    rawRefs.refs.length = 0;
    rawRefs.deriveCalls = 0;
    rawRefs.failDeriveAt = failAt;
    try {
      await expect(buildEntryRekeyPayload(TEAM_ID, f.data, makeResolver(f.keys))).rejects.toThrow("derive failed");
    } finally {
      rawRefs.failDeriveAt = null;
    }

    // new ItemKey, the live unwrap, and (when reached) the history unwrap
    expect(rawRefs.refs.length).toBe(failAt + 1);
    for (const raw of rawRefs.refs) expect(raw.every((b) => b === 0)).toBe(true);
  });
});

describe("buildEntryUpgradePayload", () => {
  it("re-encrypts a v0 entry under a new ItemKey at nextItemKeyVersion wrapped under the current key, naming the blob it replaces", async () => {
    const keys = await makeTeamKeys([1, CURRENT]);
    const v0 = await sealEntryV0({ entryId: ENTRY, teamKey: keys.get(1)!, teamKeyVersion: 1, blob: "B", overview: "O" });

    const result = await buildEntryUpgradePayload(TEAM_ID, v0, 5, CURRENT, makeResolver(keys));

    if (result.kind !== "payload") throw new Error("expected payload");
    expect(result.body).toMatchObject({ teamKeyVersion: CURRENT, itemKeyVersion: 5, snapshotBlobIv: v0.blobIv });
    const raw = await unwrapItemKey(result.body.encryptedItemKey, keys.get(CURRENT)!, buildItemKeyWrapAAD(TEAM_ID, ENTRY, CURRENT));
    const content = await deriveItemEncryptionKey(raw);
    expect(await decryptData(result.body.encryptedBlob, content, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 5))).toBe("B");
  });

  // T8: the upgrade opens each v0 field at its own vaultType and ItemKey version 0.
  it.each([
    ["blob and overview swapped", async (key: CryptoKey) =>
      swapBlobAndOverview(await sealEntryV0({ entryId: ENTRY, teamKey: key, teamKeyVersion: 1, blob: "B", overview: "O" }))],
    ["sealed at a wrong ItemKey version", async (key: CryptoKey) =>
      sealEntryV0({ entryId: ENTRY, teamKey: key, teamKeyVersion: 1, blob: "B", overview: "O", aadItemKeyVersion: 1 })],
  ])("blocks undecryptable when the v0 entry's fields are %s", async (_name, seal) => {
    const keys = await makeTeamKeys([1, CURRENT]);
    const v0 = await seal(keys.get(1)!);

    const result = await buildEntryUpgradePayload(TEAM_ID, v0, 5, CURRENT, makeResolver(keys));

    expect(result).toEqual({ kind: "blocked", block: REKEY_ENTRY_BLOCK.UNDECRYPTABLE, teamKeyVersion: 1 });
  });
});
