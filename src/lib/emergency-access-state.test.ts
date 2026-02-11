import { describe, it, expect } from "vitest";
import { canTransition } from "./emergency-access-state";

describe("canTransition", () => {
  // STALE-specific transitions
  it("allows IDLE → STALE", () => {
    expect(canTransition("IDLE", "STALE")).toBe(true);
  });

  it("allows ACTIVATED → STALE", () => {
    expect(canTransition("ACTIVATED", "STALE")).toBe(true);
  });

  it("allows STALE → IDLE (re-confirm)", () => {
    expect(canTransition("STALE", "IDLE")).toBe(true);
  });

  it("allows STALE → REVOKED", () => {
    expect(canTransition("STALE", "REVOKED")).toBe(true);
  });

  it("does not allow STALE → REQUESTED", () => {
    expect(canTransition("STALE", "REQUESTED")).toBe(false);
  });

  it("does not allow STALE → ACTIVATED", () => {
    expect(canTransition("STALE", "ACTIVATED")).toBe(false);
  });

  it("does not allow STALE → ACCEPTED", () => {
    expect(canTransition("STALE", "ACCEPTED")).toBe(false);
  });

  // Existing transitions (regression)
  it("allows PENDING → ACCEPTED", () => {
    expect(canTransition("PENDING", "ACCEPTED")).toBe(true);
  });

  it("allows ACCEPTED → IDLE", () => {
    expect(canTransition("ACCEPTED", "IDLE")).toBe(true);
  });

  it("allows IDLE → REQUESTED", () => {
    expect(canTransition("IDLE", "REQUESTED")).toBe(true);
  });

  it("allows REQUESTED → ACTIVATED", () => {
    expect(canTransition("REQUESTED", "ACTIVATED")).toBe(true);
  });

  it("does not allow REVOKED → any", () => {
    expect(canTransition("REVOKED", "IDLE")).toBe(false);
    expect(canTransition("REVOKED", "STALE")).toBe(false);
  });

  it("does not allow REJECTED → any", () => {
    expect(canTransition("REJECTED", "IDLE")).toBe(false);
    expect(canTransition("REJECTED", "STALE")).toBe(false);
  });
});
