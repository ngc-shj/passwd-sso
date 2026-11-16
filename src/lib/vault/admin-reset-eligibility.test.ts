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
        initiatorAuthorized: true,
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
        initiatorAuthorized: true,
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
        initiatorAuthorized: true,
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
        initiatorAuthorized: true,
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
        initiatorAuthorized: true,
      }),
    ).toBe("initiator");
  });

  it("returns 'initiator_unauthorized' when the initiator no longer holds the authority", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "OWNER",
        targetRole: "MEMBER",
        initiatedById: B,
        initiatorAuthorized: false,
      }),
    ).toBe("initiator_unauthorized");
  });

  it("insufficient_role wins over initiator_unauthorized", () => {
    expect(
      computeApproveEligibility({
        actorId: A,
        actorRole: "ADMIN",
        targetRole: "ADMIN",
        initiatedById: B,
        initiatorAuthorized: false,
      }),
    ).toBe("insufficient_role");
  });
});
