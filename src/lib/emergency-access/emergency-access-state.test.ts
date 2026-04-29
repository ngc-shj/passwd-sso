import { describe, it, expect } from "vitest";
import { canTransition, fromStatusesFor } from "./emergency-access-state";
import { EA_STATUS } from "@/lib/constants";

describe("canTransition", () => {
  // STALE-specific transitions
  it("allows IDLE → STALE", () => {
    expect(canTransition(EA_STATUS.IDLE, EA_STATUS.STALE)).toBe(true);
  });

  it("allows ACTIVATED → STALE", () => {
    expect(canTransition(EA_STATUS.ACTIVATED, EA_STATUS.STALE)).toBe(true);
  });

  it("allows STALE → IDLE (re-confirm)", () => {
    expect(canTransition(EA_STATUS.STALE, EA_STATUS.IDLE)).toBe(true);
  });

  it("allows STALE → REVOKED", () => {
    expect(canTransition(EA_STATUS.STALE, EA_STATUS.REVOKED)).toBe(true);
  });

  it("does not allow STALE → REQUESTED", () => {
    expect(canTransition(EA_STATUS.STALE, EA_STATUS.REQUESTED)).toBe(false);
  });

  it("does not allow STALE → ACTIVATED", () => {
    expect(canTransition(EA_STATUS.STALE, EA_STATUS.ACTIVATED)).toBe(false);
  });

  it("does not allow STALE → ACCEPTED", () => {
    expect(canTransition(EA_STATUS.STALE, EA_STATUS.ACCEPTED)).toBe(false);
  });

  // Existing transitions (regression)
  it("allows PENDING → ACCEPTED", () => {
    expect(canTransition(EA_STATUS.PENDING, EA_STATUS.ACCEPTED)).toBe(true);
  });

  it("allows ACCEPTED → IDLE", () => {
    expect(canTransition(EA_STATUS.ACCEPTED, EA_STATUS.IDLE)).toBe(true);
  });

  it("allows IDLE → REQUESTED", () => {
    expect(canTransition(EA_STATUS.IDLE, EA_STATUS.REQUESTED)).toBe(true);
  });

  it("allows REQUESTED → ACTIVATED", () => {
    expect(canTransition(EA_STATUS.REQUESTED, EA_STATUS.ACTIVATED)).toBe(true);
  });

  it("does not allow REVOKED → any", () => {
    expect(canTransition(EA_STATUS.REVOKED, EA_STATUS.IDLE)).toBe(false);
    expect(canTransition(EA_STATUS.REVOKED, EA_STATUS.STALE)).toBe(false);
  });

  it("does not allow REJECTED → any", () => {
    expect(canTransition(EA_STATUS.REJECTED, EA_STATUS.IDLE)).toBe(false);
    expect(canTransition(EA_STATUS.REJECTED, EA_STATUS.STALE)).toBe(false);
  });
});

describe("fromStatusesFor", () => {
  // For each `to`, fromStatusesFor(to) must contain exactly the statuses for
  // which canTransition(from, to) is true. This invariant is what lets route
  // handlers replace the optimistic canTransition check with a CAS updateMany.
  it("matches canTransition for ACTIVATED", () => {
    const froms = fromStatusesFor(EA_STATUS.ACTIVATED);
    expect(froms).toEqual([EA_STATUS.REQUESTED]);
    expect(canTransition(EA_STATUS.REQUESTED, EA_STATUS.ACTIVATED)).toBe(true);
  });

  it("matches canTransition for REQUESTED", () => {
    const froms = fromStatusesFor(EA_STATUS.REQUESTED);
    expect(froms).toEqual([EA_STATUS.IDLE]);
  });

  it("matches canTransition for IDLE (multiple from-states)", () => {
    const froms = fromStatusesFor(EA_STATUS.IDLE);
    expect(froms).toEqual(
      expect.arrayContaining([EA_STATUS.ACCEPTED, EA_STATUS.STALE, EA_STATUS.REQUESTED]),
    );
    expect(froms).toHaveLength(3);
  });

  it("matches canTransition for REVOKED (terminal target from many states)", () => {
    const froms = fromStatusesFor(EA_STATUS.REVOKED);
    // All non-terminal states permit transition to REVOKED.
    expect(froms).toEqual(
      expect.arrayContaining([
        EA_STATUS.PENDING,
        EA_STATUS.ACCEPTED,
        EA_STATUS.IDLE,
        EA_STATUS.STALE,
        EA_STATUS.REQUESTED,
        EA_STATUS.ACTIVATED,
      ]),
    );
  });

  it("returns empty array for terminal statuses (cannot be a destination of any transition)", () => {
    // PENDING is the initial status; no transition leads INTO it.
    expect(fromStatusesFor(EA_STATUS.PENDING)).toEqual([]);
  });

  it("invariant: fromStatusesFor and canTransition agree for every (from, to) pair", () => {
    const allStatuses = Object.values(EA_STATUS);
    for (const to of allStatuses) {
      const expectedFroms = allStatuses.filter((from) => canTransition(from, to));
      const actualFroms = fromStatusesFor(to);
      expect(actualFroms.sort()).toEqual(expectedFroms.sort());
    }
  });
});
