import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { buildTeamPasswordFormInitialValues } from "@/hooks/team-password-form-initial-values";

describe("buildTeamPasswordFormInitialValues", () => {
  it("returns safe defaults when edit data is absent", () => {
    const result = buildTeamPasswordFormInitialValues();

    expect(result.title).toBe("");
    expect(result.password).toBe("");
    expect(result.brandSource).toBe("auto");
    expect(result.showTotpInput).toBe(false);
    expect(result.teamFolderId).toBeNull();
  });

  it("maps edit data and derived flags", () => {
    const result = buildTeamPasswordFormInitialValues({
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
      teamFolderId: "f1",
    });

    expect(result.title).toBe("GitHub");
    expect(result.username).toBe("user@example.com");
    expect(result.notes).toBe("note");
    expect(result.brandSource).toBe("manual");
    expect(result.showTotpInput).toBe(true);
    expect(result.teamFolderId).toBe("f1");
    expect(result.cardNumber).toContain("4242");
  });
});
