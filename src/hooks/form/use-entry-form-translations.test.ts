// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const useTranslationsMock = vi.fn(
  (namespace: string) => (key: string) => `${namespace}:${key}`,
);

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => useTranslationsMock(namespace),
}));

import { useEntryFormTranslations } from "@/hooks/form/use-entry-form-translations";

describe("useEntryFormTranslations", () => {
  it("creates a translator for each PasswordForm-related namespace", () => {
    useTranslationsMock.mockClear();

    renderHook(() => useEntryFormTranslations());

    const namespaces = useTranslationsMock.mock.calls.map(([ns]) => ns);
    expect(namespaces).toEqual([
      "PasswordForm",
      "PasswordGenerator",
      "Common",
      "SecureNoteForm",
      "CreditCardForm",
      "IdentityForm",
      "PasskeyForm",
      "BankAccountForm",
      "SoftwareLicenseForm",
      "SshKeyForm",
      "TravelMode",
    ]);
  });

  it("returns translator handles routed to the correct namespace", () => {
    const { result } = renderHook(() => useEntryFormTranslations());

    expect(result.current.t("title")).toBe("PasswordForm:title");
    expect(result.current.tGen("strength")).toBe("PasswordGenerator:strength");
    expect(result.current.tc("save")).toBe("Common:save");
    expect(result.current.tn("body")).toBe("SecureNoteForm:body");
    expect(result.current.tcc("number")).toBe("CreditCardForm:number");
    expect(result.current.ti("name")).toBe("IdentityForm:name");
    expect(result.current.tpk("publicKey")).toBe("PasskeyForm:publicKey");
    expect(result.current.tba("iban")).toBe("BankAccountForm:iban");
    expect(result.current.tsl("licenseKey")).toBe("SoftwareLicenseForm:licenseKey");
    expect(result.current.tsk("privateKey")).toBe("SshKeyForm:privateKey");
    expect(result.current.ttm("status")).toBe("TravelMode:status");
  });

  it("exposes exactly the EntryFormTranslationsBundle keys", () => {
    const { result } = renderHook(() => useEntryFormTranslations());

    expect(Object.keys(result.current).sort()).toEqual(
      [
        "t",
        "tGen",
        "tc",
        "tn",
        "tcc",
        "ti",
        "tpk",
        "tba",
        "tsl",
        "tsk",
        "ttm",
      ].sort(),
    );
  });
});
