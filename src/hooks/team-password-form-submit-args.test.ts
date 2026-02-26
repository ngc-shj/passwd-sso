import { describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgSubmitArgs } from "@/hooks/team-password-form-submit-args";

function buildDefaultParams(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    onSaved: vi.fn(),
    isEdit: false,
    editData: undefined,
    effectiveEntryType: ENTRY_TYPE.LOGIN,
    entryKindState: {
      entryKind: "login" as const,
      isLoginEntry: true,
      isNote: false,
      isCreditCard: false,
      isIdentity: false,
      isPasskey: false,
    },
    translations: {
      t: (key: string) => `pf.${key}`,
      tGen: (key: string) => key,
      tn: (key: string) => key,
      tcc: (key: string) => key,
      ti: (key: string) => `identity.${key}`,
      tpk: (key: string) => key,
    },
    handleOpenChange: vi.fn(),
    setters: { setDobError: vi.fn(), setExpiryError: vi.fn(), setSaving: vi.fn() },
    entryValues: {
      title: "title", notes: "notes", selectedTags: [], orgFolderId: null,
      username: "user", password: "pass", url: "https://example.com",
      customFields: [], totp: null, content: "",
      cardholderName: "", cardNumber: "", brand: "",
      expiryMonth: "", expiryYear: "", cvv: "",
      fullName: "", address: "", phone: "", email: "",
      dateOfBirth: "", nationality: "", idNumber: "",
      issueDate: "", expiryDate: "",
      relyingPartyId: "", relyingPartyName: "", credentialId: "",
      creationDate: "", deviceInfo: "",
      generatorSettings: {},
    },
    cardNumberValid: true,
    ...overrides,
  };
}

describe("buildOrgSubmitArgs", () => {
  it("maps login entry type correctly", () => {
    const args = buildOrgSubmitArgs(buildDefaultParams() as Parameters<typeof buildOrgSubmitArgs>[0]);
    expect(args.effectiveEntryType).toBe(ENTRY_TYPE.LOGIN);
    expect(args.isIdentity).toBe(false);
    expect(args.title).toBe("title");
    expect(args.username).toBe("user");
  });

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

  it("sets isEdit and editData for edit mode", () => {
    const editData = { id: "e-1", title: "old", username: "u", password: "p", url: null, notes: null };
    const args = buildOrgSubmitArgs(buildDefaultParams({
      isEdit: true,
      editData,
    }) as Parameters<typeof buildOrgSubmitArgs>[0]);
    expect(args.isEdit).toBe(true);
    expect(args.editData).toBe(editData);
  });

  it("passes cardNumberValid through", () => {
    const args = buildOrgSubmitArgs(buildDefaultParams({
      cardNumberValid: false,
    }) as Parameters<typeof buildOrgSubmitArgs>[0]);
    expect(args.cardNumberValid).toBe(false);
  });

  it("maps credit card entry type", () => {
    const args = buildOrgSubmitArgs(buildDefaultParams({
      effectiveEntryType: ENTRY_TYPE.CREDIT_CARD,
      entryKindState: {
        entryKind: "creditCard",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: true,
        isIdentity: false,
        isPasskey: false,
      },
    }) as Parameters<typeof buildOrgSubmitArgs>[0]);
    expect(args.effectiveEntryType).toBe(ENTRY_TYPE.CREDIT_CARD);
    expect(args.isIdentity).toBe(false);
  });

  it("maps secure note entry type", () => {
    const args = buildOrgSubmitArgs(buildDefaultParams({
      effectiveEntryType: ENTRY_TYPE.SECURE_NOTE,
      entryKindState: {
        entryKind: "secureNote",
        isLoginEntry: false,
        isNote: true,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
      },
    }) as Parameters<typeof buildOrgSubmitArgs>[0]);
    expect(args.effectiveEntryType).toBe(ENTRY_TYPE.SECURE_NOTE);
    expect(args.isIdentity).toBe(false);
  });
});
