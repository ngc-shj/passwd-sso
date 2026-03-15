import { describe, expect, it } from "vitest";
import type { AuditAction } from "@prisma/client";
import {
  VALID_ACTIONS,
  parseAuditLogParams,
  buildAuditLogActionFilter,
  buildAuditLogDateFilter,
  paginateResult,
} from "./audit-query";
import { AUDIT_ACTION, AUDIT_ACTION_VALUES } from "@/lib/constants";

// Minimal action groups for unit testing without importing full constants
const TEST_GROUPS: Record<string, AuditAction[]> = {
  "group:auth": [AUDIT_ACTION.AUTH_LOGIN, AUDIT_ACTION.AUTH_LOGOUT],
  "group:entry": [AUDIT_ACTION.ENTRY_CREATE, AUDIT_ACTION.ENTRY_UPDATE],
};

describe("VALID_ACTIONS", () => {
  it("is a Set instance", () => {
    expect(VALID_ACTIONS).toBeInstanceOf(Set);
  });

  it("contains all values from AUDIT_ACTION_VALUES", () => {
    for (const action of AUDIT_ACTION_VALUES) {
      expect(VALID_ACTIONS.has(action)).toBe(true);
    }
  });

  it("contains known actions like AUTH_LOGIN and ENTRY_CREATE", () => {
    expect(VALID_ACTIONS.has(AUDIT_ACTION.AUTH_LOGIN)).toBe(true);
    expect(VALID_ACTIONS.has(AUDIT_ACTION.ENTRY_CREATE)).toBe(true);
    expect(VALID_ACTIONS.has(AUDIT_ACTION.PERSONAL_LOG_ACCESS_REQUEST)).toBe(true);
  });

  it("does not contain unknown action strings", () => {
    expect(VALID_ACTIONS.has("NOT_REAL_ACTION")).toBe(false);
    expect(VALID_ACTIONS.has("")).toBe(false);
  });

  it("has the same size as AUDIT_ACTION_VALUES", () => {
    expect(VALID_ACTIONS.size).toBe(AUDIT_ACTION_VALUES.length);
  });
});

describe("parseAuditLogParams", () => {
  it("returns default limit of 50 when no limit param is provided", () => {
    const params = new URLSearchParams();
    const result = parseAuditLogParams(params);
    expect(result.limit).toBe(50);
  });

  it("parses a valid limit within range", () => {
    const params = new URLSearchParams({ limit: "25" });
    const result = parseAuditLogParams(params);
    expect(result.limit).toBe(25);
  });

  it("clamps limit to minimum of 1", () => {
    // limit=0 is falsy, so the || 50 fallback applies before clamping → 50
    const params = new URLSearchParams({ limit: "0" });
    expect(parseAuditLogParams(params).limit).toBe(50);

    const params2 = new URLSearchParams({ limit: "-10" });
    expect(parseAuditLogParams(params2).limit).toBe(1);
  });

  it("clamps limit to maximum of 100", () => {
    const params = new URLSearchParams({ limit: "200" });
    expect(parseAuditLogParams(params).limit).toBe(100);

    const params2 = new URLSearchParams({ limit: "101" });
    expect(parseAuditLogParams(params2).limit).toBe(100);
  });

  it("uses default of 50 when limit is non-numeric", () => {
    const params = new URLSearchParams({ limit: "abc" });
    expect(parseAuditLogParams(params).limit).toBe(50);
  });

  it("parses cursor from search params", () => {
    const params = new URLSearchParams({ cursor: "cursor-id-123" });
    expect(parseAuditLogParams(params).cursor).toBe("cursor-id-123");
  });

  it("returns null cursor when not provided", () => {
    const params = new URLSearchParams();
    expect(parseAuditLogParams(params).cursor).toBeNull();
  });

  it("parses action param", () => {
    const params = new URLSearchParams({ action: "AUTH_LOGIN" });
    expect(parseAuditLogParams(params).action).toBe("AUTH_LOGIN");
  });

  it("returns null action when not provided", () => {
    const params = new URLSearchParams();
    expect(parseAuditLogParams(params).action).toBeNull();
  });

  it("parses actions param (comma-separated)", () => {
    const params = new URLSearchParams({ actions: "AUTH_LOGIN,AUTH_LOGOUT" });
    expect(parseAuditLogParams(params).actions).toBe("AUTH_LOGIN,AUTH_LOGOUT");
  });

  it("returns null actions when not provided", () => {
    const params = new URLSearchParams();
    expect(parseAuditLogParams(params).actions).toBeNull();
  });

  it("parses from and to date params", () => {
    const from = "2024-01-01T00:00:00.000Z";
    const to = "2024-12-31T23:59:59.000Z";
    const params = new URLSearchParams({ from, to });
    const result = parseAuditLogParams(params);
    expect(result.from).toBe(from);
    expect(result.to).toBe(to);
  });

  it("returns null from and to when not provided", () => {
    const params = new URLSearchParams();
    expect(parseAuditLogParams(params).from).toBeNull();
    expect(parseAuditLogParams(params).to).toBeNull();
  });

  it("accepts limit of exactly 1", () => {
    const params = new URLSearchParams({ limit: "1" });
    expect(parseAuditLogParams(params).limit).toBe(1);
  });

  it("accepts limit of exactly 100", () => {
    const params = new URLSearchParams({ limit: "100" });
    expect(parseAuditLogParams(params).limit).toBe(100);
  });
});

