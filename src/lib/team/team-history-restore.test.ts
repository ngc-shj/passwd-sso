import { describe, expect, it, vi } from "vitest";
import { decryptData } from "@/lib/crypto/crypto-client";
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
