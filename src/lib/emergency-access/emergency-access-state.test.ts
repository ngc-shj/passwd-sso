import { describe, it, expect } from "vitest";
import { canTransition } from "./emergency-access-state";
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
