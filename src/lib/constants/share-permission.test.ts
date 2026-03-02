import { describe, it, expect } from "vitest";
import {
  applySharePermissions,
  SHARE_PERMISSION,
  SHARE_PERMISSION_VALUES,
  SENSITIVE_FIELDS,
  OVERVIEW_FIELDS,
} from "./share-permission";
import { ENTRY_TYPE_VALUES } from "./entry-type";

// ─── Test data per entry type ────────────────────────────────

const LOGIN_DATA = {
  title: "My Login",
  username: "user@example.com",
  password: "s3cret!",
  url: "https://example.com",
  notes: "Important notes",
};

const CREDIT_CARD_DATA = {
  title: "My Card",
  cardholderName: "John Doe",
  cardNumber: "4111111111111111",
  brand: "Visa",
  expiryMonth: "12",
  expiryYear: "2030",
  cvv: "123",
  notes: "Personal card",
};

const BANK_ACCOUNT_DATA = {
  title: "Checking",
  bankName: "Test Bank",
  accountType: "checking",
  accountHolderName: "John Doe",
  accountNumber: "1234567890",
  routingNumber: "021000021",
  iban: "DE89370400440532013000",
  swiftBic: "COBADEFFXXX",
  branchName: "Main St",
  notes: "Primary account",
};

const IDENTITY_DATA = {
  title: "Passport",
  fullName: "John Doe",
  email: "john@example.com",
  address: "123 Main St",
  phone: "+1-555-0100",
  idNumber: "AB123456",
  nationality: "US",
  notes: "Expires 2030",
};

const SECURE_NOTE_DATA = {
  title: "Server Keys",
  content: "ssh-rsa AAAA... root@server",
};

const PASSKEY_DATA = {
  title: "GitHub Passkey",
  username: "johndoe",
  relyingPartyName: "GitHub",
  relyingPartyId: "github.com",
  credentialId: "cred_abc123xyz",
  deviceInfo: "MacBook Pro",
  notes: "Work laptop",
};

const SOFTWARE_LICENSE_DATA = {
  title: "IDE License",
  softwareName: "IntelliJ IDEA",
  licenseKey: "XXXX-YYYY-ZZZZ-WWWW",
  version: "2025.1",
  licensee: "John Doe",
  email: "john@example.com",
  notes: "Annual license",
};

// ─── Backward compatibility (no entryType) ───────────────────

describe("applySharePermissions — backward compatibility", () => {
  it("returns all data when permissions is empty (VIEW_ALL default)", () => {
    const result = applySharePermissions(LOGIN_DATA, []);
    expect(result).toEqual(LOGIN_DATA);
  });

  it("returns all data with explicit VIEW_ALL", () => {
    const result = applySharePermissions(LOGIN_DATA, [SHARE_PERMISSION.VIEW_ALL]);
    expect(result).toEqual(LOGIN_DATA);
  });

  it("removes password with HIDE_PASSWORD (LOGIN default)", () => {
    const result = applySharePermissions(LOGIN_DATA, [SHARE_PERMISSION.HIDE_PASSWORD]);
    expect(result).not.toHaveProperty("password");
    expect(result).toHaveProperty("title", "My Login");
    expect(result).toHaveProperty("username", "user@example.com");
    expect(result).toHaveProperty("url", "https://example.com");
    expect(result).toHaveProperty("notes", "Important notes");
  });

  it("keeps only title, username, url with OVERVIEW_ONLY (LOGIN default)", () => {
    const result = applySharePermissions(LOGIN_DATA, [SHARE_PERMISSION.OVERVIEW_ONLY]);
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
    expect(result).toEqual({
      title: "My Login",
      username: "user@example.com",
      url: "https://example.com",
    });
  });

  it("OVERVIEW_ONLY omits missing fields gracefully", () => {
    const data = { title: "Note", content: "some text" };
    const result = applySharePermissions(data, [SHARE_PERMISSION.OVERVIEW_ONLY]);
    expect(result).toEqual({ title: "Note" });
  });

  it("OVERVIEW_ONLY takes precedence over HIDE_PASSWORD when both present", () => {
    const result = applySharePermissions(LOGIN_DATA, [
      SHARE_PERMISSION.HIDE_PASSWORD,
      SHARE_PERMISSION.OVERVIEW_ONLY,
    ]);
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
  });
});

// ─── Entry-type-specific: LOGIN ──────────────────────────────

describe("applySharePermissions — LOGIN", () => {
  it("HIDE_PASSWORD removes password only", () => {
    const result = applySharePermissions(LOGIN_DATA, [SHARE_PERMISSION.HIDE_PASSWORD], "LOGIN");
    expect(result).not.toHaveProperty("password");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("username");
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("notes");
  });

  it("OVERVIEW_ONLY keeps title, username, url", () => {
    const result = applySharePermissions(LOGIN_DATA, [SHARE_PERMISSION.OVERVIEW_ONLY], "LOGIN");
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
  });
});

