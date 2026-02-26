// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgPasswordFormTranslations } from "@/hooks/entry-form-translations";
import { useOrgPasswordFormPresenter } from "@/hooks/use-team-password-form-presenter";
import type { OrgPasswordFormState } from "@/hooks/use-team-password-form-state";

const getOrgCardValidationStateMock = vi.fn();
const handleOrgCardNumberChangeMock = vi.fn();
const buildOrgEntrySpecificFieldsPropsFromStateMock = vi.fn();

vi.mock("@/components/team/team-credit-card-validation", () => ({
  getOrgCardValidationState: (...args: unknown[]) => getOrgCardValidationStateMock(...args),
}));

vi.mock("@/components/team/team-password-form-actions", () => ({
  handleOrgCardNumberChange: (...args: unknown[]) => handleOrgCardNumberChangeMock(...args),
}));

vi.mock("@/hooks/team-entry-specific-fields-props", () => ({
  buildOrgEntrySpecificFieldsPropsFromState: (...args: unknown[]) =>
    buildOrgEntrySpecificFieldsPropsFromStateMock(...args),
}));

describe("useOrgPasswordFormPresenter", () => {
  beforeEach(() => {
    getOrgCardValidationStateMock.mockReset();
    handleOrgCardNumberChangeMock.mockReset();
    buildOrgEntrySpecificFieldsPropsFromStateMock.mockReset();

    getOrgCardValidationStateMock.mockReturnValue({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      lengthHint: "16",
      maxInputLength: 19,
      showLengthError: false,
      showLuhnError: false,
      cardNumberValid: true,
      hasBrandHint: true,
    });
    buildOrgEntrySpecificFieldsPropsFromStateMock.mockReturnValue({ kind: "props" });
  });

  it("returns presenter payload with entry-specific props", () => {
    const { result } = renderHook(() =>
      useOrgPasswordFormPresenter({
        isEdit: false,
        entryKind: "password",
        translations: buildTranslations(),
        formState: buildFormState(),
      }),
    );

    expect(result.current.cardNumberValid).toBe(true);
    expect(result.current.entryValues.title).toBe("title");
    expect(result.current.entryValues.orgFolderId).toBeNull();
    expect(result.current.entrySpecificFieldsProps).toEqual({ kind: "props" });
    expect(result.current.entryCopy.dialogLabel).toBeDefined();
  });

  it("wires card number change callback through shared action helper", () => {
    renderHook(() =>
      useOrgPasswordFormPresenter({
        isEdit: false,
        entryKind: "creditCard",
        translations: buildTranslations(),
        formState: buildFormState(),
      }),
    );

    const presenterArgs = buildOrgEntrySpecificFieldsPropsFromStateMock.mock.calls[0]?.[0] as
      | { onCardNumberChange?: (value: string) => void }
      | undefined;
    expect(presenterArgs?.onCardNumberChange).toBeTypeOf("function");
    presenterArgs?.onCardNumberChange?.("4111 1111 1111 1111");

    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledTimes(1);
    expect(handleOrgCardNumberChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "4111 1111 1111 1111",
        brand: "visa",
        brandSource: "manual",
      }),
    );
  });
});

function buildFormState(): OrgPasswordFormState {
  return {
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
}

function buildTranslations(): OrgPasswordFormTranslations {
  return {
    t: (key) => key,
    tGen: (key) => key,
    tn: (key) => key,
    tcc: (key) => key,
    ti: (key) => key,
    tpk: (key) => key,
  };
}
