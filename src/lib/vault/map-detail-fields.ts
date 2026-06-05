import type { InlineDetailData } from "@/types/entry";

/**
 * The subset of InlineDetailData fields that come from the encrypted blob.
 * Caller-specific fields (id, entryType, urlHost, title, createdAt, updatedAt,
 * requireReprompt, passwordHistory) are excluded — each assembly site sets those
 * from its own row/overview data.
 *
 * Uses Omit (not Partial) so each field keeps its exact optionality from
 * InlineDetailData. The REQUIRED fields (password, url, notes, customFields) stay
 * required here, so dropping one is a compile error and a spread into
 * InlineDetailData type-checks at every call site. (Optional InlineDetailData
 * fields can still be omitted — e.g. the extended passkey fields are intentionally
 * not surfaced by any detail view.)
 */
type BlobDetailFields = Omit<
  InlineDetailData,
  "id" | "entryType" | "urlHost" | "title" | "createdAt" | "updatedAt" | "requireReprompt" | "passwordHistory"
>;

/**
 * Maps all blob-sourced display fields from a decrypted entry blob.
 *
 * This is the single source of truth for blob → display field mapping so that
 * no per-entry-type field can be silently dropped at a new assembly site.
 */
export function mapDecryptedBlobToDetailFields(
  blob: Record<string, unknown>,
): BlobDetailFields {
  return {
    // Login / Note
    password: (blob.password as string) ?? "",
    content: blob.content as string | undefined,
    isMarkdown: blob.isMarkdown as boolean | undefined,
    url: (blob.url as string) ?? null,
    notes: (blob.notes as string) ?? null,
    customFields: (blob.customFields as InlineDetailData["customFields"]) ?? [],
    totp: blob.totp as InlineDetailData["totp"],

    // Credit card
    cardholderName: blob.cardholderName as string | undefined,
    cardNumber: blob.cardNumber as string | undefined,
    brand: blob.brand as string | undefined,
    expiryMonth: blob.expiryMonth as string | undefined,
    expiryYear: blob.expiryYear as string | undefined,
    cvv: blob.cvv as string | undefined,

    // Identity — flat legacy field
    fullName: blob.fullName as string | undefined,
    address: blob.address as string | undefined,
    // Identity — structured name fields
    givenName: blob.givenName as string | undefined,
    familyName: blob.familyName as string | undefined,
    middleName: blob.middleName as string | undefined,
    familyNameKana: blob.familyNameKana as string | undefined,
    givenNameKana: blob.givenNameKana as string | undefined,
    // Identity — structured address fields
    addressLine1: blob.addressLine1 as string | undefined,
    addressLine2: blob.addressLine2 as string | undefined,
    city: blob.city as string | undefined,
    state: blob.state as string | undefined,
    postalCode: blob.postalCode as string | undefined,
    country: blob.country as string | undefined,
    // Identity — shared contact/document fields
    phone: blob.phone as string | undefined,
    email: blob.email as string | undefined,
    dateOfBirth: blob.dateOfBirth as string | undefined,
    nationality: blob.nationality as string | undefined,
    idNumber: blob.idNumber as string | undefined,
    issueDate: blob.issueDate as string | undefined,
    expiryDate: blob.expiryDate as string | undefined,

    // Passkey
    relyingPartyId: blob.relyingPartyId as string | undefined,
    relyingPartyName: blob.relyingPartyName as string | undefined,
    username: blob.username as string | undefined,
    credentialId: blob.credentialId as string | undefined,
    creationDate: blob.creationDate as string | undefined,
    deviceInfo: blob.deviceInfo as string | undefined,

    // Bank account
    bankName: blob.bankName as string | undefined,
    accountType: blob.accountType as string | undefined,
    accountHolderName: blob.accountHolderName as string | undefined,
    accountNumber: blob.accountNumber as string | undefined,
    routingNumber: blob.routingNumber as string | undefined,
    swiftBic: blob.swiftBic as string | undefined,
    iban: blob.iban as string | undefined,
    branchName: blob.branchName as string | undefined,

    // Software license
    softwareName: blob.softwareName as string | undefined,
    licenseKey: blob.licenseKey as string | undefined,
    version: blob.version as string | undefined,
    licensee: blob.licensee as string | undefined,
    purchaseDate: blob.purchaseDate as string | undefined,
    expirationDate: blob.expirationDate as string | undefined,

    // SSH key (blob uses "passphrase"/"comment"; display uses "sshPassphrase"/"sshComment")
    privateKey: blob.privateKey as string | undefined,
    publicKey: blob.publicKey as string | undefined,
    keyType: blob.keyType as string | undefined,
    keySize: blob.keySize as number | undefined,
    fingerprint: blob.fingerprint as string | undefined,
    sshPassphrase: blob.passphrase as string | undefined,
    sshComment: blob.comment as string | undefined,
  };
}
