"use client";

import { useMemo } from "react";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
} from "@/components/org/org-password-form-snapshot";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";

interface UseOrgPasswordFormDerivedArgs {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormEditData | null;
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
  title: string;
  notes: string;
  selectedTags: OrgTagData[];
  orgFolderId: string | null;
  username: string;
  password: string;
  url: string;
  customFields: EntryCustomField[];
  totp: EntryTotp | null;
  content: string;
  cardholderName: string;
  cardNumber: string;
  brand: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  fullName: string;
  address: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  nationality: string;
  idNumber: string;
  issueDate: string;
  expiryDate: string;
  relyingPartyId: string;
  relyingPartyName: string;
  credentialId: string;
  creationDate: string;
  deviceInfo: string;
  cardNumberValid: boolean;
}

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
}: UseOrgPasswordFormDerivedArgs) {
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
