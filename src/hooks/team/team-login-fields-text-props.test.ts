import { describe, expect, it } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import { buildTeamLoginFieldTextProps } from "@/hooks/team/team-login-fields-text-props";
import type { TeamPolicyClient } from "@/hooks/team/use-team-policy";

const fakePolicy: TeamPolicyClient = {
  minPasswordLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
};

describe("buildTeamLoginFieldTextProps", () => {
  it("includes teamPolicy in the returned props", () => {
    const props = buildTeamLoginFieldTextProps(
      mockTranslator<PasswordFormTranslator>((key) => `label.${key}`),
      fakePolicy,
    );

    expect(props.teamPolicy).toBe(fakePolicy);
  });

  it("maps all labels and placeholders from PasswordForm translator", () => {
    const props = buildTeamLoginFieldTextProps(
      mockTranslator<PasswordFormTranslator>((key) => `label.${key}`),
      fakePolicy,
    );

    expect(props.titleLabel).toBe("label.title");
    expect(props.titlePlaceholder).toBe("label.titlePlaceholder");
    expect(props.usernameLabel).toBe("label.usernameEmail");
    expect(props.usernamePlaceholder).toBe("label.usernamePlaceholder");
    expect(props.passwordLabel).toBe("label.password");
    expect(props.passwordPlaceholder).toBe("label.passwordPlaceholder");
    expect(props.closeGeneratorLabel).toBe("label.closeGenerator");
    expect(props.openGeneratorLabel).toBe("label.openGenerator");
    expect(props.urlLabel).toBe("label.url");
    expect(props.notesLabel).toBe("label.notes");
    expect(props.notesPlaceholder).toBe("label.notesPlaceholder");
  });
});
