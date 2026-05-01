import { describe, it, expect } from "vitest";
import { computeTenantTag } from "../../commands/audit-verify";
import { AUDIT_ANCHOR_KID_PREFIX, AUDIT_ANCHOR_TYP } from "../../constants/audit-anchor.js";

// Canonical server-side values used as drift-detection baseline
const SERVER_AUDIT_ANCHOR_KID_PREFIX = "audit-anchor-";
const SERVER_AUDIT_ANCHOR_TYP = "passwd-sso.audit-anchor.v1";

describe("CLI computeTenantTag matches server golden vector (cross-implementation parity)", () => {
  it("computeTenantTag matches server golden vector", () => {
    // Same input as src/lib/audit/anchor-manifest.unit.test.ts
    const tenantId = "550e8400-e29b-41d4-a716-446655440000";
    const tagSecret = Buffer.alloc(32, 0x42);  // 0x42 × 32
    const expected = "6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323";
    expect(computeTenantTag(tenantId, tagSecret)).toBe(expected);
  });

  it("CLI constants match server canonical values (drift detection)", () => {
    expect(AUDIT_ANCHOR_KID_PREFIX).toBe(SERVER_AUDIT_ANCHOR_KID_PREFIX);
    expect(AUDIT_ANCHOR_TYP).toBe(SERVER_AUDIT_ANCHOR_TYP);
  });
});
