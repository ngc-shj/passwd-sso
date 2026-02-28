import { describe, it, expect } from "vitest";
import { DISPLAY_KEYS, SENSITIVE_KEYS } from "./entry-history-keys";

/**
 * Expected fullBlob fields per entry type.
 * Derived from each form's `JSON.stringify({ ... })` call.
 *
 * Excluded meta fields that are not user-visible:
 *   tags, entryType, generatorSettings, passwordHistory, customFields, totp, snippet
 */
const EXPECTED_FIELDS: Record<string, string[]> = {
  LOGIN: ["title", "username", "password", "url", "notes"],
  SECURE_NOTE: ["title", "content"],
  CREDIT_CARD: [
    "title", "cardholderName", "cardNumber", "brand",
    "expiryMonth", "expiryYear", "cvv", "notes",
  ],
  IDENTITY: [
    "title", "fullName", "address", "phone", "email",
    "dateOfBirth", "nationality", "idNumber", "issueDate", "expiryDate", "notes",
  ],
  PASSKEY: [
    "title", "relyingPartyId", "relyingPartyName", "username",
    "credentialId", "creationDate", "deviceInfo", "notes",
  ],
  BANK_ACCOUNT: [
    "title", "bankName", "accountType", "accountHolderName",
    "accountNumber", "routingNumber", "swiftBic", "iban", "branchName", "notes",
  ],
  SOFTWARE_LICENSE: [
    "title", "softwareName", "licenseKey", "version",
    "licensee", "email", "purchaseDate", "expirationDate", "notes",
  ],
};

/** Fields that contain sensitive data and should be masked in history view. */
const EXPECTED_SENSITIVE = [
  "password", "cvv", "cardNumber", "idNumber",
  "accountNumber", "routingNumber", "iban", "licenseKey", "credentialId",
];

describe("DISPLAY_KEYS coverage", () => {
  const displayKeySet = new Set(DISPLAY_KEYS);

  for (const [entryType, fields] of Object.entries(EXPECTED_FIELDS)) {
    it(`covers all ${entryType} fullBlob fields`, () => {
      const missing = fields.filter((f) => !displayKeySet.has(f));
      expect(missing).toEqual([]);
    });
  }

  it("has no duplicate keys", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of DISPLAY_KEYS) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });
});

describe("SENSITIVE_KEYS coverage", () => {
  it("contains all expected sensitive fields", () => {
    const missing = EXPECTED_SENSITIVE.filter((f) => !SENSITIVE_KEYS.has(f));
    expect(missing).toEqual([]);
  });

  it("every sensitive key is also in DISPLAY_KEYS", () => {
    const displayKeySet = new Set(DISPLAY_KEYS);
    const orphaned = [...SENSITIVE_KEYS].filter((f) => !displayKeySet.has(f));
    expect(orphaned).toEqual([]);
  });
});
