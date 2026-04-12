import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_VALUES,
  OUTBOX_BYPASS_AUDIT_ACTIONS,
  WEBHOOK_DISPATCH_SUPPRESS,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_GROUP,
  TENANT_WEBHOOK_EVENT_GROUPS,
  TEAM_WEBHOOK_EVENT_GROUPS,
  TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS,
  TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS,
} from "@/lib/constants/audit";

const OUTBOX_ACTIONS = AUDIT_ACTION_VALUES.filter((a) =>
  a.startsWith("AUDIT_OUTBOX_"),
);

describe("audit bypass coverage", () => {
  it("identifies at least 5 AUDIT_OUTBOX_* actions", () => {
    expect(OUTBOX_ACTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("every AUDIT_OUTBOX_* action is in WEBHOOK_DISPATCH_SUPPRESS", () => {
    const missing = OUTBOX_ACTIONS.filter(
      (a) => !WEBHOOK_DISPATCH_SUPPRESS.has(a),
    );
    expect(missing).toEqual([]);
  });

  it("worker-emitted AUDIT_OUTBOX_* actions are in OUTBOX_BYPASS_AUDIT_ACTIONS", () => {
    const workerEmitted = [
      AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
      AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
    ];
    const missing = workerEmitted.filter(
      (a) => !OUTBOX_BYPASS_AUDIT_ACTIONS.has(a),
    );
    expect(missing).toEqual([]);
  });

  it("admin-endpoint AUDIT_OUTBOX_* actions are NOT in OUTBOX_BYPASS_AUDIT_ACTIONS", () => {
    const adminEndpoint = [
      AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW,
      AUDIT_ACTION.AUDIT_OUTBOX_PURGE_EXECUTED,
    ];
    for (const a of adminEndpoint) {
      expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(a)).toBe(false);
    }
  });

  it("WEBHOOK_DELIVERY_FAILED actions remain in OUTBOX_BYPASS_AUDIT_ACTIONS", () => {
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED)).toBe(true);
  });

  it("MAINTENANCE group is NOT in PERSONAL or TEAM group maps", () => {
    expect(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
    expect(AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
  });

  it("MAINTENANCE group is NOT in TENANT_WEBHOOK_EVENT_GROUPS", () => {
    expect(TENANT_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
  });

  it("MAINTENANCE group is NOT in TEAM_WEBHOOK_EVENT_GROUPS", () => {
    expect(TEAM_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.MAINTENANCE]).toBeUndefined();
  });

  it("no AUDIT_OUTBOX_* action is in webhook subscribable actions", () => {
    const tenantSubscribable = new Set<string>(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS);
    const teamSubscribable = new Set<string>(TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS);
    for (const a of OUTBOX_ACTIONS) {
      expect(tenantSubscribable.has(a)).toBe(false);
      expect(teamSubscribable.has(a)).toBe(false);
    }
  });
});
