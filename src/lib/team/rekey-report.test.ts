import { describe, expect, it } from "vitest";
import {
  REKEY_EXIT,
  REKEY_ISSUE,
  buildRekeyReport,
  holderInputsFrom,
  isKeySuspect,
  type VersionHoldersDto,
} from "./rekey-report";

describe("isKeySuspect (more than half of the actor's entries at v, and at least 2)", () => {
  it.each([
    [1, 1, false],
    [2, 4, false],
    [2, 3, true],
    [3, 5, true],
  ])("%i of %i failed → shown: %s", (failed, attempted, shown) => {
    expect(isKeySuspect(failed, attempted)).toBe(shown);
  });
});

describe("buildRekeyReport", () => {
  it("names holder Y as the exit of an undecryptable entry and never offers delete", () => {
    const report = buildRekeyReport({
      undecryptable: [{ entryId: "x1", teamKeyVersion: 2 }],
      otherHoldersByVersion: { 2: ["Y"] },
    });

    const item = report.items.find((i) => i.issue === REKEY_ISSUE.UNDECRYPTABLE);
    expect(item?.exits).toEqual([REKEY_EXIT.ANOTHER_HOLDER_REKEYS]);
    expect(item?.holdersByVersion).toEqual({ 2: ["Y"] });
    expect(item?.exits).not.toContain(REKEY_EXIT.DELETE_ENTRY);
  });

  it("tells a key_invalid holder another holder of v re-keys, without offering delete", () => {
    const report = buildRekeyReport({
      keyInvalid: [{ entryId: "k1", teamKeyVersion: 3 }],
      otherHoldersByVersion: { 3: ["Y"] },
    });

    const item = report.items.find((i) => i.issue === REKEY_ISSUE.KEY_INVALID);
    expect(item).toMatchObject({ teamKeyVersion: 3, entryIds: ["k1"], exits: [REKEY_EXIT.ANOTHER_HOLDER_REKEYS] });
    expect(item?.exits).not.toContain(REKEY_EXIT.DELETE_ENTRY);
  });

  it("lists delete for an unrecoverable entry in the same report (control)", () => {
    const report = buildRekeyReport({
      undecryptable: [{ entryId: "x1", teamKeyVersion: 2 }],
      keyInvalid: [{ entryId: "k1", teamKeyVersion: 3 }],
      otherHoldersByVersion: { 2: ["Y"], 3: ["Y"] },
      stateCounts: { unrecoverable: 1 },
      deactivatedHolder: true,
    });

    const unrecoverable = report.items.find((i) => i.issue === REKEY_ISSUE.UNRECOVERABLE);
    expect(unrecoverable?.exits).toEqual([REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.DELETE_ENTRY]);
    expect(unrecoverable?.deactivatedHolder).toBe(true);
    for (const issue of [REKEY_ISSUE.UNDECRYPTABLE, REKEY_ISSUE.KEY_INVALID]) {
      expect(report.items.find((i) => i.issue === issue)?.exits).not.toContain(REKEY_EXIT.DELETE_ENTRY);
    }
  });

  it("gives the sole active holder restore and compare-with-admin as exits", () => {
    const report = buildRekeyReport({
      undecryptable: [{ entryId: "x1", teamKeyVersion: 2 }],
      otherHoldersByVersion: { 2: [] },
    });

    expect(report.items[0].exits).toEqual([
      REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW,
      REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN,
    ]);
  });

  it("offers every non-delete exit when the other holders are not known", () => {
    const report = buildRekeyReport({ undecryptable: [{ entryId: "x1", teamKeyVersion: 2 }] });

    expect(report.items[0].exits).toEqual([
      REKEY_EXIT.ANOTHER_HOLDER_REKEYS,
      REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW,
      REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN,
    ]);
  });

  it("shows the key suspicion when 2 of 3 entries at v fail, not when 1 of 4 does", () => {
    const suspect = buildRekeyReport({
      undecryptable: [
        { entryId: "a", teamKeyVersion: 2 },
        { entryId: "b", teamKeyVersion: 2 },
        { entryId: "c", teamKeyVersion: 5 },
      ],
      attemptedByVersion: new Map([[2, 3], [5, 4]]),
    });
    expect(suspect.keySuspectVersions).toEqual([2]);
  });

  it("orders holder-cannot-re-key exits least privilege first", () => {
    const report = buildRekeyReport({ stateCounts: { holder_cannot_rekey: 2 } });

    expect(report.items).toEqual([
      expect.objectContaining({
        issue: REKEY_ISSUE.HOLDER_CANNOT_REKEY,
        count: 2,
        exits: [REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.DELETE_ENTRY, REKEY_EXIT.TEMPORARY_PROMOTION],
      }),
    ]);
  });

  it("lists the re-keyer holders per version for needs-re-keyer-holder entries", () => {
    const report = buildRekeyReport({
      stateCounts: { needs_rekeyer_holder: 3 },
      rekeyerHoldersByVersion: { 2: ["alice"], 4: ["bob"] },
    });

    expect(report.items[0]).toMatchObject({
      issue: REKEY_ISSUE.NEEDS_REKEYER_HOLDER,
      count: 3,
      exits: [REKEY_EXIT.ANOTHER_HOLDER_REKEYS],
      holdersByVersion: { 2: ["alice"], 4: ["bob"] },
    });
  });

  it("groups skipped entries by reason with retry as the exit", () => {
    const report = buildRekeyReport({
      skipped: [
        { entryId: "a", reason: "ITEM_KEY_IV_REUSED" },
        { entryId: "b", reason: "ITEM_KEY_IV_REUSED" },
      ],
    });

    expect(report.items).toEqual([
      expect.objectContaining({ issue: REKEY_ISSUE.SKIPPED, entryIds: ["a", "b"], reason: "ITEM_KEY_IV_REUSED", exits: [REKEY_EXIT.RETRY_PASS] }),
    ]);
  });

  it("does not mark an unrecoverable entry's delete when no deactivated member holds the version (negative of the pair above)", () => {
    const report = buildRekeyReport({ stateCounts: { unrecoverable: 1 }, deactivatedHolder: false });
    expect(report.items[0]).toMatchObject({ exits: [REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.DELETE_ENTRY], deactivatedHolder: false });
  });
});

