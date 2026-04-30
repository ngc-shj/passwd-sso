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
    // Target-self maps here because a user cannot be strictly above their
    // own role. This is the path the dialog UX relies on for hiding the
    // Approve button on the target's view.
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
    // Edge: actor is the initiator AND has equal role to target.
    // Initiator check fires first per the function order — the message the
    // dialog shows is the more specific "you initiated this" tooltip.
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
