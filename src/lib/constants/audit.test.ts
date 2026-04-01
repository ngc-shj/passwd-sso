import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_GROUPS_TENANT,
  AUDIT_ACTION_VALUES,
  TENANT_WEBHOOK_EVENT_GROUPS,
  TEAM_WEBHOOK_EVENT_GROUPS,
  TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS,
  TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS,
} from "@/lib/constants";

describe("audit constants", () => {
  it("has AUDIT_ACTION_VALUES aligned with AUDIT_ACTION", () => {
    const valuesFromObject = Object.values(AUDIT_ACTION);
    const valuesFromArray = [...AUDIT_ACTION_VALUES];

    expect(new Set(valuesFromArray).size).toBe(valuesFromArray.length);
    expect(new Set(valuesFromArray)).toEqual(new Set(valuesFromObject));
  });

  it("has only valid actions in personal, team, and tenant action groups", () => {
    const valid = new Set(Object.values(AUDIT_ACTION));
    const grouped = [
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TEAM).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TENANT).flat(),
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
      AUDIT_ACTION.ENTRY_BULK_IMPORT,
      AUDIT_ACTION.ENTRY_IMPORT,
      AUDIT_ACTION.ENTRY_EXPORT,
    ]);
    expect(AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.TRANSFER]).toEqual([
      AUDIT_ACTION.ENTRY_BULK_IMPORT,
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

  it("defines BREAKGLASS group with expected actions", () => {
    expect(AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.BREAKGLASS]).toEqual([
      AUDIT_ACTION.PERSONAL_LOG_ACCESS_REQUEST,
      AUDIT_ACTION.PERSONAL_LOG_ACCESS_VIEW,
      AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
      AUDIT_ACTION.PERSONAL_LOG_ACCESS_EXPIRE,
    ]);
  });

  it("has TENANT_WEBHOOK_EVENT_GROUPS with expected group keys", () => {
    const keys = Object.keys(TENANT_WEBHOOK_EVENT_GROUPS);
    expect(keys).toEqual([
      AUDIT_ACTION_GROUP.ADMIN,
      AUDIT_ACTION_GROUP.SCIM,
      AUDIT_ACTION_GROUP.DIRECTORY_SYNC,
      AUDIT_ACTION_GROUP.BREAKGLASS,
      AUDIT_ACTION_GROUP.SERVICE_ACCOUNT,
    ]);
  });

  it("excludes TENANT_WEBHOOK/MCP_CLIENT/DELEGATION from tenant webhook event groups", () => {
    const keys = new Set(Object.keys(TENANT_WEBHOOK_EVENT_GROUPS));
    expect(keys.has(AUDIT_ACTION_GROUP.TENANT_WEBHOOK)).toBe(false);
    expect(keys.has(AUDIT_ACTION_GROUP.MCP_CLIENT)).toBe(false);
    expect(keys.has(AUDIT_ACTION_GROUP.DELEGATION)).toBe(false);

    // Also verify at action value level
    const allSubscribable = new Set<string>(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS);
    expect(allSubscribable.has(AUDIT_ACTION.TENANT_WEBHOOK_CREATE)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.MCP_CLIENT_CREATE)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.DELEGATION_CREATE)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.PERSONAL_LOG_ACCESS_VIEW)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.PERSONAL_LOG_ACCESS_EXPIRE)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.HISTORY_PURGE)).toBe(false);
  });

  it("has TEAM_WEBHOOK_EVENT_GROUPS with only ENTRY group", () => {
    expect(Object.keys(TEAM_WEBHOOK_EVENT_GROUPS)).toEqual([
      AUDIT_ACTION_GROUP.ENTRY,
    ]);
    expect(TEAM_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.ENTRY]).toEqual([
      AUDIT_ACTION.ENTRY_CREATE,
      AUDIT_ACTION.ENTRY_UPDATE,
      AUDIT_ACTION.ENTRY_DELETE,
    ]);
  });

  it("derives SUBSCRIBABLE_ACTIONS from EVENT_GROUPS", () => {
    expect([...TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
      Object.values(TENANT_WEBHOOK_EVENT_GROUPS).flat(),
    );
    expect([...TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
      Object.values(TEAM_WEBHOOK_EVENT_GROUPS).flat(),
    );
  });
});
