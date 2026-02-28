import { ENTRY_TYPE } from "@/lib/constants";
import type { ParsedEntry } from "@/components/passwords/password-import-types";

export function buildPersonalImportBlobs(entry: ParsedEntry): {
  fullBlob: string;
  overviewBlob: string;
} {
  if (entry.entryType === ENTRY_TYPE.PASSKEY) {
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        relyingPartyId: entry.relyingPartyId || null,
        relyingPartyName: entry.relyingPartyName || null,
        username: entry.username || null,
        credentialId: entry.credentialId || null,
        creationDate: entry.creationDate || null,
        deviceInfo: entry.deviceInfo || null,
        notes: entry.notes || null,
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        relyingPartyId: entry.relyingPartyId || null,
        username: entry.username || null,
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  if (entry.entryType === ENTRY_TYPE.IDENTITY) {
    const idNumberLast4 = entry.idNumber ? entry.idNumber.slice(-4) : null;
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        fullName: entry.fullName || null,
        address: entry.address || null,
        phone: entry.phone || null,
        email: entry.email || null,
        dateOfBirth: entry.dateOfBirth || null,
        nationality: entry.nationality || null,
        idNumber: entry.idNumber || null,
        issueDate: entry.issueDate || null,
        expiryDate: entry.expiryDate || null,
        notes: entry.notes || null,
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        fullName: entry.fullName || null,
        idNumberLast4,
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  if (entry.entryType === ENTRY_TYPE.CREDIT_CARD) {
    const lastFour = entry.cardNumber
      ? entry.cardNumber.replace(/\s/g, "").slice(-4)
      : null;
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        cardholderName: entry.cardholderName || null,
        cardNumber: entry.cardNumber || null,
        brand: entry.brand || null,
        expiryMonth: entry.expiryMonth || null,
        expiryYear: entry.expiryYear || null,
        cvv: entry.cvv || null,
        notes: entry.notes || null,
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        cardholderName: entry.cardholderName || null,
        brand: entry.brand || null,
        lastFour,
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  if (entry.entryType === ENTRY_TYPE.BANK_ACCOUNT) {
    const accountNumberLast4 = entry.accountNumber ? entry.accountNumber.slice(-4) : null;
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        bankName: entry.bankName || null,
        accountType: entry.accountType || null,
        accountHolderName: entry.accountHolderName || null,
        accountNumber: entry.accountNumber || null,
        routingNumber: entry.routingNumber || null,
        swiftBic: entry.swiftBic || null,
        iban: entry.iban || null,
        branchName: entry.branchName || null,
        notes: entry.notes || null,
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        bankName: entry.bankName || null,
        accountNumberLast4,
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  if (entry.entryType === ENTRY_TYPE.SOFTWARE_LICENSE) {
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        softwareName: entry.softwareName || null,
        licenseKey: entry.licenseKey || null,
        version: entry.version || null,
        licensee: entry.licensee || null,
        purchaseDate: entry.purchaseDate || null,
        expirationDate: entry.expirationDate || null,
        notes: entry.notes || null,
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        softwareName: entry.softwareName || null,
        licensee: entry.licensee || null,
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  if (entry.entryType === ENTRY_TYPE.SECURE_NOTE) {
    return {
      fullBlob: JSON.stringify({
        title: entry.title,
        content: entry.content || "",
        tags: entry.tags,
      }),
      overviewBlob: JSON.stringify({
        title: entry.title,
        snippet: (entry.content || "").slice(0, 100),
        tags: entry.tags,
        requireReprompt: entry.requireReprompt,
      }),
    };
  }

  let urlHost: string | null = null;
  if (entry.url) {
    try {
      urlHost = new URL(entry.url).hostname;
    } catch {
      // invalid url
    }
  }
  return {
    fullBlob: JSON.stringify({
      title: entry.title,
      username: entry.username || null,
      password: entry.password,
      url: entry.url || null,
      notes: entry.notes || null,
      tags: entry.tags,
      generatorSettings: entry.generatorSettings,
      ...(entry.passwordHistory.length > 0 && { passwordHistory: entry.passwordHistory }),
      ...(entry.customFields.length > 0 && { customFields: entry.customFields }),
      ...(entry.totp && { totp: entry.totp }),
    }),
    overviewBlob: JSON.stringify({
      title: entry.title,
      username: entry.username || null,
      urlHost,
      tags: entry.tags,
      requireReprompt: entry.requireReprompt,
    }),
  };
}
