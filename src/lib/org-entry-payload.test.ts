import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgEntryPayload } from "@/lib/org-entry-payload";

describe("buildOrgEntryPayload", () => {
  it("builds login payload with totp null and non-empty custom fields only", () => {
    const payload = buildOrgEntryPayload({
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
      tagIds: ["t1"],
      orgFolderId: null,
    });

    expect(payload).toMatchObject({
      title: "A",
      username: "user",
      password: "pw",
      url: "https://example.com",
      tagIds: ["t1"],
      orgFolderId: null,
      totp: null,
    });
    expect(payload).toHaveProperty("customFields");
    expect((payload.customFields as unknown[]).length).toBe(1);
  });

  it("builds secure note payload with entryType", () => {
    const payload = buildOrgEntryPayload({
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: "Note",
      notes: "",
      content: "body",
      tagIds: [],
      orgFolderId: "f1",
    });
    expect(payload).toMatchObject({
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: "Note",
      content: "body",
      orgFolderId: "f1",
    });
  });

  it("builds credit card payload with explicit entryType", () => {
    const payload = buildOrgEntryPayload({
      entryType: ENTRY_TYPE.CREDIT_CARD,
      title: "Card",
      notes: "",
      cardholderName: "  Jane ",
      cardNumber: "4111111111111111",
      brand: "Visa",
      expiryMonth: "01",
      expiryYear: "2030",
      cvv: "123",
      tagIds: [],
      orgFolderId: null,
    });
    expect(payload).toMatchObject({
      entryType: ENTRY_TYPE.CREDIT_CARD,
      cardholderName: "Jane",
      cardNumber: "4111111111111111",
      brand: "Visa",
    });
  });
});

