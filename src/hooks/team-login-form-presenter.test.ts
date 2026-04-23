import { describe, expect, it, vi } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import type { TeamPolicyClient } from "@/hooks/use-team-policy";
import { buildTeamLoginFormPresenter } from "@/hooks/team-login-form-presenter";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TEAM_POLICY: TeamPolicyClient = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
};

function buildPresenterArgs(overrides: {
  editData?: TeamEntryFormEditData | null;
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  selectedTags?: TeamTagData[];
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  expiresAt?: string | null;
  teamPolicy?: TeamPolicyClient;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
} = {}) {
  return {
    editData: overrides.editData ?? undefined,
    defaultFolderId: overrides.defaultFolderId ?? undefined,
    defaultTags: overrides.defaultTags ?? undefined,
    title: overrides.title ?? "",
    setTitle: vi.fn(),
    notes: overrides.notes ?? "",
    setNotes: vi.fn(),
    username: overrides.username ?? "",
    setUsername: vi.fn(),
    password: overrides.password ?? "",
    setPassword: vi.fn(),
    url: overrides.url ?? "",
    setUrl: vi.fn(),
    customFields: [],
    totp: null,
    selectedTags: overrides.selectedTags ?? [],
    teamFolderId: overrides.teamFolderId ?? null,
    requireReprompt: overrides.requireReprompt ?? false,
    travelSafe: true,
    expiresAt: overrides.expiresAt ?? null,
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
    setGeneratorSettings: vi.fn(),
    showPassword: false,
    setShowPassword: vi.fn(),
    showGenerator: false,
    setShowGenerator: vi.fn(),
    titleLabel: "Title",
    titlePlaceholder: "Enter title",
    notesLabel: "Notes",
    notesPlaceholder: "Enter notes",
    teamPolicy: overrides.teamPolicy ?? DEFAULT_TEAM_POLICY,
    t: mockTranslator<PasswordFormTranslator>(),
    tGen: (key: "modePassphrase" | "modePassword") =>
      key === "modePassword" ? "Password" : "Passphrase",
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildTeamLoginFormPresenter", () => {
  it("returns hasChanges, generatorSummary, and loginMainFieldsProps", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());

    expect(result).toHaveProperty("hasChanges");
    expect(result).toHaveProperty("generatorSummary");
    expect(result).toHaveProperty("loginMainFieldsProps");
  });

  it("hasChanges=false when values match defaults (create mode)", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());
    expect(result.hasChanges).toBe(false);
  });

  it("hasChanges=false when values match editData (edit mode)", () => {
    const editData: TeamEntryFormEditData = {
      id: "entry-1",
      title: "Existing",
      username: "admin",
      password: "secret",
      url: "https://app.example.com",
      notes: "note",
      tags: [{ id: "t1", name: "dev", color: null }],
      customFields: [],
      totp: null,
      teamFolderId: "f-1",
      requireReprompt: false,
      expiresAt: null,
    };

    const result = buildTeamLoginFormPresenter(
      buildPresenterArgs({
        editData,
        title: "Existing",
        username: "admin",
        password: "secret",
        url: "https://app.example.com",
        notes: "note",
        selectedTags: [{ id: "t1", name: "dev", color: null }],
        teamFolderId: "f-1",
      }),
    );
    expect(result.hasChanges).toBe(false);
  });

  it("hasChanges=true when a value differs from editData", () => {
    const editData: TeamEntryFormEditData = {
      id: "entry-1",
      title: "Original",
      username: "user",
      password: "pass",
      url: "",
      notes: "",
      tags: [],
      customFields: [],
      totp: null,
      teamFolderId: null,
      requireReprompt: false,
      expiresAt: null,
    };

    const result = buildTeamLoginFormPresenter(
      buildPresenterArgs({
        editData,
        title: "Modified",
        username: "user",
        password: "pass",
      }),
    );
    expect(result.hasChanges).toBe(true);
  });

  it("generatorSummary reflects default password mode", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());
    expect(result.generatorSummary).toBe("Password \u00b7 20");
  });

  it("loginMainFieldsProps contains field values", () => {
    const result = buildTeamLoginFormPresenter(
      buildPresenterArgs({
        title: "My Entry",
        username: "alice",
        password: "hunter2",
        url: "https://example.com",
        notes: "some notes",
      }),
    );

    const props = result.loginMainFieldsProps;
    expect(props.title).toBe("My Entry");
    expect(props.username).toBe("alice");
    expect(props.password).toBe("hunter2");
    expect(props.url).toBe("https://example.com");
    expect(props.notes).toBe("some notes");
  });

  it("loginMainFieldsProps includes callback functions", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());
    const props = result.loginMainFieldsProps;

    expect(typeof props.onTitleChange).toBe("function");
    expect(typeof props.onUsernameChange).toBe("function");
    expect(typeof props.onPasswordChange).toBe("function");
    expect(typeof props.onToggleShowPassword).toBe("function");
    expect(typeof props.onToggleGenerator).toBe("function");
    expect(typeof props.onGeneratorUse).toBe("function");
    expect(typeof props.onUrlChange).toBe("function");
    expect(typeof props.onNotesChange).toBe("function");
  });

  it("loginMainFieldsProps includes text labels from t and overrides", () => {
    const result = buildTeamLoginFormPresenter(
      buildPresenterArgs(),
    );
    const props = result.loginMainFieldsProps;

    // Custom labels passed directly
    expect(props.titleLabel).toBe("Title");
    expect(props.titlePlaceholder).toBe("Enter title");
    expect(props.notesLabel).toBe("Notes");
    expect(props.notesPlaceholder).toBe("Enter notes");

    // Labels from mockTranslator (returns key as-is)
    expect(props.usernameLabel).toBe("usernameEmail");
    expect(props.passwordLabel).toBe("password");
    expect(props.urlLabel).toBe("url");
  });

  it("loginMainFieldsProps carries teamPolicy through textProps", () => {
    const customPolicy: TeamPolicyClient = {
      ...DEFAULT_TEAM_POLICY,
      minPasswordLength: 12,
      requireUppercase: true,
    };

    const result = buildTeamLoginFormPresenter(
      buildPresenterArgs({ teamPolicy: customPolicy }),
    );

    // teamPolicy is embedded in loginMainFieldsProps via textProps spread
    const props = result.loginMainFieldsProps as unknown as Record<string, unknown>;
    expect(props.teamPolicy).toEqual(customPolicy);
  });

  it("loginMainFieldsProps sets idPrefix to 'team-' and hideTitle to true", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());
    const props = result.loginMainFieldsProps;

    expect(props.idPrefix).toBe("team-");
    expect(props.hideTitle).toBe(true);
  });

  it("loginMainFieldsProps includes generatorSummary and generator state", () => {
    const result = buildTeamLoginFormPresenter(buildPresenterArgs());
    const props = result.loginMainFieldsProps;

    expect(props.generatorSummary).toBe("Password \u00b7 20");
    expect(props.showGenerator).toBe(false);
    expect(props.showPassword).toBe(false);
  });
});
