import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import type { GeneratorSettings } from "@/lib/generator-prefs";
import { buildTeamLoginFormDerived } from "@/hooks/team-login-form-derived";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function tGen(key: "modePassphrase" | "modePassword"): string {
  return key === "modePassword" ? "Password" : "Passphrase";
}

interface BuildArgsOverrides {
  editData?: TeamEntryFormEditData | null;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
  title?: string;
  notes?: string;
  username?: string;
  password?: string;
  url?: string;
  customFields?: EntryCustomField[];
  totp?: EntryTotp | null;
  selectedTags?: TeamTagData[];
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  travelSafe?: boolean;
  expiresAt?: string | null;
  generatorSettings?: GeneratorSettings;
}

/** Builds args that match an existing editData (no diff by default). */
function buildArgsWithEdit(overrides: BuildArgsOverrides = {}) {
  const editData: TeamEntryFormEditData = overrides.editData ?? {
    id: "entry-1",
    title: "My Title",
    username: "user",
    password: "pass",
    url: "https://example.com",
    notes: "some notes",
    tags: [{ id: "t1", name: "work", color: null }],
    customFields: [],
    totp: null,
    teamFolderId: "folder-1",
    requireReprompt: false,
    expiresAt: null,
  };

  return {
    editData,
    defaultFolderId: overrides.defaultFolderId ?? undefined,
    defaultTags: overrides.defaultTags ?? undefined,
    title: overrides.title ?? (editData.title ?? ""),
    notes: overrides.notes ?? (editData.notes ?? ""),
    username: overrides.username ?? (editData.username ?? ""),
    password: overrides.password ?? editData.password,
    url: overrides.url ?? (editData.url ?? ""),
    customFields: overrides.customFields ?? (editData.customFields ?? []),
    totp: overrides.totp ?? (editData.totp ?? null),
    selectedTags: overrides.selectedTags ?? (editData.tags ?? []),
    teamFolderId: overrides.teamFolderId ?? (editData.teamFolderId ?? null),
    requireReprompt: overrides.requireReprompt ?? (editData.requireReprompt ?? false),
    travelSafe: overrides.travelSafe ?? (editData.travelSafe ?? true),
    expiresAt: overrides.expiresAt ?? (editData.expiresAt ?? null),
    generatorSettings: overrides.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
    tGen,
  };
}

/** Builds args for create mode (no editData). */
function buildArgsCreate(overrides: BuildArgsOverrides = {}) {
  return {
    editData: undefined,
    defaultFolderId: overrides.defaultFolderId ?? undefined,
    defaultTags: overrides.defaultTags ?? undefined,
    title: overrides.title ?? "",
    notes: overrides.notes ?? "",
    username: overrides.username ?? "",
    password: overrides.password ?? "",
    url: overrides.url ?? "",
    customFields: overrides.customFields ?? [],
    totp: overrides.totp ?? null,
    selectedTags: overrides.selectedTags ?? [],
    teamFolderId: overrides.teamFolderId ?? null,
    requireReprompt: overrides.requireReprompt ?? false,
    travelSafe: overrides.travelSafe ?? true,
    expiresAt: overrides.expiresAt ?? null,
    generatorSettings: overrides.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
    tGen,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildTeamLoginFormDerived", () => {
  /* ---------- hasChanges: edit mode ---------- */

  describe("hasChanges (edit mode)", () => {
    it("returns false when values match editData", () => {
      const result = buildTeamLoginFormDerived(buildArgsWithEdit());
      expect(result.hasChanges).toBe(false);
    });

    it("detects title change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ title: "Changed Title" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects username change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ username: "new-user" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects password change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ password: "new-pass" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects url change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ url: "https://other.com" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects notes change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ notes: "updated notes" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects teamFolderId change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ teamFolderId: "folder-999" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects tag addition", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({
          selectedTags: [
            { id: "t1", name: "work", color: null },
            { id: "t2", name: "personal", color: null },
          ],
        }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects tag removal", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ selectedTags: [] }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects requireReprompt change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ requireReprompt: true }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects expiresAt change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ expiresAt: "2025-12-31T00:00:00Z" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects customFields change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({
          customFields: [{ label: "field1", value: "val1", type: "text" }],
        }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("detects totp change", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({ totp: { secret: "JBSWY3DPEHPK3PXP" } }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("ignores tag order (compares sorted IDs)", () => {
      const editData: TeamEntryFormEditData = {
        id: "entry-1",
        title: "T",
        username: "u",
        password: "p",
        url: "",
        notes: "",
        tags: [
          { id: "t1", name: "a", color: null },
          { id: "t2", name: "b", color: null },
        ],
        customFields: [],
        totp: null,
        teamFolderId: null,
        requireReprompt: false,
        expiresAt: null,
      };
      const result = buildTeamLoginFormDerived(
        buildArgsWithEdit({
          editData,
          selectedTags: [
            { id: "t2", name: "b", color: null },
            { id: "t1", name: "a", color: null },
          ],
        }),
      );
      expect(result.hasChanges).toBe(false);
    });
  });

  /* ---------- hasChanges: create mode ---------- */

  describe("hasChanges (create mode)", () => {
    it("returns false when all values are empty defaults", () => {
      const result = buildTeamLoginFormDerived(buildArgsCreate());
      expect(result.hasChanges).toBe(false);
    });

    it("detects title change from empty", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({ title: "New Entry" }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("returns false when teamFolderId matches defaultFolderId", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({
          defaultFolderId: "df-1",
          teamFolderId: "df-1",
        }),
      );
      expect(result.hasChanges).toBe(false);
    });

    it("detects teamFolderId difference from defaultFolderId", () => {
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({
          defaultFolderId: "df-1",
          teamFolderId: "df-2",
        }),
      );
      expect(result.hasChanges).toBe(true);
    });

    it("returns false when selectedTags matches defaultTags", () => {
      const tag: TeamTagData = { id: "t1", name: "work", color: null };
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({
          defaultTags: [tag],
          selectedTags: [tag],
        }),
      );
      expect(result.hasChanges).toBe(false);
    });

    it("detects tag difference from defaultTags", () => {
      const tag1: TeamTagData = { id: "t1", name: "work", color: null };
      const tag2: TeamTagData = { id: "t2", name: "personal", color: null };
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({
          defaultTags: [tag1],
          selectedTags: [tag2],
        }),
      );
      expect(result.hasChanges).toBe(true);
    });
  });

  /* ---------- generatorSummary ---------- */

  describe("generatorSummary", () => {
    it("builds password mode summary with length", () => {
      const result = buildTeamLoginFormDerived(buildArgsCreate());
      expect(result.generatorSummary).toBe("Password \u00b7 20");
    });

    it("builds passphrase mode summary with word count", () => {
      const settings: GeneratorSettings = {
        ...DEFAULT_GENERATOR_SETTINGS,
        mode: "passphrase",
        passphrase: {
          ...DEFAULT_GENERATOR_SETTINGS.passphrase,
          wordCount: 5,
        },
      };
      const result = buildTeamLoginFormDerived(
        buildArgsCreate({ generatorSettings: settings }),
      );
      expect(result.generatorSummary).toBe("Passphrase \u00b7 5");
    });

    it("uses tGen callback for labels", () => {
      const customTGen = (key: "modePassphrase" | "modePassword") =>
        key === "modePassword" ? "PW" : "PP";

      const result = buildTeamLoginFormDerived({
        ...buildArgsCreate(),
        tGen: customTGen,
      });
      expect(result.generatorSummary).toBe("PW \u00b7 20");
    });
  });
});
