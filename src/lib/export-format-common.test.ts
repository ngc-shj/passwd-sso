import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  type ExportEntry,
  csvEntryType,
  formatExportCsv,
  formatExportJson,
  TEAM_EXPORT_OPTIONS,
  PERSONAL_EXPORT_OPTIONS,
} from "@/lib/export-format-common";
import { parseJson } from "@/components/passwords/password-import-parsers";

const nullBankLicenseFields = {
  bankName: null,
  accountType: null,
  accountHolderName: null,
  accountNumber: null,
  routingNumber: null,
  swiftBic: null,
  iban: null,
  branchName: null,
  softwareName: null,
  licenseKey: null,
  version: null,
  licensee: null,
  purchaseDate: null,
  expirationDate: null,
};

const sampleLoginEntry: ExportEntry = {
  entryType: ENTRY_TYPE.LOGIN,
  title: "AWS Console",
  username: "alice@example.com",
  password: "secret-pass",
  content: null,
  url: "https://console.aws.amazon.com",
  notes: "note",
  totp: "JBSWY3DPEHPK3PXP",
  cardholderName: null,
  cardNumber: null,
  brand: null,
  expiryMonth: null,
  expiryYear: null,
  cvv: null,
  fullName: null,
  address: null,
  phone: null,
  email: null,
  dateOfBirth: null,
  nationality: null,
  idNumber: null,
  issueDate: null,
  expiryDate: null,
  relyingPartyId: null,
  relyingPartyName: null,
  credentialId: null,
  creationDate: null,
  deviceInfo: null,
  ...nullBankLicenseFields,
  tags: [{ name: "aws", color: "#ff9900" }],
  customFields: [{ label: "accountId", value: "123456789012", type: "text" }],
  totpConfig: { secret: "JBSWY3DPEHPK3PXP", issuer: "AWS" },
  generatorSettings: { length: 20 },
  passwordHistory: [{ password: "old-secret", changedAt: "2026-02-14T00:00:00.000Z" }],
  requireReprompt: false,
  folderPath: "",
  isFavorite: false,
  expiresAt: null,
};

