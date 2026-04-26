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
  mergeActionGroups,
} from "@/lib/constants";

describe("mergeActionGroups", () => {
  it("merges duplicate key group:admin with Set-based union", () => {
    const result = mergeActionGroups(AUDIT_ACTION_GROUPS_TENANT, AUDIT_ACTION_GROUPS_TEAM);
    const adminActions = result[AUDIT_ACTION_GROUP.ADMIN];

    // Must contain actions from TENANT side
    expect(adminActions).toContain(AUDIT_ACTION.TENANT_ROLE_UPDATE);
    expect(adminActions).toContain(AUDIT_ACTION.ACCESS_DENIED);
    expect(adminActions).toContain(AUDIT_ACTION.HISTORY_PURGE);
    expect(adminActions).toContain(AUDIT_ACTION.AUDIT_LOG_PURGE);

    // Must contain actions from TEAM side
    expect(adminActions).toContain(AUDIT_ACTION.MASTER_KEY_ROTATION);
    expect(adminActions).toContain(AUDIT_ACTION.VAULT_KEY_ROTATION);
    expect(adminActions).toContain(AUDIT_ACTION.TEAM_KEY_ROTATION);

    // No duplicates (Set-based union)
    expect(new Set(adminActions).size).toBe(adminActions.length);
  });

  it("merges duplicate key group:scim preserving all actions", () => {
    const result = mergeActionGroups(AUDIT_ACTION_GROUPS_TENANT, AUDIT_ACTION_GROUPS_TEAM);
    const scimActions = result[AUDIT_ACTION_GROUP.SCIM];

    // Both sides have the same 8 SCIM actions — union is idempotent
    const tenantScim = AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.SCIM];
    const teamScim = AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.SCIM];
    const expectedUnion = [...new Set([...tenantScim, ...teamScim])];

    expect(scimActions).toEqual(expectedUnion);
    expect(new Set(scimActions).size).toBe(scimActions.length);
  });

  it("preserves unique keys from both sources", () => {
    const result = mergeActionGroups(AUDIT_ACTION_GROUPS_TENANT, AUDIT_ACTION_GROUPS_TEAM);

    // Keys only in TENANT
    expect(result[AUDIT_ACTION_GROUP.DIRECTORY_SYNC]).toBeDefined();
    expect(result[AUDIT_ACTION_GROUP.BREAKGLASS]).toBeDefined();
    expect(result[AUDIT_ACTION_GROUP.SERVICE_ACCOUNT]).toBeDefined();

    // Keys only in TEAM
    expect(result[AUDIT_ACTION_GROUP.WEBHOOK]).toBeDefined();
    expect(result[AUDIT_ACTION_GROUP.TEAM]).toBeDefined();
    expect(result[AUDIT_ACTION_GROUP.ENTRY]).toBeDefined();
  });

  it("handles empty input", () => {
    const result = mergeActionGroups();
    expect(result).toEqual({});
  });
});

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
      AUDIT_ACTION_GROUP.MCP_CLIENT,
      AUDIT_ACTION_GROUP.DELEGATION,
      AUDIT_ACTION_GROUP.SHARE,
    ]);
  });

  it("excludes TENANT_WEBHOOK group and privacy-sensitive actions from tenant webhook event groups", () => {
    const keys = new Set(Object.keys(TENANT_WEBHOOK_EVENT_GROUPS));
    expect(keys.has(AUDIT_ACTION_GROUP.TENANT_WEBHOOK)).toBe(false);

    // Privacy-sensitive actions must not be subscribable
    const allSubscribable = new Set<string>(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS);
    expect(allSubscribable.has(AUDIT_ACTION.TENANT_WEBHOOK_CREATE)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.PERSONAL_LOG_ACCESS_VIEW)).toBe(false);
    expect(allSubscribable.has(AUDIT_ACTION.PERSONAL_LOG_ACCESS_EXPIRE)).toBe(false);
  });

  it("has TEAM_WEBHOOK_EVENT_GROUPS with expected groups", () => {
    const keys = new Set(Object.keys(TEAM_WEBHOOK_EVENT_GROUPS));

    // Self-referential and tenant-scoped groups excluded
    expect(keys.has(AUDIT_ACTION_GROUP.WEBHOOK)).toBe(false);
    expect(keys.has(AUDIT_ACTION_GROUP.SCIM)).toBe(false);

    // Admin group present with team-scoped subset
    expect(keys.has(AUDIT_ACTION_GROUP.ADMIN)).toBe(true);
    const adminActions = new Set(TEAM_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.ADMIN]);
    expect(adminActions.has(AUDIT_ACTION.POLICY_UPDATE)).toBe(true);
    expect(adminActions.has(AUDIT_ACTION.TEAM_KEY_ROTATION)).toBe(true);
    // Tenant-scoped admin actions excluded
    expect(adminActions.has(AUDIT_ACTION.MASTER_KEY_ROTATION)).toBe(false);
    expect(adminActions.has(AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE)).toBe(false);
  });

  it("derives SUBSCRIBABLE_ACTIONS from EVENT_GROUPS", () => {
    expect([...TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
      Object.values(TENANT_WEBHOOK_EVENT_GROUPS).flat(),
    );
    expect([...TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS]).toEqual(
      Object.values(TEAM_WEBHOOK_EVENT_GROUPS).flat(),
    );
  });

  it("every action belongs to at least one scope group (PERSONAL, TEAM, or TENANT)", () => {
    const allGrouped = new Set([
      ...Object.values(AUDIT_ACTION_GROUPS_PERSONAL).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TEAM).flat(),
      ...Object.values(AUDIT_ACTION_GROUPS_TENANT).flat(),
    ]);
    const ungrouped = AUDIT_ACTION_VALUES.filter((a) => !allGrouped.has(a));
    expect(ungrouped).toEqual([]);
  });

  it("MAINTENANCE group exists only in TENANT scope", () => {
    expect(AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeDefined();
    expect(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
    expect(AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
  });

  it("MAINTENANCE group is excluded from webhook event groups", () => {
    expect(TENANT_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
    expect(TEAM_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
  });
});
