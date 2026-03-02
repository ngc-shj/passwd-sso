import { describe, expect, it } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator } from "@/lib/translation-types";
import { buildPersonalLoginFieldTextProps } from "@/hooks/personal-login-fields-text-props";

describe("buildPersonalLoginFieldTextProps", () => {
  it("maps all personal login labels from PasswordForm translator", () => {
    const props = buildPersonalLoginFieldTextProps(mockTranslator<PasswordFormTranslator>((key) => `label.${key}`));

    expect(props.titleLabel).toBe("label.title");
    expect(props.titlePlaceholder).toBe("label.titlePlaceholder");
    expect(props.usernameLabel).toBe("label.usernameEmail");
    expect(props.passwordLabel).toBe("label.password");
    expect(props.closeGeneratorLabel).toBe("label.closeGenerator");
    expect(props.urlLabel).toBe("label.url");
    expect(props.notesPlaceholder).toBe("label.notesPlaceholder");
  });
});
