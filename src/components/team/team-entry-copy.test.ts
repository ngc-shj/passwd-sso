import { describe, expect, it } from "vitest";
import { buildTeamEntryCopy } from "@/components/team/team-entry-copy";

describe("buildTeamEntryCopy", () => {
  const copyByKind = {
    password: {
      edit: "Edit password",
      create: "Create password",
      titleLabel: "Title",
      titlePlaceholder: "Title placeholder",
      notesLabel: "Notes",
      notesPlaceholder: "Notes placeholder",
      tagsTitle: "Tags",
    },
    secureNote: {
      edit: "Edit note",
      create: "Create note",
      titleLabel: "Note title",
      titlePlaceholder: "Note title placeholder",
      notesLabel: "Note body",
      notesPlaceholder: "Note body placeholder",
      tagsTitle: "Note tags",
    },
    creditCard: {
      edit: "Edit card",
      create: "Create card",
      titleLabel: "Card title",
      titlePlaceholder: "Card title placeholder",
      notesLabel: "Card notes",
      notesPlaceholder: "Card notes placeholder",
      tagsTitle: "Card tags",
    },
    identity: {
      edit: "Edit identity",
      create: "Create identity",
      titleLabel: "Identity title",
      titlePlaceholder: "Identity title placeholder",
      notesLabel: "Identity notes",
      notesPlaceholder: "Identity notes placeholder",
      tagsTitle: "Identity tags",
    },
    passkey: {
      edit: "Edit passkey",
      create: "Create passkey",
      titleLabel: "Passkey title",
      titlePlaceholder: "Passkey title placeholder",
      notesLabel: "Passkey notes",
      notesPlaceholder: "Passkey notes placeholder",
      tagsTitle: "Passkey tags",
    },
    bankAccount: {
      edit: "Edit bank account",
      create: "Create bank account",
      titleLabel: "Bank title",
      titlePlaceholder: "Bank title placeholder",
      notesLabel: "Bank notes",
      notesPlaceholder: "Bank notes placeholder",
      tagsTitle: "Bank tags",
    },
    softwareLicense: {
      edit: "Edit license",
      create: "Create license",
      titleLabel: "License title",
      titlePlaceholder: "License title placeholder",
      notesLabel: "License notes",
      notesPlaceholder: "License notes placeholder",
      tagsTitle: "License tags",
    },
  } as const;

  it("returns edit labels for edit mode", () => {
    const result = buildTeamEntryCopy({
      isEdit: true,
      entryKind: "identity",
      copyByKind,
    });

    expect(result.dialogLabel).toBe("Edit identity");
    expect(result.titleLabel).toBe("Identity title");
    expect(result.tagsTitle).toBe("Identity tags");
  });

  it("returns create labels for create mode", () => {
    const result = buildTeamEntryCopy({
      isEdit: false,
      entryKind: "passkey",
      copyByKind,
    });

    expect(result.dialogLabel).toBe("Create passkey");
    expect(result.notesLabel).toBe("Passkey notes");
    expect(result.notesPlaceholder).toBe("Passkey notes placeholder");
  });
});
