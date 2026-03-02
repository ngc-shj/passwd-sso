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

  it("uses defaultFolderId when editData is absent", () => {
    const result = buildTeamPasswordFormInitialValues(null, null, {
      defaultFolderId: "folder-x",
    });
    expect(result.teamFolderId).toBe("folder-x");
  });

  it("uses defaultTags when editData is absent", () => {
    const tag = { id: "t1", name: "Tag1", color: null };
    const result = buildTeamPasswordFormInitialValues(null, null, {
      defaultTags: [tag],
    });
    expect(result.selectedTags).toEqual([tag]);
  });

  it("editData takes priority over defaults", () => {
    const result = buildTeamPasswordFormInitialValues(
      {
        id: "e1",
        title: "Test",
        username: "",
        password: "",
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
});
