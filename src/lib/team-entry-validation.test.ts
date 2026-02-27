import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { validateTeamEntryBeforeSubmit } from "@/lib/team-entry-validation";

describe("validateTeamEntryBeforeSubmit", () => {
  it("validates passkey required fields", () => {
    expect(
      validateTeamEntryBeforeSubmit({
        entryType: ENTRY_TYPE.PASSKEY,
        title: "t",
        password: "",
        relyingPartyId: "rp",
        cardNumberValid: true,
        dateOfBirth: "",
        issueDate: "",
        expiryDate: "",
      }).ok
    ).toBe(true);

    expect(
      validateTeamEntryBeforeSubmit({
        entryType: ENTRY_TYPE.PASSKEY,
        title: "t",
        password: "",
        relyingPartyId: "",
        cardNumberValid: true,
        dateOfBirth: "",
        issueDate: "",
        expiryDate: "",
      }).ok
    ).toBe(false);
  });

  it("validates identity date constraints", () => {
    const futureDob = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.IDENTITY,
      title: "id",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "2099-01-01",
      issueDate: "",
      expiryDate: "",
      todayIsoDate: "2026-02-18",
    });
    expect(futureDob.ok).toBe(false);
    expect(futureDob.dobFuture).toBe(true);

    const invalidRange = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.IDENTITY,
      title: "id",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "2026-02-20",
      expiryDate: "2026-02-19",
      todayIsoDate: "2026-02-18",
    });
    expect(invalidRange.ok).toBe(false);
    expect(invalidRange.expiryBeforeIssue).toBe(true);
  });

  it("validates login requires password", () => {
    const ok = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.LOGIN,
      title: "login",
      password: "pw",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
    });
    expect(ok.ok).toBe(true);

    const ng = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.LOGIN,
      title: "login",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
    });
    expect(ng.ok).toBe(false);
  });
});

