import { describe, it, expect } from "vitest";
import { computeApproveEligibility } from "./admin-reset-eligibility";

const A = "actor-id";
const B = "other-id";

describe("computeApproveEligibility", () => {
  it("returns 'initiator' when actor minted the reset", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "OWNER",
        targetRole: "MEMBER",
        initiatedById: A,
      }),
    ).toBe("initiator");
  });

  it("returns 'insufficient_role' when actor.role is not above target.role (same role)", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "ADMIN",
        targetRole: "ADMIN",
        initiatedById: B,
      }),
    ).toBe("insufficient_role");
  });

  it("returns 'insufficient_role' when actor is the target (covers target-self)", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "ADMIN",
        targetRole: "ADMIN",
        initiatedById: B,
      }),
    ).toBe("insufficient_role");
  });

  it("returns 'eligible' for distinct actor with role above target", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "OWNER",
        targetRole: "ADMIN",
        initiatedById: B,
      }),
    ).toBe("eligible");
  });

  it("initiator wins over insufficient_role when both apply", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "ADMIN",
        targetRole: "ADMIN",
        initiatedById: A,
      }),
    ).toBe("initiator");
  });
});
