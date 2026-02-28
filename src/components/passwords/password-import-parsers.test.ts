import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  parsePasswdSsoPayload,
  detectFormat,
  parseCsvLine,
  parseCsv,
  parseJson,
  formatLabels,
} from "./password-import-parsers";

// ─── parsePasswdSsoPayload ───────────────────────────────────

describe("parsePasswdSsoPayload", () => {
  it("returns empty object for undefined input", () => {
    expect(parsePasswdSsoPayload(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parsePasswdSsoPayload("")).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    expect(parsePasswdSsoPayload("{bad}")).toEqual({});
  });

  it("returns empty object for non-object JSON", () => {
    expect(parsePasswdSsoPayload('"string"')).toEqual({});
  });

  it("parses tags, customFields, and totp", () => {
    const payload = JSON.stringify({
      tags: [{ name: "Work" }],
      customFields: [{ label: "key", value: "val" }],
      totp: { secret: "ABC123" },
    });
    const result = parsePasswdSsoPayload(payload);
    expect(result.tags).toEqual([{ name: "Work" }]);
    expect(result.customFields).toEqual([{ label: "key", value: "val" }]);
    expect(result.totp).toEqual({ secret: "ABC123" });
  });

  it("returns null for invalid totp", () => {
    const payload = JSON.stringify({ totp: "invalid" });
    const result = parsePasswdSsoPayload(payload);
    expect(result.totp).toBeNull();
  });

  it("parses credit card fields as strings", () => {
    const payload = JSON.stringify({
      cardholderName: "John",
      cardNumber: "4111111111111111",
      brand: "Visa",
    });
    const result = parsePasswdSsoPayload(payload);
    expect(result.cardholderName).toBe("John");
    expect(result.cardNumber).toBe("4111111111111111");
    expect(result.brand).toBe("Visa");
  });

  it("defaults non-string fields to empty string", () => {
    const payload = JSON.stringify({ cardholderName: 123 });
    const result = parsePasswdSsoPayload(payload);
    expect(result.cardholderName).toBe("");
  });

  it("parses requireReprompt boolean", () => {
    const payload = JSON.stringify({ requireReprompt: true });
    const result = parsePasswdSsoPayload(payload);
    expect(result.requireReprompt).toBe(true);
  });

  it("parses isFavorite boolean", () => {
    const payload = JSON.stringify({ isFavorite: true });
    const result = parsePasswdSsoPayload(payload);
    expect(result.isFavorite).toBe(true);
  });

  it("parses expiresAt string", () => {
    const payload = JSON.stringify({ expiresAt: "2027-01-01T00:00:00.000Z" });
    const result = parsePasswdSsoPayload(payload);
    expect(result.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("ignores non-string expiresAt", () => {
    const payload = JSON.stringify({ expiresAt: 12345 });
    const result = parsePasswdSsoPayload(payload);
    expect(result.expiresAt).toBeUndefined();
  });
});

// ─── detectFormat ────────────────────────────────────────────

describe("detectFormat", () => {
  it("detects passwd-sso format", () => {
    expect(detectFormat(["name", "passwd_sso"])).toBe("passwd-sso");
  });

  it("detects bitwarden format", () => {
    expect(detectFormat(["name", "login_username", "login_password"])).toBe("bitwarden");
  });

  it("detects 1password format", () => {
    expect(detectFormat(["title", "username", "password"])).toBe("onepassword");
  });

  it("detects chrome format", () => {
    expect(detectFormat(["name", "username", "password", "url"])).toBe("chrome");
  });

  it("returns unknown for unrecognized format", () => {
    expect(detectFormat(["col1", "col2"])).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(detectFormat(["NAME", "LOGIN_USERNAME", "LOGIN_PASSWORD"])).toBe("bitwarden");
  });
});

// ─── parseCsvLine ────────────────────────────────────────────

describe("parseCsvLine", () => {
  it("parses simple comma-separated values", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles quoted fields", () => {
    expect(parseCsvLine('"hello world",b')).toEqual(["hello world", "b"]);
  });

  it("handles escaped quotes within quoted fields", () => {
    expect(parseCsvLine('"say ""hello""",b')).toEqual(['say "hello"', "b"]);
  });

  it("handles commas within quoted fields", () => {
    expect(parseCsvLine('"a,b",c')).toEqual(["a,b", "c"]);
  });

  it("handles empty fields", () => {
    expect(parseCsvLine(",,"  )).toEqual(["", "", ""]);
  });
});

// ─── parseCsv ────────────────────────────────────────────────

describe("parseCsv", () => {
  it("returns empty for single-line input", () => {
    const result = parseCsv("header1,header2");
    expect(result.entries).toEqual([]);
  });

  it("parses bitwarden CSV format", () => {
    const csv = [
      "name,login_username,login_password,login_uri,notes",
      "Gmail,user@gmail.com,pass123,https://gmail.com,my email",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.format).toBe("bitwarden");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe("Gmail");
    expect(result.entries[0].username).toBe("user@gmail.com");
    expect(result.entries[0].password).toBe("pass123");
    expect(result.entries[0].url).toBe("https://gmail.com");
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.LOGIN);
  });

  it("parses chrome CSV format", () => {
    const csv = [
      "name,username,password,url",
      "Site,admin,secret,https://example.com",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.format).toBe("chrome");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.LOGIN);
  });

  it("detects secure note type", () => {
    const csv = [
      "name,login_username,login_password,type,notes",
      "My Note,,,securenote,Secret text",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.SECURE_NOTE);
    expect(result.entries[0].content).toBe("Secret text");
  });

  it("skips login entries without password", () => {
    const csv = [
      "name,login_username,login_password,login_uri",
      "No Pass,user,,https://example.com",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(0);
  });

  it("allows notes/cards/identities without password", () => {
    const csv = [
      "name,login_username,login_password,type,notes",
      "My Note,,,note,Some content",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(1);
  });

  it("handles TOTP from login_totp column", () => {
    const csv = [
      "name,login_username,login_password,login_totp",
      "Site,user,pass123,otpauth://totp/test",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].totp).toEqual({ secret: "otpauth://totp/test" });
  });

  it("applies passwd_sso payload overrides", () => {
    const extra = JSON.stringify({ requireReprompt: true });
    const csv = [
      "name,login_username,login_password,passwd_sso",
      `Site,user,pass123,"${extra.replace(/"/g, '""')}"`,
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].requireReprompt).toBe(true);
  });

  it("sets reprompt from reprompt column", () => {
    const csv = [
      "name,login_username,login_password,reprompt",
      "Site,user,pass123,1",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].requireReprompt).toBe(true);
  });

  it("reads folder column into folderPath", () => {
    const csv = [
      "folder,name,login_username,login_password",
      "Work / Email,Gmail,user@gmail.com,pass123",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].folderPath).toBe("Work / Email");
  });

  it("reads favorite column into isFavorite", () => {
    const csv = [
      "favorite,name,login_username,login_password",
      "1,Gmail,user@gmail.com,pass123",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].isFavorite).toBe(true);
  });

  it("defaults folderPath to empty and isFavorite to false", () => {
    const csv = [
      "name,login_username,login_password",
      "Site,user,pass123",
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries[0].folderPath).toBe("");
    expect(result.entries[0].isFavorite).toBe(false);
  });
});

