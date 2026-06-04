"use client";

import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import type { InlineDetailData } from "@/types/entry";

/**
 * Minimal entry fields needed to build the personal getDetail closure.
 * These come from the overview row (DisplayEntry) which is already in memory.
 */
interface PersonalEntryOverview {
  id: string;
  entryType?: string;
  urlHost: string | null;
  requireReprompt?: boolean;
}

interface PersonalGetDetailOpts {
  encryptionKey: CryptoKey;
  userId: string | null;
}

/**
 * Builds the personal `getDetail` closure for use with `usePasswordEntryDetail`.
 *
 * Both `PasswordCard` (accordion body) and the personal detail pane (master-detail)
 * consume this shared builder — there is ONE source of truth for personal entry
 * field assembly (INV-C1.7, INV-C3.1, Commonization principle).
 *
 * The closure:
 *   1. Fetches the raw encrypted blob from the server.
 *   2. Decrypts it using AES-256-GCM with the personal AAD (aadVersion >= 1).
 *   3. Assembles the complete InlineDetailData from the decrypted fields + overview fallbacks.
 *
 * The caller must ensure encryptionKey is non-null before building this closure.
 * The hook (usePasswordEntryDetail) will not call getDetail when entryId is null or vault is locked.
 */
export function buildPersonalGetDetail(
  entry: PersonalEntryOverview,
  opts: PersonalGetDetailOpts,
): (id: string) => Promise<InlineDetailData> {
  const { encryptionKey, userId } = opts;

  return async (id: string): Promise<InlineDetailData> => {
    const res = await fetchApi(apiPath.passwordById(id));
    if (!res.ok) {
      throw new Error("Failed to fetch entry");
    }
    const raw = await res.json() as Record<string, unknown>;

    const aad = (raw.aadVersion as number) >= 1 && userId
      ? buildPersonalEntryAAD(userId, id, VAULT_TYPE.BLOB)
      : undefined;

    const plaintext = await decryptData(
      raw.encryptedBlob as EncryptedData,
      encryptionKey,
      aad,
    );

    const e = JSON.parse(plaintext) as {
      password?: string;
      content?: string;
      isMarkdown?: boolean;
      url?: string | null;
      notes?: string | null;
      customFields?: unknown[];
      passwordHistory?: unknown[];
      totp?: unknown;
      cardholderName?: string | null;
      cardNumber?: string | null;
      brand?: string | null;
      expiryMonth?: string | null;
      expiryYear?: string | null;
      cvv?: string | null;
      fullName?: string | null;
      givenName?: string | null;
      familyName?: string | null;
      middleName?: string | null;
      familyNameKana?: string | null;
      givenNameKana?: string | null;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      state?: string | null;
      postalCode?: string | null;
      country?: string | null;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      dateOfBirth?: string | null;
      nationality?: string | null;
      idNumber?: string | null;
      issueDate?: string | null;
      expiryDate?: string | null;
      relyingPartyId?: string | null;
      relyingPartyName?: string | null;
      username?: string | null;
      credentialId?: string | null;
      creationDate?: string | null;
      deviceInfo?: string | null;
      bankName?: string | null;
      accountType?: string | null;
      accountHolderName?: string | null;
      accountNumber?: string | null;
      routingNumber?: string | null;
      swiftBic?: string | null;
      iban?: string | null;
      branchName?: string | null;
      softwareName?: string | null;
      licenseKey?: string | null;
      version?: string | null;
      licensee?: string | null;
      purchaseDate?: string | null;
      expirationDate?: string | null;
      privateKey?: string | null;
      publicKey?: string | null;
      keyType?: string | null;
      keySize?: number | null;
      fingerprint?: string | null;
      passphrase?: string | null;
      comment?: string | null;
    };

    return {
      id,
      entryType: entry.entryType as InlineDetailData["entryType"],
      requireReprompt: (raw.requireReprompt as boolean | undefined) ?? entry.requireReprompt ?? false,
      password: e.password ?? "",
      content: e.content,
      isMarkdown: e.isMarkdown,
      url: e.url ?? null,
      urlHost: entry.urlHost,
      notes: e.notes ?? null,
      customFields: (e.customFields ?? []) as InlineDetailData["customFields"],
      passwordHistory: (e.passwordHistory ?? []) as InlineDetailData["passwordHistory"],
      totp: e.totp as InlineDetailData["totp"],
      cardholderName: e.cardholderName,
      cardNumber: e.cardNumber,
      brand: e.brand,
      expiryMonth: e.expiryMonth,
      expiryYear: e.expiryYear,
      cvv: e.cvv,
      fullName: e.fullName,
      givenName: e.givenName,
      familyName: e.familyName,
      middleName: e.middleName,
      familyNameKana: e.familyNameKana,
      givenNameKana: e.givenNameKana,
      addressLine1: e.addressLine1,
      addressLine2: e.addressLine2,
      city: e.city,
      state: e.state,
      postalCode: e.postalCode,
      country: e.country,
      address: e.address,
      phone: e.phone,
      email: e.email,
      dateOfBirth: e.dateOfBirth,
      nationality: e.nationality,
      idNumber: e.idNumber,
      issueDate: e.issueDate,
      expiryDate: e.expiryDate,
      relyingPartyId: e.relyingPartyId,
      relyingPartyName: e.relyingPartyName,
      username: e.username,
      credentialId: e.credentialId,
      creationDate: e.creationDate,
      deviceInfo: e.deviceInfo,
      bankName: e.bankName,
      accountType: e.accountType,
      accountHolderName: e.accountHolderName,
      accountNumber: e.accountNumber,
      routingNumber: e.routingNumber,
      swiftBic: e.swiftBic,
      iban: e.iban,
      branchName: e.branchName,
      softwareName: e.softwareName,
      licenseKey: e.licenseKey,
      version: e.version,
      licensee: e.licensee,
      purchaseDate: e.purchaseDate,
      expirationDate: e.expirationDate,
      privateKey: e.privateKey,
      publicKey: e.publicKey,
      keyType: e.keyType,
      keySize: e.keySize,
      fingerprint: e.fingerprint,
      sshPassphrase: e.passphrase,
      sshComment: e.comment,
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  };
}
