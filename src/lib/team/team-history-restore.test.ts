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
import { buildTeamHistoryRestoreBody } from "./team-history-restore";

const ENTRY = "e1";

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

  it("upgrades an aadVersion-0 row: opens its no-AAD blob and re-seals blob and overview at AAD 1 under the row's key, naming the row's blobIv", async () => {
    const teamKey = await makeTeamKey();
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN, title: "Legacy", notes: "", tagNames: [], username: "u", password: "p", url: "",
    });
    const blob = await encryptData(fullBlob, teamKey);
    const row = {
      id: "h0", entryType: ENTRY_TYPE.LOGIN,
      encryptedBlob: blob.ciphertext, blobIv: blob.iv, blobAuthTag: blob.authTag,
      aadVersion: 0, teamKeyVersion: 1, itemKeyVersion: 0,
      encryptedItemKey: null, itemKeyIv: null, itemKeyAuthTag: null, itemKeyId: null,
    };

    const body = await buildTeamHistoryRestoreBody(TEAM_ID, ENTRY, row, async () => teamKey);

    expect(body.snapshotBlobIv).toBe(blob.iv);
    const blobAad = buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.BLOB, 0);
    const overviewAad = buildTeamEntryAAD(TEAM_ID, ENTRY, VAULT_TYPE.OVERVIEW, 0);
    expect(await decryptData(body.encryptedBlob, teamKey, blobAad)).toBe(fullBlob);
    expect(JSON.parse(await decryptData(body.encryptedOverview, teamKey, overviewAad))).toEqual(JSON.parse(overviewBlob));
    // Neither is left without AAD (a strict reader would refuse it).
    await expect(decryptData(body.encryptedBlob, teamKey)).rejects.toThrow();
    await expect(decryptData(body.encryptedOverview, teamKey)).rejects.toThrow();
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
