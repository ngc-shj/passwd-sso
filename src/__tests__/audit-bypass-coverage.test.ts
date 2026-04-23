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
  ACTOR_TYPE,
} from "@/lib/constants/audit";
import { VALID_ACTOR_TYPES } from "@/lib/audit/audit-query";
import {
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  SENTINEL_ACTOR_IDS,
  NIL_UUID,
} from "@/lib/constants/app";
import enAuditLog from "../../messages/en/AuditLog.json";
import jaAuditLog from "../../messages/ja/AuditLog.json";

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

  it("OUTBOX_BYPASS_AUDIT_ACTIONS contains exactly the expected 7 actions", () => {
    const expected = new Set([
      // Phase 1: webhook delivery failures
      AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED,
      AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED,
      // Phase 2: outbox worker operational events
      AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
      AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
      // Phase 3: audit delivery failures
      AUDIT_ACTION.AUDIT_DELIVERY_FAILED,
      AUDIT_ACTION.AUDIT_DELIVERY_DEAD_LETTER,
    ]);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS).toEqual(expected);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.size).toBe(7);
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

const ACTOR_TYPE_I18N_KEYS: Record<string, string> = {
  HUMAN: "actorTypeHuman",
  SERVICE_ACCOUNT: "actorTypeSa",
  MCP_AGENT: "actorTypeMcp",
  SYSTEM: "actorTypeSystem",
  ANONYMOUS: "actorTypeAnonymous",
};

describe("ActorType exhaustiveness coverage (T4, T10)", () => {
  const allActorTypes = ["HUMAN", "SERVICE_ACCOUNT", "MCP_AGENT", "SYSTEM", "ANONYMOUS"] as const;

  for (const actorType of allActorTypes) {
    it(`VALID_ACTOR_TYPES includes ${actorType}`, () => {
      expect(VALID_ACTOR_TYPES as readonly string[]).toContain(actorType);
    });

    it(`ACTOR_TYPE const includes ${actorType}`, () => {
      expect(Object.values(ACTOR_TYPE)).toContain(actorType);
    });

    it(`en/AuditLog.json has i18n key for ${actorType}`, () => {
      const key = ACTOR_TYPE_I18N_KEYS[actorType];
      expect(enAuditLog).toHaveProperty(key);
    });

    it(`ja/AuditLog.json has i18n key for ${actorType}`, () => {
      const key = ACTOR_TYPE_I18N_KEYS[actorType];
      expect(jaAuditLog).toHaveProperty(key);
    });
  }
});

describe("TENANT_WEBHOOK_EVENT_GROUPS.SHARE coverage (T11/S1)", () => {
  it("contains SHARE_ACCESS_VERIFY_FAILED", () => {
    expect(TENANT_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.SHARE]).toContain(
      AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
    );
  });

  it("contains SHARE_ACCESS_VERIFY_SUCCESS", () => {
    expect(TENANT_WEBHOOK_EVENT_GROUPS[AUDIT_ACTION_GROUP.SHARE]).toContain(
      AUDIT_ACTION.SHARE_ACCESS_VERIFY_SUCCESS,
    );
  });
});

describe("SENTINEL_ACTOR_IDS invariants", () => {
  it("contains ANONYMOUS_ACTOR_ID", () => {
    expect(SENTINEL_ACTOR_IDS.has(ANONYMOUS_ACTOR_ID)).toBe(true);
  });

  it("contains SYSTEM_ACTOR_ID", () => {
    expect(SENTINEL_ACTOR_IDS.has(SYSTEM_ACTOR_ID)).toBe(true);
  });

  it("does not contain NIL_UUID", () => {
    expect(SENTINEL_ACTOR_IDS.has(NIL_UUID)).toBe(false);
  });

  it("has exactly 2 entries", () => {
    expect(SENTINEL_ACTOR_IDS.size).toBe(2);
  });
});
