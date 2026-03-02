import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  applyPolicyToGeneratorSettings,
  buildTeamLoginFormInitialValues,
} from "@/hooks/team-login-form-initial-values";

describe("buildTeamLoginFormInitialValues", () => {
  it("returns safe defaults when edit data is absent", () => {
    const result = buildTeamLoginFormInitialValues();

    expect(result.title).toBe("");
    expect(result.password).toBe("");
    expect(result.brandSource).toBe("auto");
    expect(result.showTotpInput).toBe(false);
    expect(result.teamFolderId).toBeNull();
  });

  it("maps edit data and derived flags", () => {
    const result = buildTeamLoginFormInitialValues({
      id: "e1",
      entryType: ENTRY_TYPE.LOGIN,
      title: "GitHub",
      username: "user@example.com",
      password: "secret",
      url: null,
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

  it("uses defaultFolderId when editData is absent", () => {
    const result = buildTeamLoginFormInitialValues(null, null, {
      defaultFolderId: "folder-x",
    });
    expect(result.teamFolderId).toBe("folder-x");
  });

  it("uses defaultTags when editData is absent", () => {
    const tag = { id: "t1", name: "Tag1", color: null };
    const result = buildTeamLoginFormInitialValues(null, null, {
      defaultTags: [tag],
    });
    expect(result.selectedTags).toEqual([tag]);
  });

  it("editData takes priority over defaults", () => {
    const result = buildTeamLoginFormInitialValues(
      {
        id: "e1",
        title: "Test",
        username: "",
        password: "",
        url: null,
        notes: null,
        teamFolderId: "edit-folder",
        tags: [{ id: "t2", name: "EditTag", color: null }],
      },
      null,
      {
        defaultFolderId: "default-folder",
        defaultTags: [{ id: "t1", name: "DefaultTag", color: null }],
      },
    );
    expect(result.teamFolderId).toBe("edit-folder");
    expect(result.selectedTags).toEqual([{ id: "t2", name: "EditTag", color: null }]);
  });

  it("applies required team policy constraints to existing generator settings", () => {
    const result = applyPolicyToGeneratorSettings(
      {
        mode: "password",
        length: 12,
        uppercase: false,
        lowercase: true,
        numbers: false,
        symbolGroups: {
          hashEtc: false,
          punctuation: false,
          quotes: false,
          slashDash: false,
          mathCompare: false,
          brackets: false,
        },
        excludeAmbiguous: false,
        includeChars: "",
        excludeChars: "",
        passphrase: {
          wordCount: 4,
          separator: "-",
          capitalize: true,
          includeNumber: false,
        },
      },
      {
        minPasswordLength: 20,
        requireUppercase: true,
        requireLowercase: false,
        requireNumbers: true,
        requireSymbols: true,
        requireRepromptForAll: false,
        allowExport: true,
        allowSharing: true,
      },
    );

    expect(result.length).toBe(20);
    expect(result.uppercase).toBe(true);
    expect(result.numbers).toBe(true);
    expect(result.symbolGroups.hashEtc).toBe(true);
    expect(result.symbolGroups.punctuation).toBe(true);
  });
});
