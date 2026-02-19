"use client";

import { useMemo } from "react";
import { getOrgCardValidationState } from "@/components/org/org-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/org/org-entry-copy";
import { buildOrgEntryCopyData } from "@/components/org/org-entry-copy-data";
import {
  handleOrgCardNumberChange,
  submitOrgPasswordForm,
} from "@/components/org/org-password-form-actions";
import { buildOrgPasswordSubmitArgs } from "@/hooks/org-password-form-submit-args";
import { useOrgEntrySpecificFieldsPropsFromState } from "@/hooks/use-org-entry-specific-fields-props";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import type { useOrgPasswordFormState } from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";

type TFn = (key: string, values?: Record<string, string | number | Date>) => string;
type OrgFormState = ReturnType<typeof useOrgPasswordFormState>;

interface UseOrgPasswordFormControllerArgs {
  orgId: string;
  onSaved: () => void;
  isEdit: boolean;
  editData?: OrgPasswordFormEditData | null;
  effectiveEntryType: EntryTypeValue;
  entryKind: "password" | "secureNote" | "creditCard" | "identity" | "passkey";
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  t: TFn;
  ti: TFn;
  tn: TFn;
  tcc: TFn;
  tpk: TFn;
  tGen: TFn;
  formState: OrgFormState;
  handleOpenChange: (open: boolean) => void;
}

export function useOrgPasswordFormController({
  orgId,
  onSaved,
  isEdit,
  editData,
  effectiveEntryType,
  entryKind,
  isLoginEntry,
  isNote,
  isCreditCard,
  isIdentity,
  isPasskey,
  t,
  ti,
  tn,
  tcc,
  tpk,
  tGen,
  formState,
  handleOpenChange,
}: UseOrgPasswordFormControllerArgs) {
  const { values, setters } = formState;
  const {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  } = getOrgCardValidationState(values.cardNumber, values.brand);

  const handleCardNumberChange = (value: string) => {
    handleOrgCardNumberChange({
      value,
      brand: values.brand,
      brandSource: values.brandSource,
      setCardNumber: setters.setCardNumber,
      setBrand: setters.setBrand,
    });
  };

  const handleSubmit = async () => {
    await submitOrgPasswordForm(
      buildOrgPasswordSubmitArgs({
        orgId,
        isEdit,
        editData,
        effectiveEntryType,
        cardNumberValid,
        isIdentity,
        t: (key) => t(key),
        ti: (key) => ti(key),
        onSaved,
        handleOpenChange,
        formState,
      }),
    );
  };

  const generatorSummary = useMemo(
    () =>
      buildGeneratorSummary(values.generatorSettings, {
        modePassphrase: tGen("modePassphrase"),
        modePassword: tGen("modePassword"),
      }),
    [values.generatorSettings, tGen],
  );

  const entryCopy = useMemo(
    () =>
      buildOrgEntryCopy({
        isEdit,
        entryKind,
        copyByKind: buildOrgEntryCopyData({ t, tn, tcc, ti, tpk }),
      }),
    [isEdit, entryKind, t, tn, tcc, ti, tpk],
  );

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    effectiveEntryType,
    editData,
    isLoginEntry,
    isNote,
    isCreditCard,
    isIdentity,
    isPasskey,
    title: values.title,
    notes: values.notes,
    selectedTags: values.selectedTags,
    orgFolderId: values.orgFolderId,
    username: values.username,
    password: values.password,
    url: values.url,
    customFields: values.customFields,
    totp: values.totp,
    content: values.content,
    cardholderName: values.cardholderName,
    cardNumber: values.cardNumber,
    brand: values.brand,
    expiryMonth: values.expiryMonth,
    expiryYear: values.expiryYear,
    cvv: values.cvv,
    fullName: values.fullName,
    address: values.address,
    phone: values.phone,
    email: values.email,
    dateOfBirth: values.dateOfBirth,
    nationality: values.nationality,
    idNumber: values.idNumber,
    issueDate: values.issueDate,
    expiryDate: values.expiryDate,
    relyingPartyId: values.relyingPartyId,
    relyingPartyName: values.relyingPartyName,
    credentialId: values.credentialId,
    creationDate: values.creationDate,
    deviceInfo: values.deviceInfo,
    cardNumberValid,
  });

  const entrySpecificFieldsProps = useOrgEntrySpecificFieldsPropsFromState({
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
    onCardNumberChange: handleCardNumberChange,
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand: cardValidation.detectedBrand
      ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
      : undefined,
    hasBrandHint: hasBrandHint && cardValidation.digits.length > 0,
    lengthHint,
  });

  return {
    entryCopy,
    entrySpecificFieldsProps,
    handleSubmit,
    hasChanges,
    submitDisabled,
  };
}
