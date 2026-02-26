import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildOrgPasswordFormInitialValues } from "@/hooks/team-password-form-initial-values";

describe("buildOrgPasswordFormInitialValues", () => {
  it("returns safe defaults when edit data is absent", () => {
    const result = buildOrgPasswordFormInitialValues();

    expect(result.title).toBe("");
    expect(result.password).toBe("");
    expect(result.brandSource).toBe("auto");
    expect(result.showTotpInput).toBe(false);
    expect(result.orgFolderId).toBeNull();
  });

  it("maps edit data and derived flags", () => {
    const result = buildOrgPasswordFormInitialValues({
      id: "e1",
      entryType: ENTRY_TYPE.LOGIN,
      title: "GitHub",
      username: "user@example.com",
      password: "secret",
      notes: "note",
      brand: "visa",
      cardNumber: "4242424242424242",
      totp: {
        secret: "JBSWY3DPEHPK3PXP",
        digits: 6,
        period: 30,
        algorithm: "SHA1",
      },
      orgFolderId: "f1",
    });

    expect(result.title).toBe("GitHub");
    expect(result.username).toBe("user@example.com");
    expect(result.notes).toBe("note");
    expect(result.brandSource).toBe("manual");
    expect(result.showTotpInput).toBe(true);
    expect(result.orgFolderId).toBe("f1");
    expect(result.cardNumber).toContain("4242");
  });
});
