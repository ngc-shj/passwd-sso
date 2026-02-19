// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgSubmitDisabled } from "@/hooks/org-password-form-derived-helpers";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";

function baseEntryKindState(): OrgEntryKindState {
  return {
    entryKind: "password",
    isLoginEntry: true,
    isNote: false,
    isCreditCard: false,
    isIdentity: false,
    isPasskey: false,
  };
}

function baseEntryValues(): OrgEntryFieldValues {
  return {
    title: "Title",
    notes: "memo",
    selectedTags: [{ id: "t1", name: "tag", color: null }],
    orgFolderId: null,
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
      orgFolderId: null,
    },
    entryKindState: baseEntryKindState(),
    entryValues: baseEntryValues(),
    cardNumberValid: true,
  };
}

describe("useOrgPasswordFormDerived", () => {
  it("hasChanges=false when current equals baseline", () => {
    const { result } = renderHook(() => useOrgPasswordFormDerived(baseArgs()));
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.submitDisabled).toBe(false);
  });

  it("hasChanges=true when title changes", () => {
    const args = baseArgs();
    args.entryValues.title = "Changed";

    const { result } = renderHook(() => useOrgPasswordFormDerived(args));
    expect(result.current.hasChanges).toBe(true);
  });

  it("submitDisabled=true when login password is empty", () => {
    const args = baseArgs();
    args.entryValues.password = "";

    const { result } = renderHook(() => useOrgPasswordFormDerived(args));
    expect(result.current.submitDisabled).toBe(true);
  });
});

describe("buildOrgSubmitDisabled", () => {
  it("returns false when all fields are valid for login", () => {
    const result = buildOrgSubmitDisabled({
      entryKindState: baseEntryKindState(),
      entryValues: { title: "Title", password: "pass", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });

  it("returns true when title is empty", () => {
    const result = buildOrgSubmitDisabled({
      entryKindState: baseEntryKindState(),
      entryValues: { title: "  ", password: "pass", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when passkey relyingPartyId is empty", () => {
    const result = buildOrgSubmitDisabled({
      entryKindState: {
        entryKind: "passkey",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: true,
      },
      entryValues: { title: "PK", password: "", relyingPartyId: "  " },
      cardNumberValid: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when credit card number is invalid", () => {
    const result = buildOrgSubmitDisabled({
      entryKindState: {
        entryKind: "creditCard",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: true,
        isIdentity: false,
        isPasskey: false,
      },
      entryValues: { title: "CC", password: "", relyingPartyId: "" },
      cardNumberValid: false,
    });
    expect(result).toBe(true);
  });

  it("returns false for secure note with only title", () => {
    const result = buildOrgSubmitDisabled({
      entryKindState: {
        entryKind: "secureNote",
        isLoginEntry: false,
        isNote: true,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
      },
      entryValues: { title: "Note", password: "", relyingPartyId: "" },
      cardNumberValid: true,
    });
    expect(result).toBe(false);
  });
});
