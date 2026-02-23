import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgEntryPayload } from "@/lib/org-entry-payload";

describe("buildOrgEntryPayload", () => {
  it("builds login blobs with totp null and non-empty custom fields only", () => {
    const { fullBlob, overviewBlob } = buildOrgEntryPayload({
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
    const { fullBlob, overviewBlob } = buildOrgEntryPayload({
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
    const { fullBlob } = buildOrgEntryPayload({
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
    const { fullBlob, overviewBlob } = buildOrgEntryPayload({
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
    const { fullBlob, overviewBlob } = buildOrgEntryPayload({
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
});