// ─── parseJson ───────────────────────────────────────────────

describe("parseJson", () => {
  it("returns empty for invalid JSON", () => {
    const result = parseJson("{bad}");
    expect(result.entries).toEqual([]);
    expect(result.format).toBe("unknown");
  });

  it("parses bitwarden JSON login entry", () => {
    const json = JSON.stringify([
      {
        name: "Gmail",
        login: {
          username: "user@gmail.com",
          password: "pass123",
          uris: [{ uri: "https://gmail.com" }],
        },
        notes: "my email",
      },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe("Gmail");
    expect(result.entries[0].url).toBe("https://gmail.com");
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.LOGIN);
  });

  it("parses secure note (type=2)", () => {
    const json = JSON.stringify([
      { name: "My Note", type: 2, notes: "Secret content" },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.SECURE_NOTE);
    expect(result.entries[0].content).toBe("Secret content");
  });

  it("parses credit card (type=3)", () => {
    const json = JSON.stringify([
      {
        name: "My Card",
        type: 3,
        card: {
          cardholderName: "John",
          number: "4111111111111111",
          brand: "Visa",
          expMonth: "12",
          expYear: "2030",
          code: "123",
        },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.CREDIT_CARD);
    expect(result.entries[0].cardNumber).toBe("4111111111111111");
    expect(result.entries[0].cvv).toBe("123");
  });

  it("parses identity (type=4)", () => {
    const json = JSON.stringify([
      {
        name: "My ID",
        type: 4,
        identity: {
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
          phone: "555-0123",
        },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.IDENTITY);
    expect(result.entries[0].fullName).toBe("John Doe");
    expect(result.entries[0].email).toBe("john@example.com");
  });

  it("parses passkey entry", () => {
    const json = JSON.stringify([
      {
        name: "My Passkey",
        type: "passkey",
        passkey: {
          relyingPartyId: "example.com",
          credentialId: "cred-123",
        },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(result.entries[0].relyingPartyId).toBe("example.com");
  });

  it("detects passwd-sso format from wrapper", () => {
    const json = JSON.stringify({
      format: "passwd-sso",
      entries: [
        { name: "Site", login: { username: "u", password: "p" } },
      ],
    });

    const result = parseJson(json);
    expect(result.format).toBe("passwd-sso");
  });

  it("skips login entries without title or password", () => {
    const json = JSON.stringify([
      { name: "", login: { username: "u", password: "p" } },
      { name: "Site", login: { username: "u", password: "" } },
    ]);

    const result = parseJson(json);
    expect(result.entries).toHaveLength(0);
  });

  it("handles TOTP in login", () => {
    const json = JSON.stringify([
      {
        name: "Site",
        login: {
          username: "u",
          password: "p",
          totp: "JBSWY3DPEHPK3PXP",
        },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries[0].totp).toEqual({ secret: "JBSWY3DPEHPK3PXP" });
  });

  it("reads folder and favorite from top-level fields", () => {
    const json = JSON.stringify([
      {
        name: "Site",
        folder: "Work / Email",
        favorite: true,
        login: { username: "u", password: "p" },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries[0].folderPath).toBe("Work / Email");
    expect(result.entries[0].isFavorite).toBe(true);
  });

  it("reads expiresAt from passwdSso envelope", () => {
    const json = JSON.stringify({
      format: "passwd-sso",
      entries: [
        {
          name: "Site",
          login: { username: "u", password: "p" },
          passwdSso: { expiresAt: "2027-06-01T00:00:00.000Z" },
        },
      ],
    });

    const result = parseJson(json);
    expect(result.entries[0].expiresAt).toBe("2027-06-01T00:00:00.000Z");
  });

  it("defaults folderPath/isFavorite/expiresAt when absent", () => {
    const json = JSON.stringify([
      {
        name: "Site",
        login: { username: "u", password: "p" },
      },
    ]);

    const result = parseJson(json);
    expect(result.entries[0].folderPath).toBe("");
    expect(result.entries[0].isFavorite).toBe(false);
    expect(result.entries[0].expiresAt).toBeNull();
  });
});

// ─── Passkey CSV ────────────────────────────────────────────

describe("parseCsv — passkey", () => {
  it("detects passkey type in passwd-sso CSV", () => {
    const extra = JSON.stringify({
      entryType: "PASSKEY",
      relyingPartyId: "example.com",
      relyingPartyName: "Example",
    });
    const csv = [
      "name,login_username,login_password,type,passwd_sso",
      `My Passkey,alice,,passkey,"${extra.replace(/"/g, '""')}"`,
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(result.entries[0].title).toBe("My Passkey");
  });
});

// ─── Bank Account / Software License ────────────────────────

describe("parseCsv — bank account / software license", () => {
  it("detects bankaccount type in passwd-sso CSV", () => {
    const extra = JSON.stringify({
      entryType: "BANK_ACCOUNT",
      bankName: "Acme Bank",
      accountNumber: "123456789",
    });
    const csv = [
      "name,login_username,login_password,type,passwd_sso",
      `My Bank,,,bankaccount,"${extra.replace(/"/g, '""')}"`,
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(result.entries[0].title).toBe("My Bank");
  });

  it("detects softwarelicense type in passwd-sso CSV", () => {
    const extra = JSON.stringify({
      entryType: "SOFTWARE_LICENSE",
      softwareName: "Adobe CC",
      licenseKey: "ABCD-EFGH",
    });
    const csv = [
      "name,login_username,login_password,type,passwd_sso",
      `Adobe,,,softwarelicense,"${extra.replace(/"/g, '""')}"`,
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(result.entries[0].title).toBe("Adobe");
  });
});

describe("parseJson — bank account / software license", () => {
  it("parses bank account entry in passwd-sso JSON format", () => {
    const json = JSON.stringify({
      format: "passwd-sso",
      entries: [
        {
          type: "bankaccount",
          name: "My Bank",
          bankAccount: {
            bankName: "Acme Bank",
            accountNumber: "123456789",
          },
          notes: "primary account",
        },
      ],
    });

    const result = parseJson(json);
    expect(result.format).toBe("passwd-sso");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(result.entries[0].title).toBe("My Bank");
    expect(result.entries[0].bankName).toBe("Acme Bank");
    expect(result.entries[0].accountNumber).toBe("123456789");
  });

  it("parses software license entry in passwd-sso JSON format", () => {
    const json = JSON.stringify({
      format: "passwd-sso",
      entries: [
        {
          type: "softwarelicense",
          name: "Adobe CC",
          softwareLicense: {
            softwareName: "Adobe Creative Cloud",
            licenseKey: "ABCD-EFGH",
            version: "2026",
          },
          notes: "annual license",
        },
      ],
    });

    const result = parseJson(json);
    expect(result.format).toBe("passwd-sso");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(result.entries[0].title).toBe("Adobe CC");
    expect(result.entries[0].softwareName).toBe("Adobe Creative Cloud");
    expect(result.entries[0].licenseKey).toBe("ABCD-EFGH");
    expect(result.entries[0].version).toBe("2026");
  });
});

describe("parsePasswdSsoPayload — bank account / software license fields", () => {
  it("parses bank account fields from payload", () => {
    const payload = JSON.stringify({
      bankName: "Test Bank",
      accountType: "savings",
      accountHolderName: "John",
      accountNumber: "9876543210",
      routingNumber: "021000021",
      swiftBic: "BOFAUS3N",
      iban: "DE89370400440532013000",
      branchName: "Downtown",
    });
    const result = parsePasswdSsoPayload(payload);
    expect(result.bankName).toBe("Test Bank");
    expect(result.accountType).toBe("savings");
    expect(result.accountHolderName).toBe("John");
    expect(result.accountNumber).toBe("9876543210");
    expect(result.routingNumber).toBe("021000021");
    expect(result.swiftBic).toBe("BOFAUS3N");
    expect(result.iban).toBe("DE89370400440532013000");
    expect(result.branchName).toBe("Downtown");
  });

  it("parses software license fields from payload", () => {
    const payload = JSON.stringify({
      softwareName: "VS Code",
      licenseKey: "KEY-123",
      version: "1.90",
      licensee: "Jane",
      purchaseDate: "2026-01-01",
      expirationDate: "2027-01-01",
    });
    const result = parsePasswdSsoPayload(payload);
    expect(result.softwareName).toBe("VS Code");
    expect(result.licenseKey).toBe("KEY-123");
    expect(result.version).toBe("1.90");
    expect(result.licensee).toBe("Jane");
    expect(result.purchaseDate).toBe("2026-01-01");
    expect(result.expirationDate).toBe("2027-01-01");
  });

  it("defaults non-string bank/license fields to empty string", () => {
    const payload = JSON.stringify({ bankName: 123, softwareName: true });
    const result = parsePasswdSsoPayload(payload);
    expect(result.bankName).toBe("");
    expect(result.softwareName).toBe("");
  });
});

// ─── Edge cases ─────────────────────────────────────────────

describe("parseCsvLine — edge cases", () => {
  it("handles BOM prefix in first field", () => {
    const line = "\uFEFFname,user,pass";
    const fields = parseCsvLine(line);
    // BOM is preserved by parseCsvLine (stripping is the caller's job)
    expect(fields[0]).toBe("\uFEFFname");
    expect(fields).toHaveLength(3);
  });

  it("handles empty string input", () => {
    const fields = parseCsvLine("");
    expect(fields).toEqual([""]);
  });
});

describe("parseCsv — edge cases", () => {
  it("returns empty entries for header-only input", () => {
    const result = parseCsv("name,username,password");
    expect(result.entries).toEqual([]);
    expect(result.format).toBe("unknown");
  });

  it("skips rows with fewer than 2 fields", () => {
    const csv = "name,username,password\nAlone";
    const result = parseCsv(csv);
    expect(result.entries).toHaveLength(0);
  });

  it("handles BOM at start of file", () => {
    const csv = "\uFEFFname,username,password,url\nTest,user,pass123,https://x.com";
    const result = parseCsv(csv);
    // BOM prepended to first header — detectFormat may miss if headers depend on exact match
    // The parser should still produce entries even if format is "unknown"
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.entries[0].title).toBe("Test");
  });
});

describe("parseJson — edge cases", () => {
  it("returns empty entries for non-array non-object JSON", () => {
    expect(parseJson('"hello"').entries).toEqual([]);
    expect(parseJson("42").entries).toEqual([]);
    expect(parseJson("true").entries).toEqual([]);
    expect(parseJson("null").entries).toEqual([]);
  });

  it("returns empty entries for invalid JSON", () => {
    const result = parseJson("not valid json {[");
    expect(result.entries).toEqual([]);
    expect(result.format).toBe("unknown");
  });
});

// ─── formatLabels ────────────────────────────────────────────

describe("formatLabels", () => {
  it("has labels for all known formats", () => {
    expect(formatLabels.bitwarden).toBe("Bitwarden");
    expect(formatLabels.onepassword).toBe("1Password");
    expect(formatLabels.chrome).toBe("Chrome");
    expect(formatLabels["passwd-sso"]).toBe("passwd-sso");
    expect(formatLabels.unknown).toBe("CSV");
  });
});
