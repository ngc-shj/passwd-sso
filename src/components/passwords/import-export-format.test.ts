import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { detectFormat, parseCsv, parseJson } from "@/components/passwords/import-dialog-utils";
import {
  type ExportEntry,
  formatExportCsv,
  formatExportJson,
  PERSONAL_EXPORT_OPTIONS,
} from "@/lib/export-format-common";

const sampleLoginEntry = {
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
  tags: [{ name: "aws", color: "#ff9900" }],
  customFields: [{ label: "accountId", value: "123456789012", type: "text" }],
  totpConfig: { secret: "JBSWY3DPEHPK3PXP", issuer: "AWS" },
  generatorSettings: { length: 20 },
  passwordHistory: [{ password: "old-secret", changedAt: "2026-02-14T00:00:00.000Z" }],
  requireReprompt: false,
};

describe("import/export format compatibility", () => {
  it("detects passwd-sso CSV when passwd_sso column exists", () => {
    const format = detectFormat([
      "type",
      "name",
      "login_username",
      "login_password",
      "passwd_sso",
    ]);
    expect(format).toBe("passwd-sso");
  });

  it("detects passwd-sso JSON via top-level format field", () => {
    const json = JSON.stringify({
      format: "passwd-sso",
      version: 1,
      entries: [
        {
          type: "login",
          name: "Example",
          login: { username: "u", password: "p", uris: [{ uri: "https://example.com" }] },
          passwdSso: {
            entryType: ENTRY_TYPE.LOGIN,
            customFields: [{ label: "x", value: "y", type: "text" }],
          },
        },
      ],
    });
    const parsed = parseJson(json);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].customFields).toHaveLength(1);
  });

  it("round-trips passwd-sso CSV custom fields", () => {
    const csv = formatExportCsv(
      [sampleLoginEntry] as ExportEntry[],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const parsed = parseCsv(csv);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].customFields).toHaveLength(1);
    expect(parsed.entries[0].customFields[0].label).toBe("accountId");
  });

  it("imports CSV reprompt='1' as requireReprompt=true", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ",,login,Test,,,1,https://example.com,user,pass,",
    ].join("\n");
    const parsed = parseCsv(csv);
    expect(parsed.entries[0].requireReprompt).toBe(true);
  });

  it("imports CSV reprompt='' as requireReprompt=false", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ",,login,Test,,,,https://example.com,user,pass,",
    ].join("\n");
    const parsed = parseCsv(csv);
    expect(parsed.entries[0].requireReprompt).toBe(false);
  });

  it("imports CSV reprompt='true' as requireReprompt=false (strict)", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ",,login,Test,,,true,https://example.com,user,pass,",
    ].join("\n");
    const parsed = parseCsv(csv);
    expect(parsed.entries[0].requireReprompt).toBe(false);
  });

  it("imports JSON requireReprompt=true over reprompt=0", () => {
    const json = JSON.stringify({
      entries: [{
        type: "login",
        name: "Test",
        login: { username: "u", password: "p" },
        requireReprompt: true,
        reprompt: 0,
      }],
    });
    const parsed = parseJson(json);
    expect(parsed.entries[0].requireReprompt).toBe(true);
  });

  it("imports JSON reprompt=1 as requireReprompt=true when requireReprompt absent", () => {
    const json = JSON.stringify({
      entries: [{
        type: "login",
        name: "Test",
        login: { username: "u", password: "p" },
        reprompt: 1,
      }],
    });
    const parsed = parseJson(json);
    expect(parsed.entries[0].requireReprompt).toBe(true);
  });

  it("imports JSON requireReprompt=1 (non-boolean) as false (strict boolean)", () => {
    const json = JSON.stringify({
      entries: [{
        type: "login",
        name: "Test",
        login: { username: "u", password: "p" },
        requireReprompt: 1,
      }],
    });
    const parsed = parseJson(json);
    expect(parsed.entries[0].requireReprompt).toBe(false);
  });

  it("round-trips requireReprompt through CSV export/import", () => {
    const csv = formatExportCsv(
      [{ ...sampleLoginEntry, requireReprompt: true }] as ExportEntry[],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.csv
    );
    const parsed = parseCsv(csv);
    expect(parsed.entries[0].requireReprompt).toBe(true);
  });

  it("round-trips requireReprompt through JSON export/import", () => {
    const json = formatExportJson(
      [{ ...sampleLoginEntry, requireReprompt: true }] as ExportEntry[],
      "passwd-sso",
      PERSONAL_EXPORT_OPTIONS.json
    );
    const parsed = parseJson(json);
    expect(parsed.entries[0].requireReprompt).toBe(true);
  });

});
