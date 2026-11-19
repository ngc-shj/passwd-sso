import { describe, it, expect } from "vitest";
import { databaseGuardError, teamKeyRecipientGuardError } from "@/__tests__/helpers/database-guard-error";
import {
  isTeamKeyRecipientChanged,
  TEAM_KEY_RECIPIENT_GUARD_ARM,
  teamKeyRecipientGuardArm,
} from "./team-key-recipient-guard";

const ARMS = Object.values(TEAM_KEY_RECIPIENT_GUARD_ARM);

describe("teamKeyRecipientGuardArm", () => {
  it.each(ARMS)("reads the %s arm from the nested adapter shape", (arm) => {
    expect(teamKeyRecipientGuardArm(teamKeyRecipientGuardError(arm))).toBe(arm);
  });

  it("returns null for the departed-member guard's refusal", () => {
    expect(teamKeyRecipientGuardArm(databaseGuardError("DEPARTED_MEMBER_GUARD", "key_inactive"))).toBeNull();
  });
});

describe("isTeamKeyRecipientChanged", () => {
  it.each([
    TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_KEY_CHANGED,
    TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_NO_KEY,
  ])("is true for %s", (arm) => {
    expect(isTeamKeyRecipientChanged(teamKeyRecipientGuardError(arm))).toBe(true);
  });

  it.each(
    ARMS.filter(
      (arm) =>
        arm !== TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_KEY_CHANGED &&
        arm !== TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_NO_KEY,
    ),
  )("is false for %s", (arm) => {
    expect(isTeamKeyRecipientChanged(teamKeyRecipientGuardError(arm))).toBe(false);
  });

  it("is false for an unrelated error", () => {
    expect(isTeamKeyRecipientChanged(new Error("boom"))).toBe(false);
  });
});
