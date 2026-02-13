import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUPS_ORG,
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

  it("has only valid actions in personal and org action groups", () => {
    const valid = new Set(Object.values(AUDIT_ACTION));
    const grouped = [
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_ORG).flat(),
    ];

    for (const action of grouped) {
      expect(valid.has(action)).toBe(true);
    }
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
