import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  type ExportEntry,
  formatExportCsv,
  formatExportJson,
  TEAM_EXPORT_OPTIONS,
  PERSONAL_EXPORT_OPTIONS,
} from "@/lib/export-format-common";

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
});
