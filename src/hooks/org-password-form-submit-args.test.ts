import { describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgSubmitArgs } from "@/hooks/org-password-form-submit-args";

describe("buildOrgSubmitArgs", () => {
  it("maps entry values and identity error messages", () => {
    const setDobError = vi.fn();
    const setExpiryError = vi.fn();
    const setSaving = vi.fn();
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    const args = buildOrgSubmitArgs({
      orgId: "org-1",
      onSaved,
      isEdit: true,
      editData: {
        id: "entry-1",
        title: "old",
        username: "u",
        password: "p",
        url: null,
        notes: null,
      },
      effectiveEntryType: ENTRY_TYPE.IDENTITY,
      entryKindState: {
        entryKind: "identity",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: true,
        isPasskey: false,
      },
      translations: {
        t: (key) => `pf.${key}`,
        tGen: (key) => key,
        tn: (key) => key,
        tcc: (key) => key,
        ti: (key) => `identity.${key}`,
        tpk: (key) => key,
      },
      handleOpenChange,
      setters: { setDobError, setExpiryError, setSaving },
      entryValues: {
        title: "title",
        notes: "notes",
        selectedTags: [],
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
        generatorSettings: {},
      },
      cardNumberValid: true,
    });

    expect(args.orgId).toBe("org-1");
    expect(args.isIdentity).toBe(true);
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.identityErrorCopy).toEqual({
      dobFuture: "identity.dobFuture",
      expiryBeforeIssue: "identity.expiryBeforeIssue",
    });
    expect(args.setDobError).toBe(setDobError);
    expect(args.setExpiryError).toBe(setExpiryError);
    expect(args.setSaving).toBe(setSaving);
    expect(args.handleOpenChange).toBe(handleOpenChange);
    expect(args.onSaved).toBe(onSaved);
    expect(args.t("saved")).toBe("pf.saved");
  });
});
