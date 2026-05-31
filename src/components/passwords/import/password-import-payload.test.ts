import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import type { ParsedEntry } from "@/components/passwords/import/password-import-types";
import { buildPersonalImportBlobs } from "@/components/passwords/import/password-import-payload";

function baseParsedEntry(overrides: Partial<ParsedEntry>): ParsedEntry {
  return {
    entryType: ENTRY_TYPE.LOGIN,
    title: "Test",
    username: "",
    password: "",
    content: "",
    url: "",
    notes: "",
    cardholderName: "",
    cardNumber: "",
    brand: "",
    expiryMonth: "",
    expiryYear: "",
    cvv: "",
    fullName: "",
    address: "",
    givenName: "",
    familyName: "",
    middleName: "",
    familyNameKana: "",
    givenNameKana: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    idNumber: "",
    issueDate: "",
    expiryDate: "",
    relyingPartyId: "",
    relyingPartyName: "",
    credentialId: "",
    creationDate: "",
    deviceInfo: "",
    bankName: "",
    accountType: "",
    accountHolderName: "",
    accountNumber: "",
    routingNumber: "",
    swiftBic: "",
    iban: "",
    branchName: "",
    softwareName: "",
    licenseKey: "",
    version: "",
    licensee: "",
    purchaseDate: "",
    expirationDate: "",
    privateKey: "",
    publicKey: "",
    keyType: "",
    keySize: "",
    fingerprint: "",
    sshPassphrase: "",
    sshComment: "",
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    travelSafe: true,
    folderPath: "",
    isFavorite: false,
    expiresAt: null,
    ...overrides,
  };
}

// ─── BANK_ACCOUNT ────────────────────────────────────────────

describe("buildPersonalImportBlobs — BANK_ACCOUNT", () => {
  const bankEntry = baseParsedEntry({
    entryType: ENTRY_TYPE.BANK_ACCOUNT,
    title: "My Bank",
    bankName: "Acme Bank",
    accountType: "checking",
    accountHolderName: "Jane Doe",
    accountNumber: "123456789",
    routingNumber: "021000021",
    swiftBic: "BOFAUS3N",
    iban: "DE89370400440532013000",
    branchName: "Main Street",
    notes: "primary account",
    tags: [{ name: "finance", color: "#00ff00" }],
  });

  it("fullBlob contains all bank account fields", () => {
    const { fullBlob } = buildPersonalImportBlobs(bankEntry);
    const blob = JSON.parse(fullBlob);

    expect(blob.title).toBe("My Bank");
    expect(blob.bankName).toBe("Acme Bank");
    expect(blob.accountType).toBe("checking");
    expect(blob.accountHolderName).toBe("Jane Doe");
    expect(blob.accountNumber).toBe("123456789");
    expect(blob.routingNumber).toBe("021000021");
    expect(blob.swiftBic).toBe("BOFAUS3N");
    expect(blob.iban).toBe("DE89370400440532013000");
    expect(blob.branchName).toBe("Main Street");
    expect(blob.notes).toBe("primary account");
    expect(blob.tags).toEqual([{ name: "finance", color: "#00ff00" }]);
  });

  it("overviewBlob contains accountNumberLast4 for valid account number", () => {
    const { overviewBlob } = buildPersonalImportBlobs(bankEntry);
    const overview = JSON.parse(overviewBlob);

    expect(overview.title).toBe("My Bank");
    expect(overview.bankName).toBe("Acme Bank");
    expect(overview.accountNumberLast4).toBe("6789");
    expect(overview.tags).toEqual([{ name: "finance", color: "#00ff00" }]);
    expect(overview.requireReprompt).toBe(false);
  });

  it("computes accountNumberLast4 correctly for formatted input with non-digit characters", () => {
    const entry = baseParsedEntry({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Formatted Bank",
      accountNumber: "1234-5678",
    });
    const { overviewBlob } = buildPersonalImportBlobs(entry);
    const overview = JSON.parse(overviewBlob);

    expect(overview.accountNumberLast4).toBe("5678");
  });

  it("returns accountNumberLast4 as null for account numbers with 3 or fewer digits", () => {
    const entry = baseParsedEntry({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Short Account",
      accountNumber: "123",
    });
    const { overviewBlob } = buildPersonalImportBlobs(entry);
    const overview = JSON.parse(overviewBlob);

    expect(overview.accountNumberLast4).toBeNull();
  });
});

