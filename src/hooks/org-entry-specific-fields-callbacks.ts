"use client";

import type { GeneratorSettings } from "@/lib/generator-prefs";
import type {
  OrgPasswordFormSettersState,
  OrgPasswordFormValues,
} from "@/hooks/use-org-password-form-state";

export function buildOrgEntrySpecificCallbacks(
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
