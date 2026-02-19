"use client";

import {
  buildOrgEntrySpecificFieldsProps,
  type OrgEntrySpecificFieldsBuilderArgs,
  type OrgEntrySpecificFieldsProps,
} from "@/hooks/org-entry-specific-fields-builder";
import { buildOrgEntrySpecificCallbacks } from "@/hooks/org-entry-specific-fields-callbacks";
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
