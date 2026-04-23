import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";
import {
  buildTeamLoginFieldsProps,
} from "@/hooks/team-login-fields-props";
import type { TeamLoginFieldTextProps } from "@/hooks/team-login-fields-types";
import type { TeamPolicyClient } from "@/hooks/use-team-policy";

const fakePolicy: TeamPolicyClient = {
  minPasswordLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

function createTextProps(): TeamLoginFieldTextProps {
  return {
    titleLabel: "label.title",
    titlePlaceholder: "placeholder.title",
    usernameLabel: "label.username",
    usernamePlaceholder: "placeholder.username",
    passwordLabel: "label.password",
    passwordPlaceholder: "placeholder.password",
    closeGeneratorLabel: "label.closeGenerator",
    openGeneratorLabel: "label.openGenerator",
    urlLabel: "label.url",
    notesLabel: "label.notes",
    notesPlaceholder: "placeholder.notes",
    teamPolicy: fakePolicy,
  };
}

function createArgs() {
  return {
    values: {
      title: "title",
      username: "username",
      password: "password",
      showPassword: false,
      showGenerator: false,
      generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
      url: "https://example.com",
      notes: "notes",
    },
    setters: {
      setTitle: vi.fn(),
      setUsername: vi.fn(),
      setPassword: vi.fn(),
      setShowPassword: vi.fn(),
      setShowGenerator: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setUrl: vi.fn(),
      setNotes: vi.fn(),
    },
    generatorSummary: "summary",
    textProps: createTextProps(),
  };
}

describe("buildTeamLoginFieldsProps", () => {
  it("builds complete login field props from state", () => {
    const args = createArgs();
    const props = buildTeamLoginFieldsProps(args);

    expect(props.title).toBe("title");
    expect(props.username).toBe("username");
    expect(props.password).toBe("password");
    expect(props.url).toBe("https://example.com");
    expect(props.notes).toBe("notes");
    expect(props.generatorSummary).toBe("summary");
    expect(props.titleLabel).toBe("label.title");
    expect(props.notesPlaceholder).toBe("placeholder.notes");
    expect(props.idPrefix).toBe("team-");
    expect(props.hideTitle).toBe(true);
  });

  it("toggles showPassword and showGenerator", () => {
    const args = createArgs();
    args.values.showPassword = true;
    args.values.showGenerator = true;

    const props = buildTeamLoginFieldsProps(args);

    props.onToggleShowPassword();
    props.onToggleGenerator();
    expect(args.setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(args.setters.setShowGenerator).toHaveBeenCalledWith(false);
  });

  it("applies generated password via onGeneratorUse", () => {
    const args = createArgs();
    const props = buildTeamLoginFieldsProps(args);

    const nextSettings = { length: 42 } as GeneratorSettings;
    props.onGeneratorUse("generated", nextSettings);
    expect(args.setters.setPassword).toHaveBeenCalledWith("generated");
    expect(args.setters.setGeneratorSettings).toHaveBeenCalledWith(nextSettings);
  });

  it("delegates url callback to setUrl", () => {
    const args = createArgs();
    const props = buildTeamLoginFieldsProps(args);

    props.onUrlChange("https://new.example.com");
    expect(args.setters.setUrl).toHaveBeenCalledWith("https://new.example.com");
  });

  it("delegates username callback to setUsername", () => {
    const args = createArgs();
    const props = buildTeamLoginFieldsProps(args);

    props.onUsernameChange("newuser");
    expect(args.setters.setUsername).toHaveBeenCalledWith("newuser");
  });

  it("delegates password callback to setPassword", () => {
    const args = createArgs();
    const props = buildTeamLoginFieldsProps(args);

    props.onPasswordChange("newpass");
    expect(args.setters.setPassword).toHaveBeenCalledWith("newpass");
  });
});