describe("buildAuditLogActionFilter", () => {
  it("returns undefined when neither action nor actions is provided", () => {
    const result = buildAuditLogActionFilter(
      { action: null, actions: null },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toBeUndefined();
  });

  it("returns a single action string when a known single action is given", () => {
    const result = buildAuditLogActionFilter(
      { action: "AUTH_LOGIN", actions: null },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toBe("AUTH_LOGIN");
  });

  it("returns { in: [...] } when action matches a group name", () => {
    const result = buildAuditLogActionFilter(
      { action: "group:auth", actions: null },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toEqual({ in: [AUDIT_ACTION.AUTH_LOGIN, AUDIT_ACTION.AUTH_LOGOUT] });
  });

  it("returns { in: [...] } when actions param contains multiple known actions", () => {
    const result = buildAuditLogActionFilter(
      { action: null, actions: "AUTH_LOGIN,ENTRY_CREATE" },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toEqual({
      in: [AUDIT_ACTION.AUTH_LOGIN, AUDIT_ACTION.ENTRY_CREATE],
    });
  });

  it("returns { in: [...] } for a single action in actions param", () => {
    const result = buildAuditLogActionFilter(
      { action: null, actions: "AUTH_LOGIN" },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toEqual({ in: [AUDIT_ACTION.AUTH_LOGIN] });
  });

  it("throws { actions: [...] } when actions contains an unknown action", () => {
    expect(() =>
      buildAuditLogActionFilter(
        { action: null, actions: "UNKNOWN_ACTION" },
        VALID_ACTIONS,
        TEST_GROUPS,
      )
    ).toThrow();

    try {
      buildAuditLogActionFilter(
        { action: null, actions: "UNKNOWN_ACTION" },
        VALID_ACTIONS,
        TEST_GROUPS,
      );
    } catch (err) {
      expect(err).toEqual({ actions: ["UNKNOWN_ACTION"] });
    }
  });

  it("throws with all invalid actions listed when multiple unknowns are given", () => {
    try {
      buildAuditLogActionFilter(
        { action: null, actions: "UNKNOWN_ONE,UNKNOWN_TWO" },
        VALID_ACTIONS,
        TEST_GROUPS,
      );
      // Should not reach here
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toEqual({ actions: ["UNKNOWN_ONE", "UNKNOWN_TWO"] });
    }
  });

  it("throws only for invalid actions when mixed with valid ones", () => {
    try {
      buildAuditLogActionFilter(
        { action: null, actions: "AUTH_LOGIN,INVALID_ACTION" },
        VALID_ACTIONS,
        TEST_GROUPS,
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toEqual({ actions: ["INVALID_ACTION"] });
    }
  });

  it("returns undefined when action is an unknown string not matching any group or valid action", () => {
    const result = buildAuditLogActionFilter(
      { action: "NOT_VALID", actions: null },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toBeUndefined();
  });

  it("trims whitespace from comma-separated actions", () => {
    const result = buildAuditLogActionFilter(
      { action: null, actions: " AUTH_LOGIN , AUTH_LOGOUT " },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toEqual({
      in: [AUDIT_ACTION.AUTH_LOGIN, AUDIT_ACTION.AUTH_LOGOUT],
    });
  });

  it("prefers actions param over action param when both are provided", () => {
    const result = buildAuditLogActionFilter(
      { action: "AUTH_LOGIN", actions: "ENTRY_CREATE,ENTRY_UPDATE" },
      VALID_ACTIONS,
      TEST_GROUPS,
    );
    expect(result).toEqual({
      in: [AUDIT_ACTION.ENTRY_CREATE, AUDIT_ACTION.ENTRY_UPDATE],
    });
  });
});

describe("buildAuditLogDateFilter", () => {
  it("returns undefined when neither from nor to is provided", () => {
    expect(buildAuditLogDateFilter(null, null)).toBeUndefined();
  });

  it("returns { gte } when only from is provided", () => {
    const from = "2024-01-01T00:00:00.000Z";
    const result = buildAuditLogDateFilter(from, null);
    expect(result).toEqual({ gte: new Date(from) });
    expect(result?.lte).toBeUndefined();
  });

  it("returns { lte } when only to is provided", () => {
    const to = "2024-12-31T23:59:59.000Z";
    const result = buildAuditLogDateFilter(null, to);
    expect(result).toEqual({ lte: new Date(to) });
    expect(result?.gte).toBeUndefined();
  });

  it("returns { gte, lte } when both from and to are provided", () => {
    const from = "2024-01-01T00:00:00.000Z";
    const to = "2024-12-31T23:59:59.000Z";
    const result = buildAuditLogDateFilter(from, to);
    expect(result).toEqual({ gte: new Date(from), lte: new Date(to) });
  });

  it("creates valid Date objects from ISO strings", () => {
    const from = "2024-06-15T12:00:00.000Z";
    const result = buildAuditLogDateFilter(from, null);
    expect(result?.gte).toBeInstanceOf(Date);
    expect(result?.gte?.toISOString()).toBe(from);
  });
});

describe("paginateResult", () => {
  const makeItems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `id-${i}` }));

  it("returns hasMore=false and null cursor when items <= limit", () => {
    const items = makeItems(5);
    const result = paginateResult(items, 10);
    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it("returns all items and null cursor when items exactly equal limit", () => {
    const items = makeItems(10);
    const result = paginateResult(items, 10);
    expect(result.items).toHaveLength(10);
    expect(result.nextCursor).toBeNull();
  });

  it("returns sliced items and correct cursor when hasMore=true", () => {
    // limit+1 items means there is a next page
    const items = makeItems(11);
    const result = paginateResult(items, 10);
    expect(result.items).toHaveLength(10);
    expect(result.nextCursor).toBe("id-9");
  });

  it("sets nextCursor to the last item id of the sliced result", () => {
    const items = makeItems(6);
    const result = paginateResult(items, 5);
    expect(result.nextCursor).toBe(items[4].id);
  });

  it("does not include the extra item in the returned items array", () => {
    const items = makeItems(4);
    const result = paginateResult(items, 3);
    expect(result.items).toHaveLength(3);
    expect(result.items.find((item) => item.id === "id-3")).toBeUndefined();
  });

  it("returns empty items and null cursor for empty input", () => {
    const result = paginateResult([], 10);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("works with limit of 1", () => {
    const items = makeItems(2);
    const result = paginateResult(items, 1);
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe("id-0");
  });
});
