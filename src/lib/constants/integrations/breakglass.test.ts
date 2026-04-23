import { describe, expect, it } from "vitest";
import { GRANT_STATUS } from "@/lib/constants/integrations/breakglass";
import type { GrantStatus } from "@/lib/constants/integrations/breakglass";

describe("breakglass constants", () => {
  it("GRANT_STATUS has all 3 values: active, expired, revoked", () => {
    const values = Object.values(GRANT_STATUS);
    expect(values).toHaveLength(3);
    expect(values).toContain("active");
    expect(values).toContain("expired");
    expect(values).toContain("revoked");
  });

  it("GrantStatus type matches GRANT_STATUS values", () => {
    // Verify each GRANT_STATUS value is assignable as GrantStatus at runtime
    const active: GrantStatus = GRANT_STATUS.ACTIVE;
    const expired: GrantStatus = GRANT_STATUS.EXPIRED;
    const revoked: GrantStatus = GRANT_STATUS.REVOKED;

    expect(active).toBe("active");
    expect(expired).toBe("expired");
    expect(revoked).toBe("revoked");
  });

  it("GRANT_STATUS keys are uppercase and values are lowercase", () => {
    for (const [key, value] of Object.entries(GRANT_STATUS)) {
      expect(key).toBe(key.toUpperCase());
      expect(value).toBe(value.toLowerCase());
    }
  });
});
