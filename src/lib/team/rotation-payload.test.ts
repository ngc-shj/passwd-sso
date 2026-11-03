import { describe, expect, it, vi } from "vitest";
import { decryptTeamEntry, unwrapItemKey } from "@/lib/crypto/crypto-team";
import { buildItemKeyWrapAAD, buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { ROTATE_CARRY_REASON } from "@/lib/constants/team/rotate-key";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKey,
  makeTeamKeys,
  sealEntryV0,
  sealEntryV1,
} from "@/__tests__/helpers/team-key-fixtures";

// Real Web Crypto throughout; the spy only records the raw ItemKey buffers
// unwrapItemKey hands out, so the zeroization check sees the real bytes.
const unwrapped = vi.hoisted(() => ({ refs: [] as Uint8Array[] }));
vi.mock("@/lib/crypto/crypto-team", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/crypto/crypto-team")>();
  return {
    ...real,
    unwrapItemKey: async (...args: Parameters<typeof real.unwrapItemKey>) => {
      const raw = await real.unwrapItemKey(...args);
      unwrapped.refs.push(raw);
      return raw;
    },
  };
});

import {
  RotationAbortedError,
  buildRotationEntryPayload,
  buildRotationPayload,
  type RotateEntryV0,
  type RotateEntryV1,
  type RotationContext,
} from "./rotation-payload";

const NEW_VERSION = 4;

async function context(held: number[]): Promise<RotationContext & { newKey: CryptoKey }> {
  const newKey = await makeTeamKey();
  return {
    teamId: TEAM_ID,
    newTeamKeyVersion: NEW_VERSION,
    newTeamEncryptionKey: newKey,
    heldVersions: new Set(held),
    newKey,
  };
}

async function v1Entry(entryId: string, teamKey: CryptoKey, teamKeyVersion: number) {
  const itemKey = generateItemKey();
  const entry = await sealEntryV1({
    entryId,
    teamKey,
    teamKeyVersion,
    itemKey,
    itemKeyVersion: 1,
    itemKeyId: crypto.randomUUID(),
    blob: '{"title":"t"}',
    overview: '{"title":"t"}',
  });
  return { entry, itemKey };
}

describe("buildRotationEntryPayload", () => {
  it("re-wraps an authentic v1 entry's ItemKey under the new team key instead of carrying it", async () => {
    const keys = await makeTeamKeys([3]);
    const ctx = await context([3]);
    const { entry, itemKey } = await v1Entry("e1", keys.get(3)!, 3);

    const result = await buildRotationEntryPayload(entry, makeResolver(keys), ctx);

    expect(result.kind).toBe("rotate");
    const rotated = (result as { entry: RotateEntryV1 }).entry;
    expect(rotated.snapshotIv).toBe(entry.itemKeyIv);
    expect(rotated.encryptedItemKey.iv).not.toBe(entry.itemKeyIv);
    const reopened = await unwrapItemKey(
      rotated.encryptedItemKey,
      ctx.newKey,
      buildItemKeyWrapAAD(TEAM_ID, "e1", NEW_VERSION),
    );
    expect(Array.from(reopened)).toEqual(Array.from(itemKey));
  });

  it("opens each entry with the key at its OWN team key version, not the latest", async () => {
    const keys = await makeTeamKeys([2, 3]);
    const ctx = await context([2, 3]);
    const { entry } = await v1Entry("old", keys.get(2)!, 2);
    const resolve = makeResolver(keys);

    const result = await buildRotationEntryPayload(entry, resolve, ctx);

    expect(result.kind).toBe("rotate");
    expect(resolve.calls).toEqual([2]);
  });

  it("normalises team key version 0 to 1", async () => {
    const keys = await makeTeamKeys([1]);
    const ctx = await context([1]);
    const { entry } = await v1Entry("legacy", keys.get(1)!, 0);
    const resolve = makeResolver(keys);

    const result = await buildRotationEntryPayload(entry, resolve, ctx);

    expect(result.kind).toBe("rotate");
    expect(resolve.calls).toEqual([1]);
  });

  it("re-encrypts a v0 entry's blob and overview and snapshots both IVs", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const entry = await sealEntryV0({ entryId: "v0", teamKey: keys.get(2)!, teamKeyVersion: 2, blob: "B", overview: "O" });

    const result = await buildRotationEntryPayload(entry, makeResolver(keys), ctx);

    const rotated = (result as { entry: RotateEntryV0 }).entry;
    expect(rotated).toMatchObject({ itemKeyVersion: 0, snapshotIv: entry.blobIv, snapshotOverviewIv: entry.overviewIv });
    expect(await decryptTeamEntry(rotated.encryptedBlob, ctx.newKey, buildTeamEntryAAD(TEAM_ID, "v0", VAULT_TYPE.BLOB, 0))).toBe("B");
    expect(
      await decryptTeamEntry(rotated.encryptedOverview, ctx.newKey, buildTeamEntryAAD(TEAM_ID, "v0", VAULT_TYPE.OVERVIEW, 0)),
    ).toBe("O");
  });

  it("carries not_held without resolving any key when the actor holds no key at the entry's version", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([3]);
    const { entry } = await v1Entry("e", keys.get(2)!, 2);
    const resolve = makeResolver(keys);

    const result = await buildRotationEntryPayload(entry, resolve, ctx);

    expect(result).toEqual({ kind: "carry", carry: { id: "e", teamKeyVersion: 2, reason: ROTATE_CARRY_REASON.NOT_HELD } });
    expect(resolve.calls).toEqual([]);
  });

  it("carries key_invalid when the actor's key row at the version fails to unwrap", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const { entry } = await v1Entry("e", keys.get(2)!, 2);

    const result = await buildRotationEntryPayload(entry, makeResolver(keys, { 2: "key_invalid" }), ctx);

    expect(result).toEqual({ kind: "carry", carry: { id: "e", teamKeyVersion: 2, reason: ROTATE_CARRY_REASON.KEY_INVALID } });
  });

  it("carries undecryptable only for an AES-GCM failure under a held key, leaving the ciphertext byte-identical", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    // Planted: wrapped under a key nobody holds.
    const { entry } = await v1Entry("planted", await makeTeamKey(), 2);
    const before = JSON.stringify(entry);

    const result = await buildRotationEntryPayload(entry, makeResolver(keys), ctx);

    expect(result).toEqual({
      kind: "carry",
      carry: { id: "planted", teamKeyVersion: 2, reason: ROTATE_CARRY_REASON.UNDECRYPTABLE },
    });
    expect(JSON.stringify(entry)).toBe(before);
  });

  it("does not call a malformed wrap undecryptable: a non-authentication failure aborts", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const { entry } = await v1Entry("bad", keys.get(2)!, 2);

    await expect(
      buildRotationEntryPayload({ ...entry, itemKeyIv: null }, makeResolver(keys), ctx),
    ).rejects.toThrow();
  });

  it("aborts on a transient key failure", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const { entry } = await v1Entry("e", keys.get(2)!, 2);

    await expect(
      buildRotationEntryPayload(entry, makeResolver(keys, { 2: "transient" }), ctx),
    ).rejects.toBeInstanceOf(RotationAbortedError);
  });

  it("zeroes every raw ItemKey it unwrapped", async () => {
    unwrapped.refs.length = 0;
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const { entry } = await v1Entry("e", keys.get(2)!, 2);

    await buildRotationEntryPayload(entry, makeResolver(keys), ctx);

    expect(unwrapped.refs).toHaveLength(1);
    expect(unwrapped.refs[0].every((b) => b === 0)).toBe(true);
  });
});

