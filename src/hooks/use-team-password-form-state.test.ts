// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  selectOrgEntryFieldValues,
  useOrgPasswordFormState,
} from "@/hooks/use-team-password-form-state";
import { ENTRY_TYPE } from "@/lib/constants";

describe("useOrgPasswordFormState", () => {
  it("initializes with defaults when edit data is missing", () => {
    const { result } = renderHook(() => useOrgPasswordFormState());

    expect(result.current.values.title).toBe("");
    expect(result.current.values.password).toBe("");
    expect(result.current.values.showTotpInput).toBe(false);
    expect(result.current.values.brandSource).toBe("auto");
    expect(result.current.values.orgFolderId).toBeNull();
  });

  it("initializes from edit data and sets derived flags", () => {
    const { result } = renderHook(() =>
      useOrgPasswordFormState({
        id: "e1",
        entryType: ENTRY_TYPE.LOGIN,
        title: "GitHub",
        username: "user@example.com",
        password: "secret",
        url: "https://github.com",
        notes: "note",
        brand: "visa",
        cardNumber: "4242424242424242",
        totp: {
          secret: "JBSWY3DPEHPK3PXP",
          digits: 6,
          period: 30,
          algorithm: "SHA1",
        },
        orgFolderId: "f1",
      }),
    );

    expect(result.current.values.title).toBe("GitHub");
    expect(result.current.values.username).toBe("user@example.com");
    expect(result.current.values.url).toBe("https://github.com");
    expect(result.current.values.notes).toBe("note");
    expect(result.current.values.showTotpInput).toBe(true);
    expect(result.current.values.brandSource).toBe("manual");
    expect(result.current.values.orgFolderId).toBe("f1");
  });

  it("selects entry field values for submit/derived consumers", () => {
    const { result } = renderHook(() =>
      useOrgPasswordFormState({
        id: "e1",
        entryType: ENTRY_TYPE.IDENTITY,
        title: "Identity",
        username: "identity-user",
        password: "identity-pass",
        notes: "id note",
        orgFolderId: "folder-1",
      }),
    );

    const selected = selectOrgEntryFieldValues(result.current.values);

    expect(selected).toEqual(
      expect.objectContaining({
        title: "Identity",
        username: "identity-user",
        password: "identity-pass",
        notes: "id note",
        orgFolderId: "folder-1",
      }),
    );
  });
});
