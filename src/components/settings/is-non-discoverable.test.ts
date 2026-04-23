import { describe, it, expect } from "vitest";
import { isNonDiscoverable } from "./security/passkey-credentials-card";

describe("isNonDiscoverable", () => {
  // credProps.rk available (discoverable is not null)
  it("returns true when discoverable is false", () => {
    expect(isNonDiscoverable({ discoverable: false, deviceType: "multiDevice", backedUp: true })).toBe(true);
  });

  it("returns false when discoverable is true", () => {
    expect(isNonDiscoverable({ discoverable: true, deviceType: "singleDevice", backedUp: false })).toBe(false);
  });

  // credProps.rk not available (discoverable is null) — falls back to heuristic
  it("returns true when null + singleDevice + not backed up", () => {
    expect(isNonDiscoverable({ discoverable: null, deviceType: "singleDevice", backedUp: false })).toBe(true);
  });

  it("returns false when null + singleDevice + backed up", () => {
    expect(isNonDiscoverable({ discoverable: null, deviceType: "singleDevice", backedUp: true })).toBe(false);
  });

  it("returns false when null + multiDevice + not backed up", () => {
    expect(isNonDiscoverable({ discoverable: null, deviceType: "multiDevice", backedUp: false })).toBe(false);
  });

  it("returns false when null + multiDevice + backed up", () => {
    expect(isNonDiscoverable({ discoverable: null, deviceType: "multiDevice", backedUp: true })).toBe(false);
  });
});