// ─── Entry-type-specific: CREDIT_CARD ────────────────────────

describe("applySharePermissions — CREDIT_CARD", () => {
  it("HIDE_PASSWORD removes cardNumber and cvv", () => {
    const result = applySharePermissions(
      CREDIT_CARD_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "CREDIT_CARD",
    );
    expect(result).not.toHaveProperty("cardNumber");
    expect(result).not.toHaveProperty("cvv");
    expect(result).toHaveProperty("cardholderName", "John Doe");
    expect(result).toHaveProperty("brand", "Visa");
    expect(result).toHaveProperty("expiryMonth", "12");
    expect(result).toHaveProperty("expiryYear", "2030");
    expect(result).toHaveProperty("notes", "Personal card");
  });

  it("OVERVIEW_ONLY keeps title, cardholderName, brand, expiryMonth, expiryYear", () => {
    const result = applySharePermissions(
      CREDIT_CARD_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "CREDIT_CARD",
    );
    expect(Object.keys(result).sort()).toEqual([
      "brand",
      "cardholderName",
      "expiryMonth",
      "expiryYear",
      "title",
    ]);
    expect(result).toEqual({
      title: "My Card",
      cardholderName: "John Doe",
      brand: "Visa",
      expiryMonth: "12",
      expiryYear: "2030",
    });
  });
});

// ─── Entry-type-specific: BANK_ACCOUNT ───────────────────────

describe("applySharePermissions — BANK_ACCOUNT", () => {
  it("HIDE_PASSWORD removes accountNumber, routingNumber, iban", () => {
    const result = applySharePermissions(
      BANK_ACCOUNT_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "BANK_ACCOUNT",
    );
    expect(result).not.toHaveProperty("accountNumber");
    expect(result).not.toHaveProperty("routingNumber");
    expect(result).not.toHaveProperty("iban");
    expect(result).toHaveProperty("bankName", "Test Bank");
    expect(result).toHaveProperty("accountHolderName", "John Doe");
    expect(result).toHaveProperty("swiftBic", "COBADEFFXXX");
    expect(result).toHaveProperty("branchName", "Main St");
    expect(result).toHaveProperty("notes", "Primary account");
  });

  it("OVERVIEW_ONLY keeps title, bankName, accountType, accountHolderName", () => {
    const result = applySharePermissions(
      BANK_ACCOUNT_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "BANK_ACCOUNT",
    );
    expect(Object.keys(result).sort()).toEqual([
      "accountHolderName",
      "accountType",
      "bankName",
      "title",
    ]);
    expect(result).toEqual({
      title: "Checking",
      bankName: "Test Bank",
      accountType: "checking",
      accountHolderName: "John Doe",
    });
  });
});

// ─── Entry-type-specific: IDENTITY ───────────────────────────

describe("applySharePermissions — IDENTITY", () => {
  it("HIDE_PASSWORD removes idNumber", () => {
    const result = applySharePermissions(
      IDENTITY_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "IDENTITY",
    );
    expect(result).not.toHaveProperty("idNumber");
    expect(result).toHaveProperty("fullName", "John Doe");
    expect(result).toHaveProperty("email", "john@example.com");
    expect(result).toHaveProperty("address", "123 Main St");
    expect(result).toHaveProperty("phone", "+1-555-0100");
  });

  it("OVERVIEW_ONLY keeps title, fullName, email", () => {
    const result = applySharePermissions(
      IDENTITY_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "IDENTITY",
    );
    expect(Object.keys(result).sort()).toEqual(["email", "fullName", "title"]);
  });
});

// ─── Entry-type-specific: SECURE_NOTE ────────────────────────

describe("applySharePermissions — SECURE_NOTE", () => {
  it("HIDE_PASSWORD removes content", () => {
    const result = applySharePermissions(
      SECURE_NOTE_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "SECURE_NOTE",
    );
    expect(result).not.toHaveProperty("content");
    expect(result).toHaveProperty("title", "Server Keys");
  });

  it("OVERVIEW_ONLY keeps title only", () => {
    const result = applySharePermissions(
      SECURE_NOTE_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "SECURE_NOTE",
    );
    expect(Object.keys(result)).toEqual(["title"]);
  });
});

// ─── Entry-type-specific: PASSKEY ────────────────────────────

