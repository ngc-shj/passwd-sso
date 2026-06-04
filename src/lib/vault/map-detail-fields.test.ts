import { describe, it, expect } from "vitest";
import { mapDecryptedBlobToDetailFields } from "./map-detail-fields";

describe("mapDecryptedBlobToDetailFields", () => {
  it("maps the structured IDENTITY fields (regression: structured address must not be dropped)", () => {
    const blob = {
      givenName: "Taro",
      familyName: "Yamada",
      middleName: "M",
      familyNameKana: "ヤマダ",
      givenNameKana: "タロウ",
      addressLine1: "1-2-3 Chuo",
      addressLine2: "Apt 4",
      city: "Yokohama",
      state: "Kanagawa",
      postalCode: "220-0000",
      country: "JP",
      fullName: "Yamada Taro",
      address: "legacy address",
      idNumber: "DL-12345",
    };
    const result = mapDecryptedBlobToDetailFields(blob);
    for (const [key, value] of Object.entries(blob)) {
      expect(result[key as keyof typeof result]).toBe(value);
    }
  });

  it("maps a representative field from every entry type", () => {
    const blob = {
      password: "pw",
      content: "note body",
      cardNumber: "4111",
      relyingPartyId: "example.com",
      accountNumber: "ACCT-1",
      licenseKey: "LIC-1",
      fingerprint: "SHA256:abc",
    };
    const result = mapDecryptedBlobToDetailFields(blob);
    expect(result.password).toBe("pw");
    expect(result.content).toBe("note body");
    expect(result.cardNumber).toBe("4111");
    expect(result.relyingPartyId).toBe("example.com");
    expect(result.accountNumber).toBe("ACCT-1");
    expect(result.licenseKey).toBe("LIC-1");
    expect(result.fingerprint).toBe("SHA256:abc");
  });

  it("maps SSH blob keys (passphrase/comment) to the display keys (sshPassphrase/sshComment)", () => {
    const result = mapDecryptedBlobToDetailFields({ passphrase: "pp", comment: "my key" });
    expect(result.sshPassphrase).toBe("pp");
    expect(result.sshComment).toBe("my key");
  });

  it("defaults required fields when absent (password '', url/notes null, customFields [])", () => {
    const result = mapDecryptedBlobToDetailFields({});
    expect(result.password).toBe("");
    expect(result.url).toBeNull();
    expect(result.notes).toBeNull();
    expect(result.customFields).toEqual([]);
  });
});
