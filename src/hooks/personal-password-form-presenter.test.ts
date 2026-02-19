// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  usePersonalPasswordFormState,
} from "@/hooks/use-personal-password-form-state";
import {
  buildPersonalPasswordFormPresenter,
} from "@/hooks/personal-password-form-presenter";

describe("buildPersonalPasswordFormPresenter", () => {
  it("exposes entry values, derived state and login field props", () => {
    const { result } = renderHook(() => {
      const formState = usePersonalPasswordFormState({
        id: "entry-1",
        title: "original",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      });
      return buildPersonalPasswordFormPresenter({
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
          t: (k) => k,
          tGen: (k) => k,
          tc: (k) => k,
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
