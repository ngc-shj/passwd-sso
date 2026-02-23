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
});
