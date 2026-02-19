"use client";

import { useMemo } from "react";
import { formatCardNumber } from "@/lib/credit-card";
import type { OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgEntryKindState } from "@/components/org/org-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";

interface BuildBaselineSnapshotArgs {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormProps["editData"];
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
}

interface BuildCurrentSnapshotArgs {
  effectiveEntryType: EntryTypeValue;
  title: string;
  notes: string;
  selectedTags: OrgTagData[];
  orgFolderId: string | null;
  isLoginEntry: boolean;
  isNote: boolean;
  isCreditCard: boolean;
  isIdentity: boolean;
  isPasskey: boolean;
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
}

export function buildBaselineSnapshot({
  effectiveEntryType,
  editData,
  isLoginEntry,
  isNote,
  isCreditCard,
  isIdentity,
  isPasskey,
}: BuildBaselineSnapshotArgs): string {
  return JSON.stringify({
    entryType: effectiveEntryType,
    title: editData?.title ?? "",
    notes: editData?.notes ?? "",
    selectedTagIds: (editData?.tags ?? []).map((tag) => tag.id).sort(),
    orgFolderId: editData?.orgFolderId ?? null,
    login: isLoginEntry
      ? {
          username: editData?.username ?? "",
          password: editData?.password ?? "",
          url: editData?.url ?? "",
          customFields: editData?.customFields ?? [],
          totp: editData?.totp ?? null,
        }
      : null,
    secureNote: isNote
      ? {
          content: editData?.content ?? "",
        }
      : null,
    creditCard: isCreditCard
      ? {
          cardholderName: editData?.cardholderName ?? "",
          cardNumber: formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? ""),
          brand: editData?.brand ?? "",
          expiryMonth: editData?.expiryMonth ?? "",
          expiryYear: editData?.expiryYear ?? "",
          cvv: editData?.cvv ?? "",
        }
      : null,
    identity: isIdentity
      ? {
          fullName: editData?.fullName ?? "",
          address: editData?.address ?? "",
          phone: editData?.phone ?? "",
          email: editData?.email ?? "",
          dateOfBirth: editData?.dateOfBirth ?? "",
          nationality: editData?.nationality ?? "",
          idNumber: editData?.idNumber ?? "",
          issueDate: editData?.issueDate ?? "",
          expiryDate: editData?.expiryDate ?? "",
        }
      : null,
    passkey: isPasskey
      ? {
          relyingPartyId: editData?.relyingPartyId ?? "",
          relyingPartyName: editData?.relyingPartyName ?? "",
          username: editData?.username ?? "",
          credentialId: editData?.credentialId ?? "",
          creationDate: editData?.creationDate ?? "",
          deviceInfo: editData?.deviceInfo ?? "",
        }
      : null,
  });
}

export function buildCurrentSnapshot({
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
}: BuildCurrentSnapshotArgs): string {
  return JSON.stringify({
    entryType: effectiveEntryType,
    title,
    notes,
    selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
    orgFolderId,
    login: isLoginEntry ? { username, password, url, customFields, totp } : null,
    secureNote: isNote ? { content } : null,
    creditCard: isCreditCard
      ? { cardholderName, cardNumber, brand, expiryMonth, expiryYear, cvv }
      : null,
    identity: isIdentity
      ? {
          fullName,
          address,
          phone,
          email,
          dateOfBirth,
          nationality,
          idNumber,
          issueDate,
          expiryDate,
        }
      : null,
    passkey: isPasskey
      ? {
          relyingPartyId,
          relyingPartyName,
          username,
          credentialId,
          creationDate,
          deviceInfo,
        }
      : null,
  });
}

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
