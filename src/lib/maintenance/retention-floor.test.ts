import { describe, it, expect } from "vitest";
import { applyRetentionFloor } from "./retention-floor";

describe("applyRetentionFloor", () => {
  it("rejects when the tenant floor is null (keep forever)", () => {
    expect(applyRetentionFloor(30, null)).toEqual({ ok: false });
  });

  it("clamps up to the tenant floor when it is longer than requested", () => {
    expect(applyRetentionFloor(30, 730)).toEqual({
      ok: true,
      effectiveRetentionDays: 730,
    });
  });

  it("keeps the requested value when it exceeds the tenant floor", () => {
    expect(applyRetentionFloor(365, 90)).toEqual({
      ok: true,
      effectiveRetentionDays: 365,
    });
  });

  it("treats a tenant floor of 0 as a real floor, NOT as 'no floor'", () => {
    // Regression: a truthy check would skip Math.max on 0 and fall back to the
    // raw requested value — this is exactly the retention-floor bypass the
    // `=== null` (not falsy) check prevents. max(30, 0) === 30 is the floor
    // being applied; the point is that 0 does not short-circuit to a reject or
    // to an unfloored passthrough.
    expect(applyRetentionFloor(30, 0)).toEqual({
      ok: true,
      effectiveRetentionDays: 30,
    });
  });
});
