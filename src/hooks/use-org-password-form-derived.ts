"use client";

import { useMemo } from "react";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
  buildOrgSubmitDisabled,
} from "@/hooks/org-password-form-derived-helpers";

export type OrgPasswordFormDerivedArgs = {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormProps["editData"];
  entryKindState: OrgEntryKindState;
  entryValues: OrgEntryFieldValues;
  cardNumberValid: boolean;
};

export function useOrgPasswordFormDerived({
  effectiveEntryType,
  editData,
  entryKindState,
  entryValues,
  cardNumberValid,
}: OrgPasswordFormDerivedArgs) {
  const { isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey } = entryKindState;

  const baselineSnapshot = useMemo(
    () =>
      buildBaselineSnapshot({
        effectiveEntryType,
        editData,
        entryKindState,
      }),
    [effectiveEntryType, editData, isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey],
  );

  const {
    title,
    notes,
    selectedTags,
    orgFolderId,
    username,
    password,
    url,
    customFields,
    totp,
    content,
    cardholderName,
    cardNumber,
    brand,
    expiryMonth,
    expiryYear,
    cvv,
    fullName,
    address,
    phone,
    email,
    dateOfBirth,
    nationality,
    idNumber,
    issueDate,
    expiryDate,
    relyingPartyId,
    relyingPartyName,
    credentialId,
    creationDate,
    deviceInfo,
  } = entryValues;

  const currentSnapshot = useMemo(
    () =>
      buildCurrentSnapshot({
        effectiveEntryType,
        entryKindState,
        entryValues,
      }),
    [
      effectiveEntryType,
      title,
      notes,
      selectedTags,
      orgFolderId,
      isLoginEntry,
      isNote,
      isCreditCard,
      isIdentity,
      isPasskey,
      username,
      password,
      url,
      customFields,
      totp,
      content,
      cardholderName,
      cardNumber,
      brand,
      expiryMonth,
      expiryYear,
      cvv,
      fullName,
      address,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
      relyingPartyId,
      relyingPartyName,
      credentialId,
      creationDate,
      deviceInfo,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = buildOrgSubmitDisabled({ entryKindState, entryValues, cardNumberValid });

  return { hasChanges, submitDisabled };
}