// ─── SOFTWARE_LICENSE ────────────────────────────────────────

describe("buildPersonalImportBlobs — SOFTWARE_LICENSE", () => {
  const licenseEntry = baseParsedEntry({
    entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
    title: "Adobe CC",
    softwareName: "Adobe Creative Cloud",
    licenseKey: "ABCD-EFGH-IJKL",
    version: "2026",
    licensee: "Jane Doe",
    email: "jane@example.com",
    purchaseDate: "2026-01-15",
    expirationDate: "2027-01-15",
    notes: "annual license",
    tags: [{ name: "software", color: "#0000ff" }],
  });

  it("fullBlob contains all software license fields", () => {
    const { fullBlob } = buildPersonalImportBlobs(licenseEntry);
    const blob = JSON.parse(fullBlob);

    expect(blob.title).toBe("Adobe CC");
    expect(blob.softwareName).toBe("Adobe Creative Cloud");
    expect(blob.licenseKey).toBe("ABCD-EFGH-IJKL");
    expect(blob.version).toBe("2026");
    expect(blob.licensee).toBe("Jane Doe");
    expect(blob.email).toBe("jane@example.com");
    expect(blob.purchaseDate).toBe("2026-01-15");
    expect(blob.expirationDate).toBe("2027-01-15");
    expect(blob.notes).toBe("annual license");
    expect(blob.tags).toEqual([{ name: "software", color: "#0000ff" }]);
  });

  it("overviewBlob contains softwareName and licensee", () => {
    const { overviewBlob } = buildPersonalImportBlobs(licenseEntry);
    const overview = JSON.parse(overviewBlob);

    expect(overview.title).toBe("Adobe CC");
    expect(overview.softwareName).toBe("Adobe Creative Cloud");
    expect(overview.licensee).toBe("Jane Doe");
    expect(overview.tags).toEqual([{ name: "software", color: "#0000ff" }]);
    expect(overview.requireReprompt).toBe(false);
  });
});

// ─── IDENTITY (structured) ────────────────────

describe("buildPersonalImportBlobs — IDENTITY structured", () => {
  const identityEntry = baseParsedEntry({
    entryType: ENTRY_TYPE.IDENTITY,
    title: "My ID",
    givenName: "Taro",
    familyName: "Yamada",
    middleName: "M",
    familyNameKana: "ヤマダ",
    givenNameKana: "タロウ",
    addressLine1: "1-1-1 Chiyoda",
    addressLine2: "Apt 101",
    city: "Chiyoda-ku",
    state: "Tokyo",
    postalCode: "100-0001",
    country: "Japan",
    email: "taro@example.com",
    idNumber: "A12345678",
  });

  it("persists all structured identity fields in fullBlob", () => {
    const { fullBlob } = buildPersonalImportBlobs(identityEntry);
    const blob = JSON.parse(fullBlob);

    expect(blob.givenName).toBe("Taro");
    expect(blob.familyName).toBe("Yamada");
    expect(blob.middleName).toBe("M");
    expect(blob.familyNameKana).toBe("ヤマダ");
    expect(blob.givenNameKana).toBe("タロウ");
    expect(blob.addressLine1).toBe("1-1-1 Chiyoda");
    expect(blob.addressLine2).toBe("Apt 101");
    expect(blob.city).toBe("Chiyoda-ku");
    expect(blob.state).toBe("Tokyo");
    expect(blob.postalCode).toBe("100-0001");
    expect(blob.country).toBe("Japan");
  });

  it("composes overview name from given+family when fullName absent and excludes address PII", () => {
    const { overviewBlob } = buildPersonalImportBlobs(identityEntry);
    const overview = JSON.parse(overviewBlob);

    expect(overview.fullName).toBe("Taro Yamada");
    expect(overview.email).toBe("taro@example.com");
    expect(overview.addressLine1).toBeUndefined();
    expect(overview.postalCode).toBeUndefined();
  });
});