describe("buildRotationPayload", () => {
  it("re-wraps the authentic entry and carries the planted one at the same version", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const authentic = (await v1Entry("authentic", keys.get(2)!, 2)).entry;
    const planted = (await v1Entry("planted", await makeTeamKey(), 2)).entry;

    const payload = await buildRotationPayload([authentic, planted], makeResolver(keys), ctx);

    expect(payload.entries.map((e) => e.id)).toEqual(["authentic"]);
    expect(payload.carry).toEqual([{ id: "planted", teamKeyVersion: 2, reason: ROTATE_CARRY_REASON.UNDECRYPTABLE }]);
  });

  it("carries the key_invalid version's entries and re-wraps the rest", async () => {
    const keys = await makeTeamKeys([2, 3]);
    const ctx = await context([2, 3]);
    const atBroken = (await v1Entry("broken", keys.get(2)!, 2)).entry;
    const atGood = (await v1Entry("good", keys.get(3)!, 3)).entry;

    const payload = await buildRotationPayload([atBroken, atGood], makeResolver(keys, { 2: "key_invalid" }), ctx);

    expect(payload.entries.map((e) => e.id)).toEqual(["good"]);
    expect(payload.carry.map((c) => [c.id, c.reason])).toEqual([["broken", ROTATE_CARRY_REASON.KEY_INVALID]]);
  });

  it("resolves each team key version once", async () => {
    const keys = await makeTeamKeys([2]);
    const ctx = await context([2]);
    const a = (await v1Entry("a", keys.get(2)!, 2)).entry;
    const b = (await v1Entry("b", keys.get(2)!, 2)).entry;
    const resolve = makeResolver(keys);

    await buildRotationPayload([a, b], resolve, ctx);

    expect(resolve.calls).toEqual([2]);
  });

  it("throws on a transient failure before returning any payload", async () => {
    const keys = await makeTeamKeys([2, 3]);
    const ctx = await context([2, 3]);
    const a = (await v1Entry("a", keys.get(3)!, 3)).entry;
    const b = (await v1Entry("b", keys.get(2)!, 2)).entry;

    await expect(
      buildRotationPayload([a, b], makeResolver(keys, { 2: "transient" }), ctx),
    ).rejects.toBeInstanceOf(RotationAbortedError);
  });
});
