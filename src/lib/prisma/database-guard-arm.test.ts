import { describe, it, expect } from "vitest";
import { databaseGuardArm } from "./database-guard-arm";

const text = (guard: string, arm: string) =>
  `${guard}:${arm}: team_member_keys (team 00000000-0000-4000-8000-000000000001, user 00000000-0000-4000-8000-000000000002)`;

const adapterError = (message: string, originalCode = "23514") =>
  Object.assign(new Error("Invalid `prisma.teamMemberKey.upsert()` invocation"), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode, originalMessage: message } } },
  });

describe("databaseGuardArm", () => {
  it("reads the arm of the named guard from the nested adapter shape", () => {
    expect(databaseGuardArm(adapterError(text("ANY_GUARD", "some_arm")), "ANY_GUARD")).toBe("some_arm");
  });

  it("ignores another guard's prefix", () => {
    expect(databaseGuardArm(adapterError(text("OTHER_GUARD", "some_arm")), "ANY_GUARD")).toBeNull();
  });

  it("does not match a longer guard name that ends with the requested one", () => {
    expect(databaseGuardArm(adapterError(text("NOT_ANY_GUARD", "some_arm")), "ANY_GUARD")).toBeNull();
  });

  it("returns null for the guard's text under another SQLSTATE", () => {
    expect(databaseGuardArm(adapterError(text("ANY_GUARD", "some_arm"), "P0001"), "ANY_GUARD")).toBeNull();
  });

  it("reads the arm from a raw driver error", () => {
    const err = Object.assign(new Error(text("ANY_GUARD", "some_arm")), { code: "23514" });
    expect(databaseGuardArm(err, "ANY_GUARD")).toBe("some_arm");
  });

  it("returns null for another check_violation", () => {
    const err = Object.assign(new Error('new row violates check constraint "x"'), { code: "23514" });
    expect(databaseGuardArm(err, "ANY_GUARD")).toBeNull();
  });

  it("returns null for a non-error value", () => {
    expect(databaseGuardArm(null, "ANY_GUARD")).toBeNull();
    expect(databaseGuardArm("ANY_GUARD:some_arm:", "ANY_GUARD")).toBeNull();
  });
});
