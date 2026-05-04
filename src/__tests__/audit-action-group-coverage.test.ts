import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_GROUPS_TENANT,
} from "@/lib/constants";

describe("AUDIT_ACTION group coverage", () => {
  it("every AUDIT_ACTION_VALUES entry is registered in at least one group", () => {
    const inAnyGroup = new Set([
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TEAM).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TENANT).flat(),
    ]);
    const missing = AUDIT_ACTION_VALUES.filter((a) => !inAnyGroup.has(a));
    expect(missing).toEqual([]);
  });
});