describe("applySharePermissions — PASSKEY", () => {
  it("HIDE_PASSWORD removes credentialId", () => {
    const result = applySharePermissions(
      PASSKEY_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "PASSKEY",
    );
    expect(result).not.toHaveProperty("credentialId");
    expect(result).toHaveProperty("username", "johndoe");
    expect(result).toHaveProperty("relyingPartyName", "GitHub");
    expect(result).toHaveProperty("relyingPartyId", "github.com");
    expect(result).toHaveProperty("deviceInfo", "MacBook Pro");
  });

  it("OVERVIEW_ONLY keeps title, username, relyingPartyName", () => {
    const result = applySharePermissions(
      PASSKEY_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "PASSKEY",
    );
    expect(Object.keys(result).sort()).toEqual(["relyingPartyName", "title", "username"]);
  });
});

// ─── Entry-type-specific: SOFTWARE_LICENSE ───────────────────

describe("applySharePermissions — SOFTWARE_LICENSE", () => {
  it("HIDE_PASSWORD removes licenseKey", () => {
    const result = applySharePermissions(
      SOFTWARE_LICENSE_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "SOFTWARE_LICENSE",
    );
    expect(result).not.toHaveProperty("licenseKey");
    expect(result).toHaveProperty("softwareName", "IntelliJ IDEA");
    expect(result).toHaveProperty("version", "2025.1");
    expect(result).toHaveProperty("licensee", "John Doe");
    expect(result).toHaveProperty("email", "john@example.com");
  });

  it("OVERVIEW_ONLY keeps title, softwareName, version, licensee", () => {
    const result = applySharePermissions(
      SOFTWARE_LICENSE_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "SOFTWARE_LICENSE",
    );
    expect(Object.keys(result).sort()).toEqual(["licensee", "softwareName", "title", "version"]);
  });
});

// ─── Unknown entryType fallback (T-1) ────────────────────────

describe("applySharePermissions — unknown entryType fallback", () => {
  it("HIDE_PASSWORD with unknown entryType falls back to LOGIN behavior", () => {
    const result = applySharePermissions(
      LOGIN_DATA,
      [SHARE_PERMISSION.HIDE_PASSWORD],
      "FUTURE_TYPE",
    );
    // Should remove password (LOGIN default sensitive field)
    expect(result).not.toHaveProperty("password");
    expect(result).toHaveProperty("title", "My Login");
    expect(result).toHaveProperty("username", "user@example.com");
  });

  it("OVERVIEW_ONLY with unknown entryType falls back to LOGIN behavior", () => {
    const result = applySharePermissions(
      LOGIN_DATA,
      [SHARE_PERMISSION.OVERVIEW_ONLY],
      "FUTURE_TYPE",
    );
    // Should keep only title, username, url (LOGIN default overview fields)
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
  });

  it("unrecognized permission values apply fail-closed (OVERVIEW_ONLY)", () => {
    const result = applySharePermissions(
      LOGIN_DATA,
      ["SOME_UNKNOWN_PERMISSION"],
    );
    // Fail-closed: falls back to OVERVIEW_ONLY (most restrictive)
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("notes");
  });
});

// ─── ENTRY_TYPE_VALUES sync verification (T-2) ──────────────

describe("applySharePermissions — ENTRY_TYPE_VALUES sync", () => {
  it("SENSITIVE_FIELDS covers all entry types", () => {
    for (const entryType of ENTRY_TYPE_VALUES) {
      expect(SENSITIVE_FIELDS).toHaveProperty(entryType);
      expect(SENSITIVE_FIELDS[entryType]).toBeInstanceOf(Set);
    }
  });

  it("OVERVIEW_FIELDS covers all entry types", () => {
    for (const entryType of ENTRY_TYPE_VALUES) {
      expect(OVERVIEW_FIELDS).toHaveProperty(entryType);
      expect(OVERVIEW_FIELDS[entryType]).toBeInstanceOf(Set);
    }
  });

  it("applySharePermissions works without error for all entry types", () => {
    const sampleData = { title: "Test", password: "secret", username: "user" };
    for (const entryType of ENTRY_TYPE_VALUES) {
      // Should not throw for any valid entry type
      expect(() =>
        applySharePermissions(sampleData, [SHARE_PERMISSION.HIDE_PASSWORD], entryType),
      ).not.toThrow();
      expect(() =>
        applySharePermissions(sampleData, [SHARE_PERMISSION.OVERVIEW_ONLY], entryType),
      ).not.toThrow();
    }
  });
});

// ─── SHARE_PERMISSION_VALUES ─────────────────────────────────

describe("SHARE_PERMISSION_VALUES", () => {
  it("contains all permission values", () => {
    expect(SHARE_PERMISSION_VALUES).toContain("VIEW_ALL");
    expect(SHARE_PERMISSION_VALUES).toContain("HIDE_PASSWORD");
    expect(SHARE_PERMISSION_VALUES).toContain("OVERVIEW_ONLY");
    expect(SHARE_PERMISSION_VALUES.length).toBe(3);
  });
});
