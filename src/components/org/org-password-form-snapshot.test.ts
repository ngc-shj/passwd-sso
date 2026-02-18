import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
} from "@/components/org/org-password-form-snapshot";

describe("org-password-form-snapshot", () => {
  it("buildBaselineSnapshot serializes edit data for login entries", () => {
    const snapshot = buildBaselineSnapshot({
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      editData: {
        id: "entry-1",
        title: "Title",
        username: "user@example.com",
        password: "secret",
        url: "https://example.com",
        notes: "notes",
        tags: [
          { id: "b", name: "B", color: "#000000" },
          { id: "a", name: "A", color: "#ffffff" },
        ],
        customFields: [{ id: "cf-1", label: "L", value: "V", type: "text" }],
        totp: { secret: "totp-secret", digits: 6, period: 30, algorithm: "SHA1" },
        orgFolderId: "folder-1",
      },
      isLoginEntry: true,
      isNote: false,
      isCreditCard: false,
      isIdentity: false,
      isPasskey: false,
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(parsed.selectedTagIds).toEqual(["a", "b"]);
    expect(parsed.login.username).toBe("user@example.com");
    expect(parsed.login.password).toBe("secret");
    expect(parsed.orgFolderId).toBe("folder-1");
    expect(parsed.secureNote).toBeNull();
  });

  it("buildCurrentSnapshot serializes passkey entries", () => {
    const snapshot = buildCurrentSnapshot({
      effectiveEntryType: ENTRY_TYPE.PASSKEY,
      title: "Passkey",
      notes: "memo",
      selectedTags: [
        { id: "tag-z", name: "Z", color: "#ff0000" },
        { id: "tag-a", name: "A", color: "#00ff00" },
      ],
      orgFolderId: null,
      isLoginEntry: false,
      isNote: false,
      isCreditCard: false,
      isIdentity: false,
      isPasskey: true,
      username: "passkey-user",
      password: "",
      url: "",
      customFields: [],
      totp: null,
      content: "",
      cardholderName: "",
      cardNumber: "",
      brand: "",
      expiryMonth: "",
      expiryYear: "",
      cvv: "",
      fullName: "",
      address: "",
      phone: "",
      email: "",
      dateOfBirth: "",
      nationality: "",
      idNumber: "",
      issueDate: "",
      expiryDate: "",
      relyingPartyId: "rp.example.com",
      relyingPartyName: "Example RP",
      credentialId: "cred-123",
      creationDate: "2026-01-01",
      deviceInfo: "YubiKey",
    });

    const parsed = JSON.parse(snapshot);
    expect(parsed.entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(parsed.selectedTagIds).toEqual(["tag-a", "tag-z"]);
    expect(parsed.passkey.relyingPartyId).toBe("rp.example.com");
    expect(parsed.passkey.credentialId).toBe("cred-123");
    expect(parsed.login).toBeNull();
  });
});
