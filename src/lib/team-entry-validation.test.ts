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
        purchaseDate: "",
        expirationDate: "",
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
        purchaseDate: "",
        expirationDate: "",
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
      purchaseDate: "",
      expirationDate: "",
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
      purchaseDate: "",
      expirationDate: "",
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
      purchaseDate: "",
      expirationDate: "",
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
      purchaseDate: "",
      expirationDate: "",
    });
    expect(ng.ok).toBe(false);
  });

  it("validates bank account requires title only", () => {
    const ok = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "My Bank",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "",
      expirationDate: "",
    });
    expect(ok.ok).toBe(true);

    const ng = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "",
      expirationDate: "",
    });
    expect(ng.ok).toBe(false);
  });

  it("validates software license requires title", () => {
    const ok = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "",
      expirationDate: "",
    });
    expect(ok.ok).toBe(true);

    const ng = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "",
      expirationDate: "",
    });
    expect(ng.ok).toBe(false);
  });

  it("validates software license expirationDate must be after purchaseDate", () => {
    const invalid = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "2026-06-01",
      expirationDate: "2026-05-01",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.expirationBeforePurchase).toBe(true);

    const sameDateInvalid = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "2026-06-01",
      expirationDate: "2026-06-01",
    });
    expect(sameDateInvalid.ok).toBe(false);
    expect(sameDateInvalid.expirationBeforePurchase).toBe(true);

    const valid = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "2026-01-01",
      expirationDate: "2027-01-01",
    });
    expect(valid.ok).toBe(true);
    expect(valid.expirationBeforePurchase).toBe(false);
  });

  it("validates software license ok when dates are missing", () => {
    const noDates = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "",
      expirationDate: "",
    });
    expect(noDates.ok).toBe(true);
    expect(noDates.expirationBeforePurchase).toBe(false);

    const onlyPurchase = validateTeamEntryBeforeSubmit({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "License",
      password: "",
      relyingPartyId: "",
      cardNumberValid: true,
      dateOfBirth: "",
      issueDate: "",
      expiryDate: "",
      purchaseDate: "2026-01-01",
      expirationDate: "",
    });
    expect(onlyPurchase.ok).toBe(true);
  });
});

