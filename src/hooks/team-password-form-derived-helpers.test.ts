import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
} from "@/hooks/team-password-form-derived-helpers";

describe("team-password-form-derived-helpers snapshot helpers", () => {
  it("buildBaselineSnapshot serializes edit data for login entries", () => {
    const snapshot = buildBaselineSnapshot({
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      editData: {
        id: "entry-1",
        title: "Title",
        username: "user@example.com",
        password: "secret",
        url: "https://example.com",
        notes: "notes",
        tags: [
          { id: "b", name: "B", color: "#000000" },
          { id: "a", name: "A", color: "#ffffff" },
        ],
        customFields: [{ id: "cf-1", label: "L", value: "V", type: "text" }],
        totp: { secret: "totp-secret", digits: 6, period: 30, algorithm: "SHA1" },
        teamFolderId: "folder-1",
      },
      entryKindState: {
        entryKind: "password",
        isLoginEntry: true,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(parsed.selectedTagIds).toEqual(["a", "b"]);
    expect(parsed.login.username).toBe("user@example.com");
    expect(parsed.login.password).toBe("secret");
    expect(parsed.teamFolderId).toBe("folder-1");
    expect(parsed.secureNote).toBeNull();
  });

  it("buildCurrentSnapshot serializes passkey entries", () => {
    const snapshot = buildCurrentSnapshot({
      effectiveEntryType: ENTRY_TYPE.PASSKEY,
      entryKindState: {
        entryKind: "passkey",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: true,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
      entryValues: {
        title: "Passkey",
        notes: "memo",
        selectedTags: [
          { id: "tag-z", name: "Z", color: "#ff0000" },
          { id: "tag-a", name: "A", color: "#00ff00" },
        ],
        teamFolderId: null,
        username: "passkey-user",
        password: "",
        url: "",
        customFields: [],
        totp: null,
        content: "",
        cardholderName: "",
        cardNumber: "",
        brand: "",
        expiryMonth: "",
        expiryYear: "",
        cvv: "",
        fullName: "",
        address: "",
        phone: "",
        email: "",
        dateOfBirth: "",
        nationality: "",
        idNumber: "",
        issueDate: "",
        expiryDate: "",
        relyingPartyId: "rp.example.com",
        relyingPartyName: "Example RP",
        credentialId: "cred-123",
        creationDate: "2026-01-01",
        deviceInfo: "YubiKey",
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
        requireReprompt: false,
        expiresAt: null,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(parsed.selectedTagIds).toEqual(["tag-a", "tag-z"]);
    expect(parsed.passkey.relyingPartyId).toBe("rp.example.com");
    expect(parsed.passkey.credentialId).toBe("cred-123");
    expect(parsed.login).toBeNull();
  });

  it("buildBaselineSnapshot includes bankAccount when isBankAccount is true", () => {
    const snapshot = buildBaselineSnapshot({
      effectiveEntryType: ENTRY_TYPE.BANK_ACCOUNT,
      editData: {
        id: "entry-ba",
        title: "My Bank",
        username: "",
        password: "",
        url: null,
        notes: "primary account",
        tags: [],
        customFields: [],
        totp: null,
        teamFolderId: null,
        bankName: "Acme Bank",
        accountType: "checking",
        accountHolderName: "John Doe",
        accountNumber: "123456789",
        routingNumber: "021000021",
        swiftBic: "BOFAUS3N",
        iban: "DE89370400440532013000",
        branchName: "Downtown",
      },
      entryKindState: {
        entryKind: "bankAccount",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: true,
        isSoftwareLicense: false,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(parsed.bankAccount).not.toBeNull();
    expect(parsed.bankAccount.bankName).toBe("Acme Bank");
    expect(parsed.bankAccount.accountNumber).toBe("123456789");
    expect(parsed.bankAccount.routingNumber).toBe("021000021");
    expect(parsed.login).toBeNull();
    expect(parsed.softwareLicense).toBeNull();
  });

  it("buildBaselineSnapshot includes softwareLicense when isSoftwareLicense is true", () => {
    const snapshot = buildBaselineSnapshot({
      effectiveEntryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      editData: {
        id: "entry-sl",
        title: "Adobe CC",
        username: "",
        password: "",
        url: null,
        notes: "annual license",
        tags: [],
        customFields: [],
        totp: null,
        teamFolderId: null,
        softwareName: "Adobe Creative Cloud",
        licenseKey: "ABCD-EFGH",
        version: "2026",
        licensee: "Jane Doe",
        purchaseDate: "2026-01-01",
        expirationDate: "2027-01-01",
      },
      entryKindState: {
        entryKind: "softwareLicense",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: true,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(parsed.softwareLicense).not.toBeNull();
    expect(parsed.softwareLicense.softwareName).toBe("Adobe Creative Cloud");
    expect(parsed.softwareLicense.licenseKey).toBe("ABCD-EFGH");
    expect(parsed.softwareLicense.version).toBe("2026");
    expect(parsed.login).toBeNull();
    expect(parsed.bankAccount).toBeNull();
  });

  it("buildCurrentSnapshot includes bankAccount when isBankAccount is true", () => {
    const snapshot = buildCurrentSnapshot({
      effectiveEntryType: ENTRY_TYPE.BANK_ACCOUNT,
      entryKindState: {
        entryKind: "bankAccount",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: true,
        isSoftwareLicense: false,
      },
      entryValues: {
        title: "My Bank",
        notes: "primary",
        selectedTags: [],
        teamFolderId: null,
        username: "",
        password: "",
        url: "",
        customFields: [],
        totp: null,
        content: "",
        cardholderName: "",
        cardNumber: "",
        brand: "",
        expiryMonth: "",
        expiryYear: "",
        cvv: "",
        fullName: "",
        address: "",
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
        bankName: "Acme Bank",
        accountType: "checking",
        accountHolderName: "John Doe",
        accountNumber: "123456789",
        routingNumber: "021000021",
        swiftBic: "BOFAUS3N",
        iban: "DE89370400440532013000",
        branchName: "Downtown",
        softwareName: "",
        licenseKey: "",
        version: "",
        licensee: "",
        purchaseDate: "",
        expirationDate: "",
        requireReprompt: false,
        expiresAt: null,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(parsed.bankAccount).not.toBeNull();
    expect(parsed.bankAccount.bankName).toBe("Acme Bank");
    expect(parsed.bankAccount.accountNumber).toBe("123456789");
    expect(parsed.login).toBeNull();
    expect(parsed.softwareLicense).toBeNull();
  });

  it("buildCurrentSnapshot includes softwareLicense when isSoftwareLicense is true", () => {
    const snapshot = buildCurrentSnapshot({
      effectiveEntryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      entryKindState: {
        entryKind: "softwareLicense",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: true,
      },
      entryValues: {
        title: "Adobe CC",
        notes: "annual license",
        selectedTags: [],
        teamFolderId: null,
        username: "",
        password: "",
        url: "",
        customFields: [],
        totp: null,
        content: "",
        cardholderName: "",
        cardNumber: "",
        brand: "",
        expiryMonth: "",
        expiryYear: "",
        cvv: "",
        fullName: "",
        address: "",
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
        softwareName: "Adobe Creative Cloud",
        licenseKey: "ABCD-EFGH",
        version: "2026",
        licensee: "Jane Doe",
        purchaseDate: "2026-01-01",
        expirationDate: "2027-01-01",
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(parsed.softwareLicense).not.toBeNull();
    expect(parsed.softwareLicense.softwareName).toBe("Adobe Creative Cloud");
    expect(parsed.softwareLicense.licenseKey).toBe("ABCD-EFGH");
    expect(parsed.softwareLicense.version).toBe("2026");
    expect(parsed.login).toBeNull();
    expect(parsed.bankAccount).toBeNull();
  });

  it("includes requireReprompt and expiresAt at root level in baseline snapshot", () => {
    const snapshot = buildBaselineSnapshot({
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      editData: {
        id: "entry-rp",
        title: "Test",
        username: "u",
        password: "p",
        requireReprompt: true,
        expiresAt: "2026-12-31T00:00:00Z",
      },
      entryKindState: {
        entryKind: "password",
        isLoginEntry: true,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.requireReprompt).toBe(true);
    expect(parsed.expiresAt).toBe("2026-12-31T00:00:00Z");
  });

  it("includes requireReprompt and expiresAt at root level in current snapshot", () => {
    const snapshot = buildCurrentSnapshot({
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      entryKindState: {
        entryKind: "password",
        isLoginEntry: true,
        isNote: false,
        isCreditCard: false,
        isIdentity: false,
        isPasskey: false,
        isBankAccount: false,
        isSoftwareLicense: false,
      },
      entryValues: {
        title: "Test",
        notes: "",
        selectedTags: [],
        teamFolderId: null,
        username: "u",
        password: "p",
        url: "",
        customFields: [],
        totp: null,
        content: "",
        cardholderName: "",
        cardNumber: "",
        brand: "",
        expiryMonth: "",
        expiryYear: "",
        cvv: "",
        fullName: "",
        address: "",
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
        requireReprompt: true,
        expiresAt: "2026-06-15T00:00:00Z",
      },
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.requireReprompt).toBe(true);
    expect(parsed.expiresAt).toBe("2026-06-15T00:00:00Z");
  });
});