describe("export-format-common", () => {
  it("exports compatible profile JSON without passwdSso payload", () => {
    const json = formatExportJson(
      [sampleLoginEntry],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    expect(parsed.format).toBeUndefined();
    expect(parsed.entries[0].passwdSso).toBeUndefined();
  });

  it("exports compatible profile CSV header without passwd_sso column", () => {
    const csv = formatExportCsv(
      [sampleLoginEntry],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    expect(csv.split("\n")[0]).not.toContain("passwd_sso");
  });

  it("exports requireReprompt=true as CSV reprompt='1'", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, requireReprompt: true }],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const repromptIdx = header.split(",").indexOf("reprompt");
    const cols = row.split(",");
    expect(cols[repromptIdx]).toBe("1");
  });

  it("exports requireReprompt=false as CSV reprompt=''", () => {
    const csv = formatExportCsv(
      [sampleLoginEntry],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const repromptIdx = header.split(",").indexOf("reprompt");
    const cols = row.split(",");
    expect(cols[repromptIdx]).toBe("");
  });

  it("exports JSON with reprompt and passwdSso.requireReprompt in personal profile", () => {
    const json = formatExportJson(
      [{ ...sampleLoginEntry, requireReprompt: true }],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    expect(parsed.entries[0].reprompt).toBe(1);
    expect(parsed.entries[0].passwdSso.requireReprompt).toBe(true);
  });

  it("exports passkey type for team CSV", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, entryType: ENTRY_TYPE.PASSKEY }],
      "compatible",
      TEAM_EXPORT_OPTIONS.csv
    );
    const row = csv.split("\n")[1];
    expect(row.split(",")[2]).toBe("passkey");
  });

  it("exports passwd-sso envelope for team JSON", () => {
    const json = formatExportJson(
      [sampleLoginEntry],
      "passwd-sso",
      TEAM_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].passwdSso).toBeDefined();
  });

  it("csvEntryType returns 'bankaccount' for BANK_ACCOUNT", () => {
    expect(csvEntryType(ENTRY_TYPE.BANK_ACCOUNT, { includePasskeyType: true })).toBe("bankaccount");
  });

  it("csvEntryType returns 'softwarelicense' for SOFTWARE_LICENSE", () => {
    expect(csvEntryType(ENTRY_TYPE.SOFTWARE_LICENSE, { includePasskeyType: true })).toBe("softwarelicense");
  });

  it("exports bank account type in team CSV", () => {
    const bankEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      bankName: "Acme Bank",
      accountNumber: "123456789",
    };
    const csv = formatExportCsv(
      [bankEntry],
      "compatible",
      TEAM_EXPORT_OPTIONS.csv
    );
    const row = csv.split("\n")[1];
    expect(row.split(",")[2]).toBe("bankaccount");
  });

  it("exports software license type in team CSV", () => {
    const licenseEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      softwareName: "Adobe CC",
      licenseKey: "ABCD-EFGH",
    };
    const csv = formatExportCsv(
      [licenseEntry],
      "compatible",
      TEAM_EXPORT_OPTIONS.csv
    );
    const row = csv.split("\n")[1];
    expect(row.split(",")[2]).toBe("softwarelicense");
  });

  it("exports bank account JSON with bankAccount fields", () => {
    const bankEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      bankName: "Acme Bank",
      accountType: "checking",
      accountHolderName: "Jane",
      accountNumber: "123456789",
      routingNumber: "021000021",
      swiftBic: "BOFAUS3N",
      iban: "DE89370400440532013000",
      branchName: "Main",
    };
    const json = formatExportJson(
      [bankEntry],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    const entry = parsed.entries[0];
    expect(entry.type).toBe("bankaccount");
    expect(entry.bankAccount.bankName).toBe("Acme Bank");
    expect(entry.bankAccount.accountType).toBe("checking");
    expect(entry.bankAccount.accountHolderName).toBe("Jane");
    expect(entry.bankAccount.accountNumber).toBe("123456789");
    expect(entry.bankAccount.routingNumber).toBe("021000021");
    expect(entry.bankAccount.swiftBic).toBe("BOFAUS3N");
    expect(entry.bankAccount.iban).toBe("DE89370400440532013000");
    expect(entry.bankAccount.branchName).toBe("Main");
  });

  it("exports software license JSON with softwareLicense fields", () => {
    const licenseEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      softwareName: "Adobe CC",
      licenseKey: "ABCD-EFGH",
      version: "2026",
      licensee: "Jane",
      email: "jane@example.com",
      purchaseDate: "2026-01-01",
      expirationDate: "2027-01-01",
    };
    const json = formatExportJson(
      [licenseEntry],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    const entry = parsed.entries[0];
    expect(entry.type).toBe("softwarelicense");
    expect(entry.softwareLicense.softwareName).toBe("Adobe CC");
    expect(entry.softwareLicense.licenseKey).toBe("ABCD-EFGH");
    expect(entry.softwareLicense.version).toBe("2026");
    expect(entry.softwareLicense.licensee).toBe("Jane");
    expect(entry.softwareLicense.email).toBe("jane@example.com");
    expect(entry.softwareLicense.purchaseDate).toBe("2026-01-01");
    expect(entry.softwareLicense.expirationDate).toBe("2027-01-01");
  });

  it("round-trips BANK_ACCOUNT through export JSON and parseJson", () => {
    const bankEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      bankName: "Acme Bank",
      accountType: "checking",
      accountHolderName: "Jane Doe",
      accountNumber: "123456789",
      routingNumber: "021000021",
      swiftBic: "BOFAUS3N",
      iban: "DE89370400440532013000",
      branchName: "Main Street",
    };
    const json = formatExportJson(
      [bankEntry],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const result = parseJson(json);

    expect(result.format).toBe("passwd-sso");
    expect(result.entries).toHaveLength(1);
    const imported = result.entries[0];
    expect(imported.entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(imported.title).toBe("AWS Console");
    expect(imported.bankName).toBe("Acme Bank");
    expect(imported.accountType).toBe("checking");
    expect(imported.accountHolderName).toBe("Jane Doe");
    expect(imported.accountNumber).toBe("123456789");
    expect(imported.routingNumber).toBe("021000021");
    expect(imported.swiftBic).toBe("BOFAUS3N");
    expect(imported.iban).toBe("DE89370400440532013000");
    expect(imported.branchName).toBe("Main Street");
  });

  it("exports folderPath and isFavorite in CSV folder/favorite columns", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, folderPath: "Work / Email", isFavorite: true }],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const cols = row.split(",");
    const folderIdx = header.split(",").indexOf("folder");
    const favIdx = header.split(",").indexOf("favorite");
    expect(cols[folderIdx]).toBe("Work / Email");
    expect(cols[favIdx]).toBe("1");
  });

  it("exports empty folder and favorite when not set", () => {
    const csv = formatExportCsv(
      [sampleLoginEntry],
      "compatible",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const cols = row.split(",");
    const folderIdx = header.split(",").indexOf("folder");
    const favIdx = header.split(",").indexOf("favorite");
    expect(cols[folderIdx]).toBe("");
    expect(cols[favIdx]).toBe("");
  });

  it("exports folderPath and isFavorite in JSON", () => {
    const json = formatExportJson(
      [{ ...sampleLoginEntry, folderPath: "Work", isFavorite: true }],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    expect(parsed.entries[0].folder).toBe("Work");
    expect(parsed.entries[0].favorite).toBe(true);
  });

  it("exports expiresAt in passwd-sso JSON passwdSso envelope", () => {
    const json = formatExportJson(
      [{ ...sampleLoginEntry, expiresAt: "2027-01-01T00:00:00.000Z" }],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = JSON.parse(json);
    expect(parsed.entries[0].passwdSso.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("exports isFavorite in passwd-sso CSV passwdSso payload", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, isFavorite: true }],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const psIdx = header.split(",").indexOf("passwd_sso");
    // passwd_sso column is JSON-escaped — extract from the row
    const cols = row.split(",");
    // The passwd_sso column may be quoted due to CSV escaping
    const rawPayload = cols.slice(psIdx).join(",").replace(/^"/, "").replace(/"$/, "").replace(/""/g, '"');
    const payload = JSON.parse(rawPayload);
    expect(payload.isFavorite).toBe(true);
  });

  it("exports expiresAt in passwd-sso CSV passwdSso payload", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, expiresAt: "2027-06-01T00:00:00.000Z" }],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const [header, row] = csv.split("\n");
    const psIdx = header.split(",").indexOf("passwd_sso");
    const cols = row.split(",");
    const rawPayload = cols.slice(psIdx).join(",").replace(/^"/, "").replace(/"$/, "").replace(/""/g, '"');
    const payload = JSON.parse(rawPayload);
    expect(payload.expiresAt).toBe("2027-06-01T00:00:00.000Z");
  });

  it("round-trips SOFTWARE_LICENSE through export JSON and parseJson", () => {
    const licenseEntry: ExportEntry = {
      ...sampleLoginEntry,
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      softwareName: "Adobe CC",
      licenseKey: "ABCD-EFGH-IJKL",
      version: "2026",
      licensee: "Jane Doe",
      email: "jane@example.com",
      purchaseDate: "2026-01-15",
      expirationDate: "2027-01-15",
    };
    const json = formatExportJson(
      [licenseEntry],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const result = parseJson(json);

    expect(result.format).toBe("passwd-sso");
    expect(result.entries).toHaveLength(1);
    const imported = result.entries[0];
    expect(imported.entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(imported.title).toBe("AWS Console");
    expect(imported.softwareName).toBe("Adobe CC");
    expect(imported.licenseKey).toBe("ABCD-EFGH-IJKL");
    expect(imported.version).toBe("2026");
    expect(imported.licensee).toBe("Jane Doe");
    expect(imported.email).toBe("jane@example.com");
    expect(imported.purchaseDate).toBe("2026-01-15");
    expect(imported.expirationDate).toBe("2027-01-15");
  });
});

