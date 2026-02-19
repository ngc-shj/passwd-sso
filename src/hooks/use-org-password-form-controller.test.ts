// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { useOrgPasswordFormController } from "@/hooks/use-org-password-form-controller";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

const submitOrgPasswordFormMock = vi.fn();
const useOrgEntrySpecificFieldsPropsFromStateMock = vi.fn();
const useOrgPasswordFormDerivedMock = vi.fn();
const getOrgCardValidationStateMock = vi.fn();
const handleOrgCardNumberChangeMock = vi.fn();

vi.mock("@/components/org/org-password-form-actions", () => ({
  handleOrgCardNumberChange: (...args: unknown[]) => handleOrgCardNumberChangeMock(...args),
  submitOrgPasswordForm: (...args: unknown[]) => submitOrgPasswordFormMock(...args),
}));

vi.mock("@/hooks/use-org-entry-specific-fields-props", () => ({
  useOrgEntrySpecificFieldsPropsFromState: (...args: unknown[]) =>
    useOrgEntrySpecificFieldsPropsFromStateMock(...args),
}));

vi.mock("@/hooks/use-org-password-form-derived", () => ({
  useOrgPasswordFormDerived: (...args: unknown[]) => useOrgPasswordFormDerivedMock(...args),
}));

vi.mock("@/components/org/org-credit-card-validation", () => ({
  getOrgCardValidationState: (...args: unknown[]) => getOrgCardValidationStateMock(...args),
}));

describe("useOrgPasswordFormController", () => {
  beforeEach(() => {
    submitOrgPasswordFormMock.mockReset();
    useOrgEntrySpecificFieldsPropsFromStateMock.mockReset();
    useOrgPasswordFormDerivedMock.mockReset();
    getOrgCardValidationStateMock.mockReset();
    handleOrgCardNumberChangeMock.mockReset();

    useOrgEntrySpecificFieldsPropsFromStateMock.mockReturnValue({ kind: "props" });
    useOrgPasswordFormDerivedMock.mockReturnValue({ hasChanges: true, submitDisabled: false });
    getOrgCardValidationStateMock.mockReturnValue({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      lengthHint: "16",
      maxInputLength: 19,
      showLengthError: false,
      showLuhnError: false,
      cardNumberValid: true,
      hasBrandHint: true,
    });
  });

  it("returns derived state and entry-specific props", () => {
    const { result } = renderHook(() =>
      useOrgPasswordFormController({
        orgId: "org-1",
        onSaved: vi.fn(),
        isEdit: false,
        editData: null,
        effectiveEntryType: ENTRY_TYPE.LOGIN,
        entryKind: "password",
        isLoginEntry: true,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        t: (k) => k,
        ti: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        tpk: (k) => k,
        tGen: (k) => k,
        formState: buildFormState(),
        handleOpenChange: vi.fn(),
      }),
    );

    expect(result.current.hasChanges).toBe(true);
    expect(result.current.submitDisabled).toBe(false);
    expect(result.current.entrySpecificFieldsProps).toEqual({ kind: "props" });
  });

  it("delegates submit to submitOrgPasswordForm", async () => {
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();

    const { result } = renderHook(() =>
      useOrgPasswordFormController({
        orgId: "org-1",
        onSaved,
        isEdit: true,
        editData: { id: "entry-1", title: "t", username: null, password: "p", url: null, notes: null },
        effectiveEntryType: ENTRY_TYPE.LOGIN,
        entryKind: "password",
        isLoginEntry: true,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        t: (k) => k,
        ti: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        tpk: (k) => k,
        tGen: (k) => k,
        formState: buildFormState(),
        handleOpenChange,
      }),
    );

    await result.current.handleSubmit();

    expect(submitOrgPasswordFormMock).toHaveBeenCalledTimes(1);
    expect(submitOrgPasswordFormMock.mock.calls[0]?.[0]).toMatchObject({
      orgId: "org-1",
      isEdit: true,
      onSaved,
      handleOpenChange,
    });
  });

  it("delegates card number change through entry-specific callback", () => {
    renderHook(() =>
      useOrgPasswordFormController({
        orgId: "org-1",
        onSaved: vi.fn(),
        isEdit: false,
        editData: null,
        effectiveEntryType: ENTRY_TYPE.CREDIT_CARD,
        entryKind: "creditCard",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: true,
        isIdentity: false,
        isPasskey: false,
        t: (k) => k,
        ti: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        tpk: (k) => k,
        tGen: (k) => k,
        formState: buildFormState(),
        handleOpenChange: vi.fn(),
      }),
    );

    const propsArgs = useOrgEntrySpecificFieldsPropsFromStateMock.mock.calls[0]?.[0] as
      | { onCardNumberChange?: (value: string) => void }
      | undefined;
    expect(propsArgs?.onCardNumberChange).toBeTypeOf("function");

    propsArgs?.onCardNumberChange?.("4111 1111 1111 1111");

    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledTimes(1);
    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "4111 1111 1111 1111",
        brand: "visa",
        brandSource: "manual",
        setCardNumber: expect.any(Function),
        setBrand: expect.any(Function),
      }),
    );
  });
});

function buildFormState() {
  const state: OrgPasswordFormState = {
    values: {
      saving: false,
      cardNumber: "4242 4242 4242 4242",
      brand: "visa",
      brandSource: "manual",
      generatorSettings: {},
      title: "title",
      notes: "notes",
      selectedTags: [],
      orgFolderId: null,
      username: "user",
      password: "pass",
      url: "https://example.com",
      customFields: [],
      totp: null,
      showTotpInput: false,
      content: "",
      cardholderName: "",
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
      showCardNumber: false,
      showCvv: false,
      showPassword: false,
      showGenerator: false,
      showIdNumber: false,
      showCredentialId: false,
      dobError: null,
      expiryError: null,
    },
    setters: {
      setCardNumber: vi.fn(),
      setBrand: vi.fn(),
      setPassword: vi.fn(),
      setShowPassword: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setBrandSource: vi.fn(),
      setDateOfBirth: vi.fn(),
      setDobError: vi.fn(),
      setIssueDate: vi.fn(),
      setExpiryError: vi.fn(),
      setExpiryDate: vi.fn(),
      setShowGenerator: vi.fn(),
      setShowCardNumber: vi.fn(),
      setShowCvv: vi.fn(),
      setShowIdNumber: vi.fn(),
      setShowCredentialId: vi.fn(),
      setSaving: vi.fn(),
      setNotes: vi.fn(),
      setTitle: vi.fn(),
      setUsername: vi.fn(),
      setContent: vi.fn(),
      setUrl: vi.fn(),
      setSelectedTags: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setCardholderName: vi.fn(),
      setExpiryMonth: vi.fn(),
      setExpiryYear: vi.fn(),
      setCvv: vi.fn(),
      setFullName: vi.fn(),
      setAddress: vi.fn(),
      setPhone: vi.fn(),
      setEmail: vi.fn(),
      setNationality: vi.fn(),
      setIdNumber: vi.fn(),
      setRelyingPartyId: vi.fn(),
      setRelyingPartyName: vi.fn(),
      setCredentialId: vi.fn(),
      setCreationDate: vi.fn(),
      setDeviceInfo: vi.fn(),
      setOrgFolderId: vi.fn(),
    },
  };
  return state;
}
