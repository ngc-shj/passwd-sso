import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { __testablesImport } from "@/components/passwords/import-dialog";
import { __testablesPersonalExport } from "@/components/passwords/export-dialog";
import { __testablesOrgExport } from "@/components/org/org-export-dialog";

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
};

describe("import/export format compatibility", () => {
  it("detects passwd-sso CSV when passwd_sso column exists", () => {
    const format = __testablesImport.detectFormat([
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
    const parsed = __testablesImport.parseJson(json);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].customFields).toHaveLength(1);
  });

  it("exports compatible profile without passwd-sso payloads", () => {
    const personalJson = __testablesPersonalExport.formatJson(
      [sampleLoginEntry] as never,
      "compatible"
    );
    const parsed = JSON.parse(personalJson);
    expect(parsed.format).toBeUndefined();
    expect(parsed.entries[0].passwdSso).toBeUndefined();

    const personalCsv = __testablesPersonalExport.formatCsv(
      [sampleLoginEntry] as never,
      "compatible"
    );
    expect(personalCsv.split("\n")[0]).not.toContain("passwd_sso");
  });

  it("round-trips passwd-sso CSV custom fields", () => {
    const csv = __testablesPersonalExport.formatCsv(
      [sampleLoginEntry] as never,
      "passwd-sso"
    );
    const parsed = __testablesImport.parseCsv(csv);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].customFields).toHaveLength(1);
    expect(parsed.entries[0].customFields[0].label).toBe("accountId");
  });

  it("org export supports passwd-sso profile envelope", () => {
    const orgJson = __testablesOrgExport.formatJson(
      [sampleLoginEntry] as never,
      "passwd-sso"
    );
    const parsed = JSON.parse(orgJson);
    expect(parsed.format).toBe("passwd-sso");
    expect(parsed.entries[0].passwdSso).toBeDefined();
  });
});
