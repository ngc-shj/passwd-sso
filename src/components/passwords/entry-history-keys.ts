/**
 * Keys displayed in the entry history "View" dialog.
 * Must cover all fields from every entry type's fullBlob.
 *
 * When adding a new entry type, add its fullBlob fields here
 * AND update the corresponding test in entry-history-keys.test.ts.
 */
export const DISPLAY_KEYS = [
  // LOGIN
  "title", "username", "password", "url", "notes",
  // SECURE_NOTE
  "content",
  // CREDIT_CARD
  "cardholderName", "cardNumber", "brand", "expiryMonth", "expiryYear", "cvv",
  // IDENTITY
  "fullName", "address", "phone", "email", "dateOfBirth", "nationality",
  "idNumber", "issueDate", "expiryDate",
  // PASSKEY
  "relyingPartyId", "relyingPartyName", "credentialId", "creationDate", "deviceInfo",
  // BANK_ACCOUNT
  "bankName", "accountType", "accountHolderName", "accountNumber", "routingNumber",
  "swiftBic", "iban", "branchName",
  // SOFTWARE_LICENSE
  "softwareName", "licenseKey", "version", "licensee", "purchaseDate", "expirationDate",
] as const;

/**
 * Fields that should be masked (shown as "••••••••") until explicitly revealed.
 */
export const SENSITIVE_KEYS = new Set([
  "password", "cvv", "cardNumber", "idNumber",
  "accountNumber", "routingNumber", "iban", "licenseKey", "credentialId",
]);
