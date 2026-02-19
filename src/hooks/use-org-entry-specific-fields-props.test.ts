// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOrgEntrySpecificFieldsPropsFromState } from "@/hooks/use-org-entry-specific-fields-props";
import type {
  OrgPasswordFormValues,
  OrgPasswordFormSettersState,
} from "@/hooks/use-org-password-form-state";

describe("useOrgEntrySpecificFieldsPropsFromState", () => {
  it("sets brand and switches source to manual on brand change", () => {
    const { values, setters } = createState();
    const { result } = renderHook(() =>
      useOrgEntrySpecificFieldsPropsFromState({
        entryKind: "creditCard",
        entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
        t: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        ti: (k) => k,
        tpk: (k) => k,
        values,
        setters,
        generatorSummary: "summary",
        onCardNumberChange: vi.fn(),
        maxInputLength: 19,
        showLengthError: false,
        showLuhnError: false,
        detectedBrand: undefined,
        hasBrandHint: false,
        lengthHint: "16",
      }),
    );

    result.current.onBrandChange("Visa");
    expect(setters.setBrand).toHaveBeenCalledWith("Visa");
    expect(setters.setBrandSource).toHaveBeenCalledWith("manual");
  });

  it("clears identity errors when date fields change", () => {
    const { values, setters } = createState();
    const { result } = renderHook(() =>
      useOrgEntrySpecificFieldsPropsFromState({
        entryKind: "identity",
        entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
        t: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        ti: (k) => k,
        tpk: (k) => k,
        values,
        setters,
        generatorSummary: "summary",
        onCardNumberChange: vi.fn(),
        maxInputLength: 19,
        showLengthError: false,
        showLuhnError: false,
        detectedBrand: undefined,
        hasBrandHint: false,
        lengthHint: "16",
      }),
    );

    result.current.onDateOfBirthChange("2000-01-01");
    expect(setters.setDateOfBirth).toHaveBeenCalledWith("2000-01-01");
    expect(setters.setDobError).toHaveBeenCalledWith(null);

    result.current.onIssueDateChange("2020-01-01");
    expect(setters.setIssueDate).toHaveBeenCalledWith("2020-01-01");
    expect(setters.setExpiryError).toHaveBeenCalledWith(null);

    result.current.onExpiryDateChange("2030-01-01");
    expect(setters.setExpiryDate).toHaveBeenCalledWith("2030-01-01");
    expect(setters.setExpiryError).toHaveBeenCalledWith(null);
  });
});

function createState(): {
  values: OrgPasswordFormValues;
  setters: OrgPasswordFormSettersState;
} {
  return {
    values: {
      saving: false,
      showPassword: false,
      showGenerator: false,
      showCardNumber: false,
      showCvv: false,
      showIdNumber: false,
      showCredentialId: false,
      title: "",
      username: "",
      password: "",
      content: "",
      url: "",
      notes: "",
      selectedTags: [],
      generatorSettings: {} as OrgPasswordFormValues["generatorSettings"],
      customFields: [],
      totp: null,
      showTotpInput: false,
      cardholderName: "",
      cardNumber: "",
      brand: "",
      brandSource: "auto",
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
      dobError: null,
      expiryError: null,
      relyingPartyId: "",
      relyingPartyName: "",
      credentialId: "",
      creationDate: "",
      deviceInfo: "",
      orgFolderId: null,
    },
    setters: {
      setSaving: vi.fn(),
      setShowPassword: vi.fn(),
      setShowGenerator: vi.fn(),
      setShowCardNumber: vi.fn(),
      setShowCvv: vi.fn(),
      setShowIdNumber: vi.fn(),
      setShowCredentialId: vi.fn(),
      setTitle: vi.fn(),
      setUsername: vi.fn(),
      setPassword: vi.fn(),
      setContent: vi.fn(),
      setUrl: vi.fn(),
      setNotes: vi.fn(),
      setSelectedTags: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setCardholderName: vi.fn(),
      setCardNumber: vi.fn(),
      setBrand: vi.fn(),
      setBrandSource: vi.fn(),
      setExpiryMonth: vi.fn(),
      setExpiryYear: vi.fn(),
      setCvv: vi.fn(),
      setFullName: vi.fn(),
      setAddress: vi.fn(),
      setPhone: vi.fn(),
      setEmail: vi.fn(),
      setDateOfBirth: vi.fn(),
      setNationality: vi.fn(),
      setIdNumber: vi.fn(),
      setIssueDate: vi.fn(),
      setExpiryDate: vi.fn(),
      setDobError: vi.fn(),
      setExpiryError: vi.fn(),
      setRelyingPartyId: vi.fn(),
      setRelyingPartyName: vi.fn(),
      setCredentialId: vi.fn(),
      setCreationDate: vi.fn(),
      setDeviceInfo: vi.fn(),
      setOrgFolderId: vi.fn(),
    },
  };
}
