// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator, PasswordGeneratorTranslator, CommonTranslator } from "@/lib/translation-types";
import {
  usePersonalLoginFormState,
} from "@/hooks/personal/use-personal-login-form-state";
import {
  buildPersonalLoginFormPresenter,
} from "@/hooks/personal/personal-login-form-presenter";

describe("buildPersonalLoginFormPresenter", () => {
  it("exposes entry values, derived state and login field props", () => {
    const { result } = renderHook(() => {
      const formState = usePersonalLoginFormState({
        id: "entry-1",
        title: "original",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      });
      return buildPersonalLoginFormPresenter({
        initialData: {
          id: "entry-1",
          title: "original",
          username: "user",
          password: "pass",
          url: "",
          notes: "",
          tags: [],
        },
        formState,
        translations: {
          t: mockTranslator<PasswordFormTranslator>(),
          tGen: mockTranslator<PasswordGeneratorTranslator>(),
          tc: mockTranslator<CommonTranslator>(),
        },
      });
    });

    expect(result.current.values.title).toBe("original");
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.loginMainFieldsProps.title).toBe("original");

    act(() => {
      result.current.loginMainFieldsProps.onTitleChange("updated");
    });

    expect(result.current.values.title).toBe("updated");
    expect(result.current.hasChanges).toBe(true);
  });
});
