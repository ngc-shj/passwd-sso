"use client";

import {
  buildOrgEntrySpecificFieldsProps,
  type OrgEntrySpecificFieldsBuilderArgs,
  type OrgEntrySpecificFieldsProps,
} from "@/hooks/org-entry-specific-fields-builder";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import type {
  OrgPasswordFormValues,
  OrgPasswordFormSettersState,
} from "@/hooks/use-org-password-form-state";

type UseOrgEntrySpecificFieldsPropsFromStateArgs = Pick<
  OrgEntrySpecificFieldsBuilderArgs,
  | "entryKind"
  | "entryCopy"
  | "t"
  | "tn"
  | "tcc"
  | "ti"
  | "tpk"
  | "generatorSummary"
  | "maxInputLength"
  | "showLengthError"
  | "showLuhnError"
  | "detectedBrand"
  | "hasBrandHint"
  | "lengthHint"
  | "onCardNumberChange"
> & {
  values: OrgPasswordFormValues;
  setters: OrgPasswordFormSettersState;
};

export function useOrgEntrySpecificFieldsProps(
  args: OrgEntrySpecificFieldsBuilderArgs,
): OrgEntrySpecificFieldsProps {
  return buildOrgEntrySpecificFieldsProps(args);
}

function buildOrgEntrySpecificCallbacks(
  values: OrgPasswordFormValues,
  setters: OrgPasswordFormSettersState,
) {
  return {
    onNotesChange: setters.setNotes,
    onTitleChange: setters.setTitle,
    onUsernameChange: setters.setUsername,
    onPasswordChange: setters.setPassword,
    onToggleShowPassword: () => setters.setShowPassword(!values.showPassword),
    onToggleGenerator: () => setters.setShowGenerator(!values.showGenerator),
    onGeneratorUse: (pw: string, settings: GeneratorSettings) => {
      setters.setPassword(pw);
      setters.setShowPassword(true);
      setters.setGeneratorSettings(settings);
    },
    onUrlChange: setters.setUrl,
    onContentChange: setters.setContent,
    onCardholderNameChange: setters.setCardholderName,
    onBrandChange: (value: string) => {
      setters.setBrand(value);
      setters.setBrandSource("manual");
    },
    onToggleCardNumber: () => setters.setShowCardNumber(!values.showCardNumber),
    onExpiryMonthChange: setters.setExpiryMonth,
    onExpiryYearChange: setters.setExpiryYear,
    onCvvChange: setters.setCvv,
    onToggleCvv: () => setters.setShowCvv(!values.showCvv),
    onFullNameChange: setters.setFullName,
    onAddressChange: setters.setAddress,
    onPhoneChange: setters.setPhone,
    onEmailChange: setters.setEmail,
    onDateOfBirthChange: (value: string) => {
      setters.setDateOfBirth(value);
      setters.setDobError(null);
    },
    onNationalityChange: setters.setNationality,
    onIdNumberChange: setters.setIdNumber,
    onToggleIdNumber: () => setters.setShowIdNumber(!values.showIdNumber),
    onIssueDateChange: (value: string) => {
      setters.setIssueDate(value);
      setters.setExpiryError(null);
    },
    onExpiryDateChange: (value: string) => {
      setters.setExpiryDate(value);
      setters.setExpiryError(null);
    },
    onRelyingPartyIdChange: setters.setRelyingPartyId,
    onRelyingPartyNameChange: setters.setRelyingPartyName,
    onCredentialIdChange: setters.setCredentialId,
    onToggleCredentialId: () => setters.setShowCredentialId(!values.showCredentialId),
    onCreationDateChange: setters.setCreationDate,
    onDeviceInfoChange: setters.setDeviceInfo,
  };
}

