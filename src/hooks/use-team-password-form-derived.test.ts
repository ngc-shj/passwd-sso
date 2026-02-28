// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildTeamSubmitDisabled } from "@/hooks/team-password-form-derived-helpers";
import { useTeamPasswordFormDerived } from "@/hooks/use-team-password-form-derived";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import type { TeamEntryFieldValues } from "@/hooks/use-team-password-form-state";

function baseEntryKindState(): TeamEntryKindState {
  return {
    entryKind: "password",
    isLoginEntry: true,
    isNote: false,
    isCreditCard: false,
    isIdentity: false,
    isPasskey: false,
    isBankAccount: false,
    isSoftwareLicense: false,
  };
}

function baseEntryValues(): TeamEntryFieldValues {
  return {
    title: "Title",
    notes: "memo",
    selectedTags: [{ id: "t1", name: "tag", color: null }],
    teamFolderId: null,
    username: "user",
    password: "pass",
    url: "https://example.com",
    customFields: [],
    totp: null,
    content: "",
    cardholderName: "",
    cardNumber: "",
    brand: "",
    expiryMonth: "",
    expiryYear: "",
    cvv: "",
    fullName: "",
    address: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    idNumber: "",
    issueDate: "",
    expiryDate: "",
    relyingPartyId: "",
    relyingPartyName: "",
    credentialId: "",
    creationDate: "",
    deviceInfo: "",
    bankName: "",
    accountType: "",
    accountHolderName: "",
    accountNumber: "",
    routingNumber: "",
    swiftBic: "",
    iban: "",
    branchName: "",
    softwareName: "",
    licenseKey: "",
    version: "",
    licensee: "",
    purchaseDate: "",
    expirationDate: "",
    requireReprompt: false,
    expiresAt: null,
  };
}

function baseArgs() {
  return {
    effectiveEntryType: ENTRY_TYPE.LOGIN,
    editData: {
      id: "e1",
      entryType: ENTRY_TYPE.LOGIN,
      title: "Title",
      username: "user",
      password: "pass",
      url: "https://example.com",
      notes: "memo",
      tags: [{ id: "t1", name: "tag", color: null }],
      customFields: [],
      totp: null,
      teamFolderId: null,
    },
    entryKindState: baseEntryKindState(),
    entryValues: baseEntryValues(),
    cardNumberValid: true,
  };
}

describe("useTeamPasswordFormDerived", () => {
  it("hasChanges=false when current equals baseline", () => {
    const { result } = renderHook(() => useTeamPasswordFormDerived(baseArgs()));
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.submitDisabled).toBe(false);
  });

  it("hasChanges=true when title changes", () => {
    const args = baseArgs();
    args.entryValues.title = "Changed";

    const { result } = renderHook(() => useTeamPasswordFormDerived(args));
    expect(result.current.hasChanges).toBe(true);
  });

  it("submitDisabled=true when login password is empty", () => {
    const args = baseArgs();
    args.entryValues.password = "";

    const { result } = renderHook(() => useTeamPasswordFormDerived(args));
    expect(result.current.submitDisabled).toBe(true);
  });
});

describe("buildTeamSubmitDisabled", () => {
  it("returns false when all fields are valid for login", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: baseEntryKindState(),
      entryValues: { title: "Title", password: "pass", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });

  it("returns true when title is empty", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: baseEntryKindState(),
      entryValues: { title: "  ", password: "pass", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when passkey relyingPartyId is empty", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "passkey",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: true,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
      entryValues: { title: "PK", password: "", relyingPartyId: "  " },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when credit card number is invalid", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "creditCard",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: true,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
      entryValues: { title: "CC", password: "", relyingPartyId: "" },
      cardNumberValid: false,
    });
    expect(result).toBe(true);
  });

  it("returns false for secure note with only title", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "secureNote",
        isLoginEntry: false,
        isNote: true,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
      entryValues: { title: "Note", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });

  it("returns false for bank account with only title (password not required)", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "bankAccount",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: true,
        isSoftwareLicense: false,
      },
      entryValues: { title: "My Bank", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });

  it("returns true for bank account when title is empty", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "bankAccount",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: true,
        isSoftwareLicense: false,
      },
      entryValues: { title: "  ", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });

  it("returns false for software license with only title (password not required)", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "softwareLicense",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: true,
      },
      entryValues: { title: "License", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });

  it("returns true for software license when title is empty", () => {
    const result = buildTeamSubmitDisabled({
      entryKindState: {
        entryKind: "softwareLicense",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: true,
      },
      entryValues: { title: "", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });
});
