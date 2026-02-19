// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";

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
    isLoginEntry: true,
    isNote: false,
    isCreditCard: false,
    isIdentity: false,
    isPasskey: false,
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
    args.title = "Changed";

    const { result } = renderHook(() => useOrgPasswordFormDerived(args));
    expect(result.current.hasChanges).toBe(true);
  });

  it("submitDisabled=true when login password is empty", () => {
    const args = baseArgs();
    args.password = "";

    const { result } = renderHook(() => useOrgPasswordFormDerived(args));
    expect(result.current.submitDisabled).toBe(true);
  });
});