describe("holderInputsFrom (server versionHolders → report inputs)", () => {
  const v = (over: Partial<VersionHoldersDto>): VersionHoldersDto => ({
    callerHolds: true, activeHolderCount: 1, holders: [], deactivatedHolderCount: 0, ...over,
  });

  it("names holder Y for a version the caller holds, so the undecryptable exit names Y", () => {
    const inputs = holderInputsFrom({ 2: v({ activeHolderCount: 2, holders: [{ id: "y", name: "Y", email: null, canRekey: true }] }) }, "?");
    const report = buildRekeyReport({ undecryptable: [{ entryId: "x", teamKeyVersion: 2 }], ...inputs });
    expect(report.items[0]).toMatchObject({ exits: [REKEY_EXIT.ANOTHER_HOLDER_REKEYS], holdersByVersion: { 2: ["Y"] } });
  });

  it("gives the sole active holder's exits when the caller is the only holder", () => {
    const inputs = holderInputsFrom({ 2: v({}) }, "?");
    const report = buildRekeyReport({ keyInvalid: [{ entryId: "k", teamKeyVersion: 2 }], ...inputs });
    expect(report.items[0].exits).toEqual([REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW, REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN]);
  });

  it("warns on delete when a deactivated member holds a version no active member holds", () => {
    expect(holderInputsFrom({ 1: v({ callerHolds: false, activeHolderCount: 0, deactivatedHolderCount: 1 }) }, "?").deactivatedHolder).toBe(true);
  });

  it("does not warn when the deactivated holder's version still has an active holder, or none is deactivated", () => {
    expect(holderInputsFrom({
      1: v({ callerHolds: false, activeHolderCount: 0, deactivatedHolderCount: 0 }),
      2: v({ activeHolderCount: 1, deactivatedHolderCount: 3 }),
    }, "?").deactivatedHolder).toBe(false);
  });
});
