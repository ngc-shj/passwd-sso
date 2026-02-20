import { describe, expect, it } from "vitest";
import {
  calculateTotalIssues,
  getCooldownState,
  getWatchtowerVisibility,
} from "@/lib/watchtower/state";

describe("getCooldownState", () => {
  it("allows analyze when no previous run exists", () => {
    const state = getCooldownState(null, 1000, false, 300000);
    expect(state.canAnalyze).toBe(true);
    expect(state.cooldownRemainingMs).toBe(0);
    expect(state.nextAllowedAt).toBeNull();
  });

  it("blocks analyze while cooldown remains", () => {
    const state = getCooldownState(1000, 2000, false, 300000);
    expect(state.canAnalyze).toBe(false);
    expect(state.cooldownRemainingMs).toBeGreaterThan(0);
    expect(state.nextAllowedAt).toBe(301000);
  });

  it("blocks analyze while loading even if cooldown elapsed", () => {
    const state = getCooldownState(1000, 500000, true, 300000);
    expect(state.canAnalyze).toBe(false);
    expect(state.cooldownRemainingMs).toBe(0);
  });
});

describe("watchtower visibility", () => {
  it("shows run hint before first run", () => {
    const visibility = getWatchtowerVisibility(null, false, 0);
    expect(visibility.showRunHint).toBe(true);
    expect(visibility.showIssueSections).toBe(false);
  });

  it("shows issue sections even when there are zero issues", () => {
    const report = {
      totalPasswords: 3,
      breached: [],
      weak: [],
      reused: [],
      old: [],
      unsecured: [],
      duplicate: [],
      expiring: [],
    };
    const totalIssues = calculateTotalIssues(report);
    const visibility = getWatchtowerVisibility(report, false, totalIssues);
    expect(totalIssues).toBe(0);
    expect(visibility.showIssueSections).toBe(true);
    expect(visibility.showNoIssuesCard).toBe(true);
  });
});

describe("calculateTotalIssues", () => {
  it("includes duplicate and expiring counts", () => {
    const report = {
      breached: [{ id: "1" }],
      weak: [],
      reused: [],
      old: [],
      unsecured: [],
      duplicate: [{ entries: [{ id: "a" }, { id: "b" }] }],
      expiring: [{ id: "x" }],
    };
    expect(calculateTotalIssues(report)).toBe(4); // 1 breached + 2 duplicate + 1 expiring
  });

  it("includes reused entry counts in total", () => {
    const report = {
      breached: [],
      weak: [],
      reused: [{ entries: [{ id: "a" }, { id: "b" }] }],
      old: [{ id: "o1" }],
      unsecured: [],
      duplicate: [],
      expiring: [],
    };
    expect(calculateTotalIssues(report)).toBe(3); // 2 reused + 1 old
  });
});

