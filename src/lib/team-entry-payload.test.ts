import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildTeamEntryPayload } from "@/lib/team-entry-payload";

describe("buildTeamEntryPayload", () => {
  it("builds login blobs with totp null and non-empty custom fields only", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN,
      title: "  A  ",
      notes: "  ",
      username: " user ",
      password: "pw",
      url: " https://example.com ",
      customFields: [
        { label: "a", value: "b", type: "TEXT" },
        { label: "", value: "c", type: "TEXT" },
      ],
      totp: null,
      tagNames: [{ name: "t1", color: "#f00" }],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.title).toBe("A");
    expect(blob.username).toBe("user");
    expect(blob.password).toBe("pw");
    expect(blob.url).toBe("https://example.com");
    expect(blob.customFields).toHaveLength(1);
    expect(blob.notes).toBeNull();

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("A");
    expect(overview.username).toBe("user");
    expect(overview.urlHost).toBe("example.com");
    expect(overview.tags).toHaveLength(1);
  });

  it("builds secure note blobs with entryType", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: "Note",
      notes: "",
      content: "body",
      tagNames: [],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.SECURE_NOTE);
    expect(blob.title).toBe("Note");
    expect(blob.content).toBe("body");

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("Note");
  });

  it("builds credit card blobs with explicit entryType", () => {
    const { fullBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.CREDIT_CARD,
      title: "Card",
      notes: "",
      cardholderName: "  Jane ",
      cardNumber: "4111111111111111",
      brand: "Visa",
      expiryMonth: "01",
      expiryYear: "2030",
      cvv: "123",
      tagNames: [],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.CREDIT_CARD);
    expect(blob.cardholderName).toBe("Jane");
    expect(blob.cardNumber).toBe("4111111111111111");
    expect(blob.brand).toBe("Visa");
  });

  it("builds identity blobs with trimmed fields", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.IDENTITY,
      title: "My ID",
      notes: "",
      fullName: "  Jane Doe  ",
      email: "jane@example.com",
      phone: " +1-555-0123 ",
      address: "123 Main St",
      dateOfBirth: "1990-01-01",
      nationality: "US",
      idNumber: "A12345",
      issueDate: "2020-01-01",
      expiryDate: "2030-01-01",
      tagNames: [],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.IDENTITY);
    expect(blob.fullName).toBe("Jane Doe");
    expect(blob.phone).toBe("+1-555-0123");
    expect(blob.email).toBe("jane@example.com");
    expect(blob.idNumber).toBe("A12345");

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("My ID");
  });

  it("builds passkey blobs with all fields", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.PASSKEY,
      title: "GitHub Passkey",
      notes: "",
      username: " user@gh ",
      relyingPartyId: "github.com",
      relyingPartyName: "GitHub",
      credentialId: "cred-abc-123",
      creationDate: "2025-01-01",
      deviceInfo: " MacBook Pro ",
      tagNames: [{ name: "dev", color: "#00f" }],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(blob.relyingPartyId).toBe("github.com");
    expect(blob.relyingPartyName).toBe("GitHub");
    expect(blob.username).toBe("user@gh");
    expect(blob.credentialId).toBe("cred-abc-123");
    expect(blob.deviceInfo).toBe("MacBook Pro");

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("GitHub Passkey");
    expect(overview.username).toBe("user@gh");
  });

  it("builds bank account blobs with all fields", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "  My Bank  ",
      notes: "primary",
      bankName: " Acme Bank ",
      accountType: "checking",
      accountHolderName: " Jane Doe ",
      accountNumber: " 1234-5678-9012 ",
      routingNumber: " 021000021 ",
      swiftBic: " BOFAUS3N ",
      iban: " DE89370400440532013000 ",
      branchName: " Main Branch ",
      tagNames: [{ name: "finance", color: "#0f0" }],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.BANK_ACCOUNT);
    expect(blob.title).toBe("My Bank");
    expect(blob.bankName).toBe("Acme Bank");
    expect(blob.accountType).toBe("checking");
    expect(blob.accountHolderName).toBe("Jane Doe");
    expect(blob.accountNumber).toBe("1234-5678-9012");
    expect(blob.routingNumber).toBe("021000021");
    expect(blob.swiftBic).toBe("BOFAUS3N");
    expect(blob.iban).toBe("DE89370400440532013000");
    expect(blob.branchName).toBe("Main Branch");
    expect(blob.notes).toBe("primary");

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("My Bank");
    expect(overview.bankName).toBe("Acme Bank");
    expect(overview.accountNumberLast4).toBe("9012");
    expect(overview.tags).toHaveLength(1);
  });

  it("derives accountNumberLast4 correctly for short numbers", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Short",
      notes: "",
      accountNumber: "12",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.accountNumberLast4).toBeNull();
  });

  it("derives accountNumberLast4 from formatted input with dashes/spaces", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Formatted",
      notes: "",
      accountNumber: "1234-5678",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.accountNumberLast4).toBe("5678");
  });

  it("returns null accountNumberLast4 when accountNumber is empty", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Empty",
      notes: "",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.accountNumberLast4).toBeNull();
  });

  it("builds software license blobs with all fields", () => {
    const { fullBlob, overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: " Adobe CC ",
      notes: " annual ",
      softwareName: " Adobe Creative Cloud ",
      licenseKey: " ABCD-EFGH-IJKL ",
      version: " 2026 ",
      licensee: " Jane Doe ",
      purchaseDate: "2026-01-01",
      expirationDate: "2027-01-01",
      tagNames: [{ name: "software", color: "#f0f" }],
    });

    const blob = JSON.parse(fullBlob);
    expect(blob.entryType).toBe(ENTRY_TYPE.SOFTWARE_LICENSE);
    expect(blob.title).toBe("Adobe CC");
    expect(blob.softwareName).toBe("Adobe Creative Cloud");
    expect(blob.licenseKey).toBe("ABCD-EFGH-IJKL");
    expect(blob.version).toBe("2026");
    expect(blob.licensee).toBe("Jane Doe");
    expect(blob.purchaseDate).toBe("2026-01-01");
    expect(blob.expirationDate).toBe("2027-01-01");
    expect(blob.notes).toBe("annual");

    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("Adobe CC");
    expect(overview.softwareName).toBe("Adobe Creative Cloud");
    expect(overview.licensee).toBe("Jane Doe");
    expect(overview.tags).toHaveLength(1);
  });

  it("builds correct overviewBlob for SECURE_NOTE", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: "Note",
      notes: "",
      content: "This is the note content that is longer than 100 chars".repeat(3),
      tagNames: [{ name: "notes", color: null }],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("Note");
    expect(overview.snippet).toBeTruthy();
    expect(overview.snippet.length).toBeLessThanOrEqual(100);
    expect(overview.tags).toHaveLength(1);
  });

  it("builds correct overviewBlob for CREDIT_CARD", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.CREDIT_CARD,
      title: "My Visa",
      notes: "",
      cardholderName: " John ",
      cardNumber: "4111111111111111",
      brand: "Visa",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("My Visa");
    expect(overview.cardholderName).toBe("John");
    expect(overview.brand).toBe("Visa");
    expect(overview.lastFour).toBe("1111");
  });

  it("builds correct overviewBlob for IDENTITY with idNumberLast4", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.IDENTITY,
      title: "ID",
      notes: "",
      fullName: " Jane Doe ",
      idNumber: "A-1234-5678",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("ID");
    expect(overview.fullName).toBe("Jane Doe");
    expect(overview.idNumberLast4).toBe("5678");
  });

  it("builds correct overviewBlob for PASSKEY", () => {
    const { overviewBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.PASSKEY,
      title: "GH Key",
      notes: "",
      relyingPartyId: "github.com",
      username: " user ",
      tagNames: [],
    });
    const overview = JSON.parse(overviewBlob);
    expect(overview.title).toBe("GH Key");
    expect(overview.relyingPartyId).toBe("github.com");
    expect(overview.username).toBe("user");
  });

  it("preserves custom field type in LOGIN fullBlob", () => {
    const { fullBlob } = buildTeamEntryPayload({
      entryType: ENTRY_TYPE.LOGIN,
      title: "Test",
      notes: "",
      username: "u",
      password: "p",
      url: "",
      customFields: [
        { label: "toggle", value: "true", type: "boolean" },
        { label: "birthday", value: "2000-01-01", type: "date" },
        { label: "expiry", value: "2026-03", type: "monthYear" },
      ],
      tagNames: [],
    });
    const blob = JSON.parse(fullBlob);
    expect(blob.customFields).toHaveLength(3);
    expect(blob.customFields[0].type).toBe("boolean");
    expect(blob.customFields[1].type).toBe("date");
    expect(blob.customFields[2].type).toBe("monthYear");
  });
});