// ─── Field coverage guard ─────────────────────────────────
// These tests break when a DB column or encrypted blob field is added
// but not reflected in ExportEntry / ParsedEntry.
// Update the lists below when adding new fields.

describe("field coverage guard", () => {
  // All columns from PasswordEntry Prisma model.
  // null = excluded from export (infrastructure).
  // string = the corresponding ExportEntry key it maps to.
  const PASSWORD_ENTRY_DB_COLUMNS: Record<string, string | null> = {
    // Primary key / infrastructure
    id: null,
    encryptedBlob: null,
    blobIv: null,
    blobAuthTag: null,
    encryptedOverview: null,
    overviewIv: null,
    overviewAuthTag: null,
    keyVersion: null,
    aadVersion: null,
    userId: null,
    tenantId: null,
    createdAt: null,
    updatedAt: null,
    deletedAt: null,       // soft delete
    isArchived: null,      // excluded from GET response
    // Metadata columns that ARE exported
    entryType: "entryType",
    isFavorite: "isFavorite",
    requireReprompt: "requireReprompt",
    expiresAt: "expiresAt",
    folderId: "folderPath", // transformed: folderId → folder path string
    // Relation: tags → tags array (in encrypted blob)
  };

  // Fields stored inside the encrypted blob (decrypted on export).
  // Each must have a corresponding key in ExportEntry.
  const ENCRYPTED_BLOB_FIELDS: string[] = [
    "title", "username", "password", "content", "url", "notes",
    "totp",
    "cardholderName", "cardNumber", "brand", "expiryMonth", "expiryYear", "cvv",
    "fullName", "address", "phone", "email", "dateOfBirth", "nationality",
    "idNumber", "issueDate", "expiryDate",
    "relyingPartyId", "relyingPartyName", "credentialId", "creationDate", "deviceInfo",
    "bankName", "accountType", "accountHolderName", "accountNumber",
    "routingNumber", "swiftBic", "iban", "branchName",
    "softwareName", "licenseKey", "version", "licensee",
    "purchaseDate", "expirationDate",
    "tags", "customFields", "totpConfig", "generatorSettings", "passwordHistory",
  ];

  // The full expected key set of ExportEntry.
  // When ExportEntry gains a new field, add it here.
  const EXPECTED_EXPORT_ENTRY_KEYS: string[] = [
    // from encrypted blob
    ...ENCRYPTED_BLOB_FIELDS,
    // from DB metadata
    "entryType", "requireReprompt", "folderPath", "isFavorite", "expiresAt",
  ].sort();

  const actualKeys = Object.keys(sampleLoginEntry).sort();

  it("sampleLoginEntry covers all expected ExportEntry keys", () => {
    // If a field is added to EXPECTED_EXPORT_ENTRY_KEYS but not to
    // sampleLoginEntry, this test fails.
    for (const key of EXPECTED_EXPORT_ENTRY_KEYS) {
      expect(actualKeys, `missing key: ${key}`).toContain(key);
    }
  });

  it("sampleLoginEntry has no unexpected keys", () => {
    // If sampleLoginEntry has a key not in the expected list, it means
    // EXPECTED_EXPORT_ENTRY_KEYS needs updating.
    for (const key of actualKeys) {
      expect(EXPECTED_EXPORT_ENTRY_KEYS, `unexpected key: ${key}`).toContain(key);
    }
  });

  it("all exported DB metadata columns map to an ExportEntry key", () => {
    const mapped = Object.entries(PASSWORD_ENTRY_DB_COLUMNS)
      .filter(([, v]) => v !== null)
      .map(([, v]) => v as string);
    for (const field of mapped) {
      expect(actualKeys, `DB column mapping missing in ExportEntry: ${field}`).toContain(field);
    }
  });

  it("all encrypted blob fields are in ExportEntry", () => {
    for (const field of ENCRYPTED_BLOB_FIELDS) {
      expect(actualKeys, `blob field missing in ExportEntry: ${field}`).toContain(field);
    }
  });
});
