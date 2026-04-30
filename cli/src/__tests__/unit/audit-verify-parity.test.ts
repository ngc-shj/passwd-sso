import { describe, it, expect } from "vitest";
import { computeTenantTag } from "../../commands/audit-verify";

describe("CLI <-> server parity (Batch 5 deviation mitigation)", () => {
  it("computeTenantTag matches server golden vector", () => {
    // Same input as src/lib/audit/anchor-manifest.unit.test.ts
    const tenantId = "550e8400-e29b-41d4-a716-446655440000";
    const tagSecret = Buffer.alloc(32, 0x42);  // 0x42 × 32
    const expected = "6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323";
    expect(computeTenantTag(tenantId, tagSecret)).toBe(expected);
  });
});
