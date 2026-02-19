"use client";

import { useMemo } from "react";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
} from "@/components/org/org-password-form-snapshot";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";

export type OrgPasswordFormDerivedArgs = {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormProps["editData"];
} &
  OrgEntryKindState &
  OrgEntryFieldValues & {
    cardNumberValid: boolean;
  };

export function useOrgPasswordFormDerived({
  effectiveEntryType,
  editData,
  isLoginEntry,
  isNote,
  isCreditCard,
  isIdentity,
  isPasskey,
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
  cardNumberValid,
}: OrgPasswordFormDerivedArgs) {
  const baselineSnapshot = useMemo(
    () =>
      buildBaselineSnapshot({
        effectiveEntryType,
        editData,
        isLoginEntry,
        isNote,
        isCreditCard,
        isIdentity,
        isPasskey,
      }),
    [effectiveEntryType, editData, isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey],
  );

  const currentSnapshot = useMemo(
    () =>
      buildCurrentSnapshot({
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
  const submitDisabled =
    !title.trim() ||
    (isPasskey && !relyingPartyId.trim()) ||
    (isLoginEntry && !password) ||
    (isCreditCard && !cardNumberValid);

  return { hasChanges, submitDisabled };
}
