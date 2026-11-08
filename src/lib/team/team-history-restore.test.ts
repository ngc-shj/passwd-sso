import { describe, expect, it, vi } from "vitest";
import { decryptData, encryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { deriveItemEncryptionKey } from "@/lib/crypto/crypto-team";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeTeamKey,
  sealHistoryRow,
} from "@/__tests__/helpers/team-key-fixtures";
import { buildTeamEntryPayload } from "@/lib/team/team-entry-payload";
import { buildTeamHistoryRestoreBody, HistoryRowLegacyError } from "./team-history-restore";
import type { EncryptedData } from "@/lib/crypto/crypto-client";

const ENTRY = "e1";

/** An itemKeyVersion-0 row (TeamKey-sealed) carrying `blob` under the given aadVersion label. */
function legacyRow(blob: EncryptedData, aadVersion: unknown) {
  return {
    id: "h0", entryType: ENTRY_TYPE.LOGIN,
    encryptedBlob: blob.ciphertext, blobIv: blob.iv, blobAuthTag: blob.authTag,
    aadVersion: aadVersion as number, teamKeyVersion: 1, itemKeyVersion: 0,
    encryptedItemKey: null, itemKeyIv: null, itemKeyAuthTag: null, itemKeyId: null,
  };
}

describe("buildTeamHistoryRestoreBody", () => {
  it("rebuilds the overview from the row's blob as the save path does and seals it under the row's key at the row's ItemKey version", async () => {
    const itemKey = generateItemKey();
    const input = {
      entryType: ENTRY_TYPE.LOGIN,
      title: "Old title",
      notes: "",
      tagNames: [{ name: "t", color: null }],
      username: "alice",
      password: "pw",
      url: "https://www.example.com/login",
    };
    const { fullBlob, overviewBlob } = buildTeamEntryPayload(input);
    const row = await sealHistoryRow({
      id: "h1", entryId: ENTRY, teamKey: await makeTeamKey(), teamKeyVersion: 2,
      itemKey, itemKeyVersion: 3, itemKeyId: "row-ik", blob: fullBlob,
    });
    const rowKey = await deriveItemEncryptionKey(itemKey);
    const getEntryDecryptionKey = vi.fn(async () => rowKey);

    const body = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, { ...row, entryType: ENTRY_TYPE.LOGIN }, getEntryDecryptionKey);

    expect(getEntryDecryptionKey).toHaveBeenCalledWith(TEAM_ID, ENTRY, expect.objectContaining({ itemKeyId: "row-ik", itemKeyVersion: 3, teamKeyVersion: 2 }));
    const overview = await decryptData(body.encryptedOverview, rowKey, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.OVERVIEW, 3));
    expect(JSON.parse(overview)).toEqual(JSON.parse(overviewBlob));
    // The blob is re-sealed too (fresh IV), at the row's ItemKey version.
    expect(body.encryptedBlob.iv).not.toBe(row.blobIv);
    expect(await decryptData(body.encryptedBlob, rowKey, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 3))).toBe(fullBlob);
  });

  // T8: the row opens at the blob vaultType and its own ItemKey version.
  it.each([
    ["sealed at the overview vaultType", { aadVaultType: "overview" as const }],
    ["sealed at another ItemKey version", { aadItemKeyVersion: 2 }],
  ])("refuses a row %s", async (_name, change) => {
    const itemKey = generateItemKey();
    const row = await sealHistoryRow({
      id: "h1", entryId: ENTRY, teamKey: await makeTeamKey(), teamKeyVersion: 2,
      itemKey, itemKeyVersion: 3, itemKeyId: "row-ik", blob: '{"title":"t"}', ...change,
    });
    const rowKey = await deriveItemEncryptionKey(itemKey);

    await expect(
      buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, { ...row, entryType: ENTRY_TYPE.LOGIN }, vi.fn(async () => rowKey)),
    ).rejects.toThrow();
  });

  it("control: the same row sealed at blob / its own ItemKey version is restored", async () => {
    const itemKey = generateItemKey();
    const row = await sealHistoryRow({
      id: "h1", entryId: ENTRY, teamKey: await makeTeamKey(), teamKeyVersion: 2,
      itemKey, itemKeyVersion: 3, itemKeyId: "row-ik", blob: '{"title":"t"}',
    });
    const rowKey = await deriveItemEncryptionKey(itemKey);

    const body = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, { ...row, entryType: ENTRY_TYPE.LOGIN }, vi.fn(async () => rowKey));

    expect(body.snapshotBlobIv).toBe(row.blobIv);
  });

  it("refuses an aadVersion-0 row before obtaining a key or decrypting (S-R3-2)", async () => {
    const teamKey = await makeTeamKey();
    const { fullBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN, title: "Legacy", notes: "", tagNames: [], username: "u", password: "p", url: "",
    });
    const blob = await encryptData(fullBlob, teamKey);
    const getEntryDecryptionKey = vi.fn(async () => teamKey);

    await expect(
      buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, legacyRow(blob, 0), getEntryDecryptionKey),
    ).rejects.toBeInstanceOf(HistoryRowLegacyError);
    expect(getEntryDecryptionKey).not.toHaveBeenCalled();
  });

  // T14: a malformed label (a malicious or broken server) is refused like 0.
  // The blob is sealed at entry AAD, so without the refusal each would restore.
  describe("a malformed aadVersion label", () => {
    async function aadBoundBlob(teamKey: CryptoKey) {
      const { fullBlob } = buildTeamEntryPayload({
        entryType: ENTRY_TYPE.LOGIN, title: "Bound", notes: "", tagNames: [], username: "u", password: "p", url: "",
      });
      return encryptData(fullBlob, teamKey, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 0));
    }

    it.each([
      ["undefined", undefined],
      ["null", null],
      ['"1" (a string)', "1"],
    ])("aadVersion %s → HistoryRowLegacyError with no key lookup", async (_label, aadVersion) => {
      const teamKey = await makeTeamKey();
      const getEntryDecryptionKey = vi.fn(async () => teamKey);

      await expect(
        buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, legacyRow(await aadBoundBlob(teamKey), aadVersion), getEntryDecryptionKey),
      ).rejects.toBeInstanceOf(HistoryRowLegacyError);
      expect(getEntryDecryptionKey).not.toHaveBeenCalled();
    });

    it("control: numeric aadVersion 1 on the same row restores", async () => {
      const teamKey = await makeTeamKey();
      const getEntryDecryptionKey = vi.fn(async () => teamKey);

      const body = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, legacyRow(await aadBoundBlob(teamKey), 1), getEntryDecryptionKey);

      expect(getEntryDecryptionKey).toHaveBeenCalledTimes(1);
      expect(body.encryptedBlob.ciphertext).not.toBe("");
    });
  });

  it("opens the row at strict AAD: a no-AAD ciphertext relabelled aadVersion 1 is not re-sealed", async () => {
    const teamKey = await makeTeamKey();
    const { fullBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN, title: "Substituted", notes: "", tagNames: [], username: "u", password: "p", url: "",
    });
    const blob = await encryptData(fullBlob, teamKey);

    await expect(
      buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, legacyRow(blob, 1), async () => teamKey),
    ).rejects.toThrow();
  });

  it("control: the same content sealed at AAD 1 on an itemKeyVersion-0 row restores", async () => {
    const teamKey = await makeTeamKey();
    const { fullBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN, title: "Current", notes: "", tagNames: [], username: "u", password: "p", url: "",
    });
    const blob = await encryptData(fullBlob, teamKey, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 0));

    const body = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, legacyRow(blob, 1), async () => teamKey);

    expect(body.snapshotBlobIv).toBe(blob.iv);
    expect(await decryptData(body.encryptedBlob, teamKey, buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 0))).toBe(fullBlob);
  });

  it("does not echo plaintext when the blob is not JSON", async () => {
    const itemKey = generateItemKey();
    const row = await sealHistoryRow({
      id: "h1", entryId: ENTRY, teamKey: await makeTeamKey(), teamKeyVersion: 2,
      itemKey, itemKeyVersion: 1, itemKeyId: null, blob: "password=S3cr3t-not-json",
    });
    const rowKey = await deriveItemEncryptionKey(itemKey);

    const error = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, { ...row, entryType: ENTRY_TYPE.LOGIN }, async () => rowKey).catch((e: unknown) => e);

    expect(String((error as Error).message)).not.toContain("S3cr3t");
  });
});
