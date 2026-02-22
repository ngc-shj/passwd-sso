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