export function useOrgEntrySpecificFieldsPropsFromState({
  entryKind,
  entryCopy,
  t,
  tn,
  tcc,
  ti,
  tpk,
  values,
  setters,
  generatorSummary,
  onCardNumberChange,
  maxInputLength,
  showLengthError,
  showLuhnError,
  detectedBrand,
  hasBrandHint,
  lengthHint,
}: UseOrgEntrySpecificFieldsPropsFromStateArgs): OrgEntrySpecificFieldsProps {
  const callbacks = buildOrgEntrySpecificCallbacks(values, setters);

  return useOrgEntrySpecificFieldsProps({
    entryKind,
    entryCopy,
    t,
    tn,
    tcc,
    ti,
    tpk,
    notes: values.notes,
    onNotesChange: callbacks.onNotesChange,
    title: values.title,
    onTitleChange: callbacks.onTitleChange,
    username: values.username,
    onUsernameChange: callbacks.onUsernameChange,
    password: values.password,
    onPasswordChange: callbacks.onPasswordChange,
    showPassword: values.showPassword,
    onToggleShowPassword: callbacks.onToggleShowPassword,
    generatorSummary,
    showGenerator: values.showGenerator,
    onToggleGenerator: callbacks.onToggleGenerator,
    generatorSettings: values.generatorSettings,
    onGeneratorUse: callbacks.onGeneratorUse,
    url: values.url,
    onUrlChange: callbacks.onUrlChange,
    content: values.content,
    onContentChange: callbacks.onContentChange,
    cardholderName: values.cardholderName,
    onCardholderNameChange: callbacks.onCardholderNameChange,
    brand: values.brand,
    onBrandChange: callbacks.onBrandChange,
    cardNumber: values.cardNumber,
    onCardNumberChange,
    showCardNumber: values.showCardNumber,
    onToggleCardNumber: callbacks.onToggleCardNumber,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand,
    hasBrandHint,
    lengthHint,
    expiryMonth: values.expiryMonth,
    onExpiryMonthChange: callbacks.onExpiryMonthChange,
    expiryYear: values.expiryYear,
    onExpiryYearChange: callbacks.onExpiryYearChange,
    cvv: values.cvv,
    onCvvChange: callbacks.onCvvChange,
    showCvv: values.showCvv,
    onToggleCvv: callbacks.onToggleCvv,
    fullName: values.fullName,
    onFullNameChange: callbacks.onFullNameChange,
    address: values.address,
    onAddressChange: callbacks.onAddressChange,
    phone: values.phone,
    onPhoneChange: callbacks.onPhoneChange,
    email: values.email,
    onEmailChange: callbacks.onEmailChange,
    dateOfBirth: values.dateOfBirth,
    onDateOfBirthChange: callbacks.onDateOfBirthChange,
    nationality: values.nationality,
    onNationalityChange: callbacks.onNationalityChange,
    idNumber: values.idNumber,
    onIdNumberChange: callbacks.onIdNumberChange,
    showIdNumber: values.showIdNumber,
    onToggleIdNumber: callbacks.onToggleIdNumber,
    issueDate: values.issueDate,
    onIssueDateChange: callbacks.onIssueDateChange,
    expiryDate: values.expiryDate,
    onExpiryDateChange: callbacks.onExpiryDateChange,
    dobError: values.dobError,
    expiryError: values.expiryError,
    relyingPartyId: values.relyingPartyId,
    onRelyingPartyIdChange: callbacks.onRelyingPartyIdChange,
    relyingPartyName: values.relyingPartyName,
    onRelyingPartyNameChange: callbacks.onRelyingPartyNameChange,
    credentialId: values.credentialId,
    onCredentialIdChange: callbacks.onCredentialIdChange,
    showCredentialId: values.showCredentialId,
    onToggleCredentialId: callbacks.onToggleCredentialId,
    creationDate: values.creationDate,
    onCreationDateChange: callbacks.onCreationDateChange,
    deviceInfo: values.deviceInfo,
    onDeviceInfoChange: callbacks.onDeviceInfoChange,
  });
}
