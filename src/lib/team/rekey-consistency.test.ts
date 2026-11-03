import { describe, it, expect, vi } from "vitest";
import { assertEntryRekeyConsistent, REKEY_INCONSISTENCY, type RekeyInconsistency } from "./rekey-consistency";

// Branch table over fake rows; the same check is red-proved on real rows in
// src/__tests__/db-integration/team-entry-rekey.integration.test.ts.

const ENTRY = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const H_REKEYED = "22222222-2222-4222-8222-222222222222";
const H_RETAINED = "33333333-3333-4333-8333-333333333333";

const wrap = { encryptedItemKey: "d".repeat(40), itemKeyIv: "c".repeat(24), itemKeyAuthTag: "e".repeat(32) };
const entryRow = {
  teamKeyVersion: 3, itemKeyVersion: 4, ...wrap, itemKeyId: NEW_ID, itemKeyTeamKeyVersion: 3, itemKeyVersionHighWater: 4,
};
const rekeyedRow = { id: H_REKEYED, teamKeyVersion: 3, itemKeyVersion: 4, ...wrap, itemKeyId: NEW_ID };
const retainedRow = {
  id: H_RETAINED, teamKeyVersion: 1, itemKeyVersion: 1,
  encryptedItemKey: "f".repeat(40), itemKeyIv: "9".repeat(24), itemKeyAuthTag: "8".repeat(32), itemKeyId: OLD_ID,
};
const attachmentRow = { encryptionMode: 2, cekItemKeyId: NEW_ID, cekKeyVersion: 4, keyVersion: 3 };

function fakeTx(rows: { entry?: object | null; history?: object[]; attachments?: object[] } = {}) {
  return {
    teamPasswordEntry: { findUnique: vi.fn().mockResolvedValue(rows.entry === undefined ? entryRow : rows.entry) },
    teamPasswordEntryHistory: { findMany: vi.fn().mockResolvedValue(rows.history ?? [rekeyedRow, retainedRow]) },
    attachment: { findMany: vi.fn().mockResolvedValue(rows.attachments ?? [attachmentRow]) },
  };
}

describe("assertEntryRekeyConsistent", () => {
  it("passes for consistent rows", async () => {
    await expect(assertEntryRekeyConsistent(fakeTx() as never, ENTRY, [H_RETAINED])).resolves.toBeUndefined();
  });

  it.each<[string, Parameters<typeof fakeTx>[0], string[], RekeyInconsistency]>([
    ["the entry is gone", { entry: null }, [H_RETAINED], REKEY_INCONSISTENCY.ENTRY_MISSING],
    ["the entry has no ItemKey id", { entry: { ...entryRow, itemKeyId: null } }, [H_RETAINED], REKEY_INCONSISTENCY.ENTRY_WITHOUT_ITEM_KEY],
    ["the entry has no wrap", { entry: { ...entryRow, encryptedItemKey: null } }, [H_RETAINED], REKEY_INCONSISTENCY.ENTRY_WITHOUT_ITEM_KEY],
    ["the marker is not the entry's team key version", { entry: { ...entryRow, itemKeyTeamKeyVersion: 2 } }, [H_RETAINED], REKEY_INCONSISTENCY.ENTRY_MARKER_NOT_CURRENT],
    ["the high-water is not the entry's item key version", { entry: { ...entryRow, itemKeyVersionHighWater: 5 } }, [H_RETAINED], REKEY_INCONSISTENCY.ENTRY_HIGH_WATER_MISMATCH],
    ["a retained id names no row", { history: [rekeyedRow] }, [H_RETAINED], REKEY_INCONSISTENCY.RETAINED_ROW_MISSING],
    ["a retained row carries the new id", { history: [rekeyedRow, { ...retainedRow, itemKeyId: NEW_ID }] }, [H_RETAINED], REKEY_INCONSISTENCY.RETAINED_ROW_CARRIES_NEW_ID],
    ["a re-keyed row keeps the old id", { history: [{ ...rekeyedRow, itemKeyId: OLD_ID }, retainedRow] }, [H_RETAINED], REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED],
    ["a re-keyed row has another item key version", { history: [{ ...rekeyedRow, itemKeyVersion: 1 }, retainedRow] }, [H_RETAINED], REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED],
    ["a re-keyed row has another team key version", { history: [{ ...rekeyedRow, teamKeyVersion: 2 }, retainedRow] }, [H_RETAINED], REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED],
    ["a re-keyed row has other wrap bytes", { history: [{ ...rekeyedRow, itemKeyAuthTag: "0".repeat(32) }, retainedRow] }, [H_RETAINED], REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED],
    ["an unlisted row is not re-keyed (retained but not named)", {}, [], REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED],
    ["an attachment is legacy", { attachments: [{ ...attachmentRow, encryptionMode: 1 }] }, [H_RETAINED], REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED],
    ["an attachment keeps the old id", { attachments: [{ ...attachmentRow, cekItemKeyId: OLD_ID }] }, [H_RETAINED], REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED],
    ["an attachment has a stale cekKeyVersion", { attachments: [{ ...attachmentRow, cekKeyVersion: 1 }] }, [H_RETAINED], REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED],
    ["an attachment has a stale keyVersion", { attachments: [{ ...attachmentRow, keyVersion: 2 }] }, [H_RETAINED], REKEY_INCONSISTENCY.ATTACHMENT_NOT_REKEYED],
  ])("throws when %s", async (_label, rows, retained, code) => {
    await expect(assertEntryRekeyConsistent(fakeTx(rows) as never, ENTRY, retained)).rejects.toMatchObject({
      name: "RekeyConsistencyError",
      code,
    });
  });
});
