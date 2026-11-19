import { describe, it, expect } from "vitest";
import { departedMemberGuardArm } from "./departed-member-guard";

const GUARD_TEXT = "DEPARTED_MEMBER_GUARD:key_inactive: team_member_keys (tenant 00000000-0000-4000-8000-000000000001, user 00000000-0000-4000-8000-000000000002)";

describe("departedMemberGuardArm", () => {
  it("reads the arm from a Prisma error wrapping the driver's check_violation", () => {
    const err = Object.assign(new Error("Invalid `tx.teamMemberKey.upsert()` invocation"), {
      meta: { driverAdapterError: { cause: { originalCode: "23514", originalMessage: GUARD_TEXT } } },
    });
    expect(departedMemberGuardArm(err)).toBe("key_inactive");
  });

  it("reads the arm from a raw driver error", () => {
    expect(departedMemberGuardArm(Object.assign(new Error(GUARD_TEXT), { code: "23514" }))).toBe("key_inactive");
  });

  it("returns null for another check_violation", () => {
    const err = Object.assign(new Error('new row violates check constraint "users_not_system_tenant"'), { code: "23514" });
    expect(departedMemberGuardArm(err)).toBeNull();
  });

  it("returns null for the guard's text under another SQLSTATE", () => {
    expect(departedMemberGuardArm(Object.assign(new Error(GUARD_TEXT), { code: "P0001" }))).toBeNull();
  });
});
