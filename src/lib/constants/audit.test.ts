import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_VALUES,
} from "@/lib/constants";

describe("audit constants", () => {
  it("has AUDIT_ACTION_VALUES aligned with AUDIT_ACTION", () => {
    const valuesFromObject = Object.values(AUDIT_ACTION);
    const valuesFromArray = [...AUDIT_ACTION_VALUES];

    expect(new Set(valuesFromArray).size).toBe(valuesFromArray.length);
    expect(new Set(valuesFromArray)).toEqual(new Set(valuesFromObject));
  });

  it("has only valid actions in personal and team action groups", () => {
    const valid = new Set(Object.values(AUDIT_ACTION));
    const grouped = [
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TEAM).flat(),
    ];

    for (const action of grouped) {
      expect(valid.has(action)).toBe(true);
    }
  });

  it("defines transfer and entry groups with expected actions", () => {
    expect(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ENTRY]).toEqual([
      AUDIT_ACTION.ENTRY_CREATE,
      AUDIT_ACTION.ENTRY_UPDATE,
      AUDIT_ACTION.ENTRY_TRASH,
      AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
      AUDIT_ACTION.ENTRY_RESTORE,
    ]);
    expect(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.BULK]).toEqual([
      AUDIT_ACTION.ENTRY_BULK_TRASH,
      AUDIT_ACTION.ENTRY_EMPTY_TRASH,
      AUDIT_ACTION.ENTRY_BULK_ARCHIVE,
      AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
      AUDIT_ACTION.ENTRY_BULK_RESTORE,
    ]);
    expect(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.TRANSFER]).toEqual([
      AUDIT_ACTION.ENTRY_IMPORT,
      AUDIT_ACTION.ENTRY_EXPORT,
    ]);
    expect(AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.TRANSFER]).toEqual([
      AUDIT_ACTION.ENTRY_EXPORT,
    ]);
    expect(AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.BULK]).toEqual([
      AUDIT_ACTION.ENTRY_BULK_TRASH,
      AUDIT_ACTION.ENTRY_EMPTY_TRASH,
      AUDIT_ACTION.ENTRY_BULK_ARCHIVE,
      AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
      AUDIT_ACTION.ENTRY_BULK_RESTORE,
    ]);
  });

  it("does not overlap ENTRY and TRANSFER groups", () => {
    const personalEntry = new Set(
      AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ENTRY]
    );
    const personalBulk = new Set(
      AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.BULK]
    );
    const personalTransfer = new Set(
      AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.TRANSFER]
    );

    expect([...personalEntry].filter((action) => personalBulk.has(action))).toEqual([]);
    expect(
      [...personalEntry].filter((action) => personalTransfer.has(action))
    ).toEqual([]);
  });

  it("uses EMERGENCY_ prefix consistently for emergency actions", () => {
    const emergencyActions = Object.values(AUDIT_ACTION).filter((action) =>
      action.startsWith(AUDIT_ACTION_EMERGENCY_PREFIX)
    );

    expect(emergencyActions.length).toBeGreaterThan(0);
    for (const action of emergencyActions) {
      expect(action.startsWith("EMERGENCY_")).toBe(true);
    }
  });
});
