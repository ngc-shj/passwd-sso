// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildOrgEntrySpecificFieldsBuilderArgsFromState,
  useOrgEntrySpecificFieldsPropsFromState,
} from "@/hooks/use-org-entry-specific-fields-props";
import { buildOrgEntrySpecificCallbacks } from "@/hooks/org-entry-specific-fields-callbacks";
import type {
  OrgPasswordFormValues,
  OrgPasswordFormSettersState,
} from "@/hooks/use-org-password-form-state";

describe("useOrgEntrySpecificFieldsPropsFromState", () => {
  it("builds complete builder args from state and callbacks", () => {
    const { values, setters } = createState();
    values.title = "Entry";
    values.brand = "Visa";
    const onCardNumberChange = vi.fn();
    const callbacks = buildOrgEntrySpecificCallbacks(values, setters);

    const args = buildOrgEntrySpecificFieldsBuilderArgsFromState({
      entryKind: "creditCard",
      entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
      translations: {
        t: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        ti: (k) => k,
        tpk: (k) => k,
      },
      values,
      callbacks,
      generatorSummary: "summary",
      onCardNumberChange,
      maxInputLength: 19,
      showLengthError: false,
      showLuhnError: false,
      detectedBrand: "visa",
      hasBrandHint: true,
      lengthHint: "16",
    });

    expect(args.title).toBe("Entry");
    expect(args.brand).toBe("Visa");
    expect(args.onCardNumberChange).toBe(onCardNumberChange);
    expect(args.onBrandChange).toBe(callbacks.onBrandChange);
    expect(args.detectedBrand).toBe("visa");
    expect(args.hasBrandHint).toBe(true);
  });

  it("sets brand and switches source to manual on brand change", () => {
    const { values, setters } = createState();
    const { result } = renderHook(() =>
      useOrgEntrySpecificFieldsPropsFromState({
        entryKind: "creditCard",
        entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
        translations: {
          t: (k) => k,
          tn: (k) => k,
          tcc: (k) => k,
          ti: (k) => k,
          tpk: (k) => k,
        },
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
        translations: {
          t: (k) => k,
          tn: (k) => k,
          tcc: (k) => k,
          ti: (k) => k,
          tpk: (k) => k,
        },
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

  it("uses generator output to update password and generator settings", () => {
    const { values, setters } = createState();
    const { result } = renderHook(() =>
      useOrgEntrySpecificFieldsPropsFromState({
        entryKind: "password",
        entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
        translations: {
          t: (k) => k,
          tn: (k) => k,
          tcc: (k) => k,
          ti: (k) => k,
          tpk: (k) => k,
        },
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

    const nextSettings = { length: 24 } as OrgPasswordFormValues["generatorSettings"];
    result.current.onGeneratorUse("generated-password", nextSettings);
    expect(setters.setPassword).toHaveBeenCalledWith("generated-password");
    expect(setters.setShowPassword).toHaveBeenCalledWith(true);
    expect(setters.setGeneratorSettings).toHaveBeenCalledWith(nextSettings);
  });

  it("toggles sensitive field visibility using current values", () => {
    const { values, setters } = createState();
    values.showPassword = true;
    values.showCardNumber = true;
    values.showCvv = true;
    values.showIdNumber = true;
    values.showCredentialId = true;

    const { result } = renderHook(() =>
      useOrgEntrySpecificFieldsPropsFromState({
        entryKind: "passkey",
        entryCopy: { notesLabel: "notes", notesPlaceholder: "notes" },
        translations: {
          t: (k) => k,
          tn: (k) => k,
          tcc: (k) => k,
          ti: (k) => k,
          tpk: (k) => k,
        },
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

    result.current.onToggleShowPassword();
    result.current.onToggleCardNumber();
    result.current.onToggleCvv();
    result.current.onToggleIdNumber();
    result.current.onToggleCredentialId();
    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(setters.setShowCardNumber).toHaveBeenCalledWith(false);
    expect(setters.setShowCvv).toHaveBeenCalledWith(false);
    expect(setters.setShowIdNumber).toHaveBeenCalledWith(false);
    expect(setters.setShowCredentialId).toHaveBeenCalledWith(false);
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
