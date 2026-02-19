import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgPasswordDerivedArgs } from "@/hooks/org-password-form-derived-args";

describe("buildOrgPasswordDerivedArgs", () => {
  it("maps entry values and form flags into derived args", () => {
    const args = buildOrgPasswordDerivedArgs({
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      editData: {
        id: "entry-1",
        entryType: ENTRY_TYPE.LOGIN,
        title: "title",
        username: null,
        password: "pass",
        url: null,
        notes: null,
      },
      isLoginEntry: true,
      isNote: false,
      isCreditCard: false,
      isIdentity: false,
      isPasskey: false,
      values: createValues(),
      cardNumberValid: true,
    });

    expect(args.effectiveEntryType).toBe(ENTRY_TYPE.LOGIN);
    expect(args.editData?.id).toBe("entry-1");
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.orgFolderId).toBe("folder-1");
    expect(args.cardNumberValid).toBe(true);
  });
});

function createValues() {
  return {
    title: "title",
    notes: "notes",
    selectedTags: [],
    orgFolderId: "folder-1",
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
