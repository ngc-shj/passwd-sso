// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamPasswordFormTranslations } from "@/hooks/entry-form-translations";
import { useTeamPasswordFormPresenter } from "@/hooks/use-team-password-form-presenter";
import type { TeamPasswordFormState } from "@/hooks/use-team-password-form-state";

const getTeamCardValidationStateMock = vi.fn();
const handleTeamCardNumberChangeMock = vi.fn();
const buildTeamEntrySpecificFieldsPropsFromStateMock = vi.fn();

vi.mock("@/components/team/team-credit-card-validation", () => ({
  getTeamCardValidationState: (...args: unknown[]) => getTeamCardValidationStateMock(...args),
}));

vi.mock("@/components/team/team-password-form-actions", () => ({
  handleTeamCardNumberChange: (...args: unknown[]) => handleTeamCardNumberChangeMock(...args),
}));

vi.mock("@/hooks/team-entry-specific-fields-props", () => ({
  buildTeamEntrySpecificFieldsPropsFromState: (...args: unknown[]) =>
    buildTeamEntrySpecificFieldsPropsFromStateMock(...args),
}));

describe("useTeamPasswordFormPresenter", () => {
  beforeEach(() => {
    getTeamCardValidationStateMock.mockReset();
    handleTeamCardNumberChangeMock.mockReset();
    buildTeamEntrySpecificFieldsPropsFromStateMock.mockReset();

    getTeamCardValidationStateMock.mockReturnValue({
      cardValidation: { detectedBrand: "Visa", digits: "4242" },
      lengthHint: "16",
      maxInputLength: 19,
      showLengthError: false,
      showLuhnError: false,
      cardNumberValid: true,
      hasBrandHint: true,
    });
    buildTeamEntrySpecificFieldsPropsFromStateMock.mockReturnValue({ kind: "props" });
  });

  it("returns presenter payload with entry-specific props", () => {
    const { result } = renderHook(() =>
      useTeamPasswordFormPresenter({
        isEdit: false,
        entryKind: "password",
        translations: buildTranslations(),
        formState: buildFormState(),
      }),
    );

    expect(result.current.cardNumberValid).toBe(true);
    expect(result.current.entryValues.title).toBe("title");
    expect(result.current.entryValues.teamFolderId).toBeNull();
    expect(result.current.entrySpecificFieldsProps).toEqual({ kind: "props" });
    expect(result.current.entryCopy.dialogLabel).toBeDefined();
  });

  it("wires card number change callback through shared action helper", () => {
    renderHook(() =>
      useTeamPasswordFormPresenter({
        isEdit: false,
        entryKind: "creditCard",
        translations: buildTranslations(),
        formState: buildFormState(),
      }),
    );

    const presenterArgs = buildTeamEntrySpecificFieldsPropsFromStateMock.mock.calls[0]?.[0] as
      | { onCardNumberChange?: (value: string) => void }
      | undefined;
    expect(presenterArgs?.onCardNumberChange).toBeTypeOf("function");
    presenterArgs?.onCardNumberChange?.("4111 1111 1111 1111");

    expect(handleTeamCardNumberChangeMock).toHaveBeenCalledTimes(1);
    expect(handleTeamCardNumberChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "4111 1111 1111 1111",
        brand: "visa",
        brandSource: "manual",
      }),
    );
  });
});

function buildFormState(): TeamPasswordFormState {
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
      teamFolderId: null,
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
      showAccountNumber: false,
      showRoutingNumber: false,
      showLicenseKey: false,
      dobError: null,
      expiryError: null,
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
      setBankName: vi.fn(),
      setAccountType: vi.fn(),
      setAccountHolderName: vi.fn(),
      setAccountNumber: vi.fn(),
      setShowAccountNumber: vi.fn(),
      setRoutingNumber: vi.fn(),
      setShowRoutingNumber: vi.fn(),
      setSwiftBic: vi.fn(),
      setIban: vi.fn(),
      setBranchName: vi.fn(),
      setSoftwareName: vi.fn(),
      setLicenseKey: vi.fn(),
      setShowLicenseKey: vi.fn(),
      setVersion: vi.fn(),
      setLicensee: vi.fn(),
      setPurchaseDate: vi.fn(),
      setExpirationDate: vi.fn(),
      setRequireReprompt: vi.fn(),
      setExpiresAt: vi.fn(),
      setTeamFolderId: vi.fn(),
    },
  };
}

function buildTranslations(): TeamPasswordFormTranslations {
  return {
    t: (key) => key,
    tGen: (key) => key,
    tn: (key) => key,
    tcc: (key) => key,
    ti: (key) => key,
    tpk: (key) => key,
    tba: (key) => key,
    tsl: (key) => key,
  };
}
