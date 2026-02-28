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
