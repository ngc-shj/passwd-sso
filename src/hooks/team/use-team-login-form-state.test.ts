// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTeamLoginFormState } from "@/hooks/team/use-team-login-form-state";
import { aadGatedDecrypt, aadModelDecrypt } from "@/__tests__/helpers/aad-model-decrypt";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";

const { mockFetchApi, mockDecryptData } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getEntryDecryptionKey: vi.fn(),
  }),
}));
import {
  applyPolicyToGeneratorSettings,
} from "@/hooks/team/team-login-form-initial-values";
import {
  DEFAULT_GENERATOR_SETTINGS,
  DEFAULT_SYMBOL_GROUPS,
} from "@/lib/generator/generator-prefs";
import type { TeamPolicyClient } from "@/hooks/team/use-team-policy";

const NO_POLICY: TeamPolicyClient = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

describe("useTeamLoginFormState", () => {
  it("initializes defaults without editData", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormState({ teamId: "team-1", teamPolicy: NO_POLICY }),
    );

    expect(result.current.username).toBe("");
    expect(result.current.password).toBe("");
    expect(result.current.url).toBe("");
    expect(result.current.showPassword).toBe(false);
    expect(result.current.showGenerator).toBe(false);
    expect(result.current.customFields).toEqual([]);
    expect(result.current.totp).toBeNull();
    expect(result.current.showTotpInput).toBe(false);
  });

  it("applies editData to initial state", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormState({
        teamId: "team-1",
        editData: {
          id: "entry-1",
          title: "GitHub",
          username: "user@example.com",
          password: "secret123",
          url: "https://github.com",
          notes: "memo",
          totp: { secret: "JBSWY3DPEHPK3PXP", digits: 6, period: 30 },
          customFields: [{ label: "API Key", value: "abc123", type: "text" as const }],
        },
        teamPolicy: NO_POLICY,
      }),
    );

    expect(result.current.username).toBe("user@example.com");
    expect(result.current.password).toBe("secret123");
    expect(result.current.url).toBe("https://github.com");
    expect(result.current.totp).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      digits: 6,
      period: 30,
    });
    expect(result.current.showTotpInput).toBe(true);
    expect(result.current.customFields).toEqual([
      { label: "API Key", value: "abc123", type: "text" },
    ]);
  });

  it("updates values via setters", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormState({ teamId: "team-1", teamPolicy: NO_POLICY }),
    );

    act(() => {
      result.current.setUsername("new-user");
      result.current.setPassword("new-pass");
      result.current.setUrl("https://new.example.com");
      result.current.setShowPassword(true);
      result.current.setShowGenerator(true);
    });

    expect(result.current.username).toBe("new-user");
    expect(result.current.password).toBe("new-pass");
    expect(result.current.url).toBe("https://new.example.com");
    expect(result.current.showPassword).toBe(true);
    expect(result.current.showGenerator).toBe(true);
  });

  it("builds generator settings from default when no policy constraints", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormState({ teamId: "team-1", teamPolicy: NO_POLICY }),
    );

    expect(result.current.generatorSettings.length).toBe(
      DEFAULT_GENERATOR_SETTINGS.length,
    );
    expect(result.current.generatorSettings.uppercase).toBe(
      DEFAULT_GENERATOR_SETTINGS.uppercase,
    );
    expect(result.current.generatorSettings.lowercase).toBe(
      DEFAULT_GENERATOR_SETTINGS.lowercase,
    );
    expect(result.current.generatorSettings.numbers).toBe(
      DEFAULT_GENERATOR_SETTINGS.numbers,
    );
  });

  it("applies team policy to generator settings", () => {
    const strictPolicy: TeamPolicyClient = {
      minPasswordLength: 30,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: true,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
      requireSharePassword: false,
      passwordHistoryCount: 0,
      inheritTenantCidrs: true,
      teamAllowedCidrs: [],
    };

    const { result } = renderHook(() =>
      useTeamLoginFormState({ teamId: "team-1", teamPolicy: strictPolicy }),
    );

    // Policy enforces minimum length
    expect(result.current.generatorSettings.length).toBeGreaterThanOrEqual(30);
    // Policy enforces character class requirements
    expect(result.current.generatorSettings.uppercase).toBe(true);
    expect(result.current.generatorSettings.lowercase).toBe(true);
    expect(result.current.generatorSettings.numbers).toBe(true);
    // Policy enforces symbols
    expect(result.current.generatorSettings.symbolGroups.hashEtc).toBe(true);
    expect(result.current.generatorSettings.symbolGroups.punctuation).toBe(true);
  });

  it("re-applies policy when setGeneratorSettings is called", () => {
    const policy: TeamPolicyClient = {
      minPasswordLength: 16,
      requireUppercase: true,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
      requireSharePassword: false,
      passwordHistoryCount: 0,
      inheritTenantCidrs: true,
      teamAllowedCidrs: [],
    };

    const { result } = renderHook(() =>
      useTeamLoginFormState({ teamId: "team-1", teamPolicy: policy }),
    );

    // Try to set a short length and disable uppercase (policy should override)
    act(() => {
      result.current.setGeneratorSettings({
        ...DEFAULT_GENERATOR_SETTINGS,
        length: 8,
        uppercase: false,
      });
    });

    // Policy enforces minPasswordLength >= 16
    expect(result.current.generatorSettings.length).toBe(16);
    // Policy enforces uppercase
    expect(result.current.generatorSettings.uppercase).toBe(true);
  });
});

// D67: history passwords for the reuse check are read at AAD 1 whatever
// aadVersion the server reports for the row.
describe("useTeamLoginFormState password-reuse history (strict team entry AAD)", () => {
  it.each([
    ["refuses a no-AAD history blob the server labels aadVersion 0", 0, "noaad-blob", false],
    ["control: reads an aadVersion-1 history blob sealed with the entry AAD", 1, "blob", true],
  ])("%s", async (_label, aadVersion, ciphertext, flagsReuse) => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "h1",
        encryptedBlob: { ciphertext, iv: "iv", authTag: "tag" },
        aadVersion,
        teamKeyVersion: 1,
        itemKeyVersion: 1,
        itemKeyId: "ik-1",
      }],
    });
    mockDecryptData.mockReset();
    mockDecryptData.mockImplementation(aadModelDecrypt(JSON.stringify({ password: "reused-pw" })));
    const setPolicyViolations = vi.fn();

    const { result } = renderHook(() =>
      useTeamLoginFormState({
        teamId: "team-1",
        editData: {
          id: "entry-1", title: "T", username: null, password: "current", url: null, notes: null,
          itemKeyVersion: 1, itemKeyId: "ik-1", teamKeyVersion: 1,
        },
        teamPolicy: { ...NO_POLICY, passwordHistoryCount: 5 },
        setPolicyViolations,
      }),
    );
    await waitFor(() => expect(mockDecryptData).toHaveBeenCalled());
    // The settled decrypt (or refusal) is read by the reuse check on the next change.
    await act(async () => {});
    act(() => result.current.setPassword("reused-pw"));

    const last = setPolicyViolations.mock.calls.at(-1)?.[0] as { key: string }[];
    expect(last.some((v) => v.key === "policyPasswordReuse")).toBe(flagsReuse);
    expect(mockDecryptData.mock.calls[0][2]).toEqual(buildTeamEntryAAD("team-1", "entry-1", "blob", 1));
  });

  // T8: each history row opens at the blob vaultType and its OWN ItemKey version.
  it.each([
    ["control: reads a history blob sealed at blob / the row's ItemKey version", "blob", 3, true],
    ["skips a history blob sealed at the overview vaultType", "overview", 3, false],
    ["skips a history blob sealed at another ItemKey version", "blob", 2, false],
  ] as const)("%s (T8)", async (_label, vaultType, sealedVersion, flagsReuse) => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "h1",
        encryptedBlob: { ciphertext: "blob", iv: "iv", authTag: "tag" },
        aadVersion: 1,
        teamKeyVersion: 1,
        itemKeyVersion: 3,
        itemKeyId: "ik-1",
      }],
    });
    mockDecryptData.mockReset();
    mockDecryptData.mockImplementation(
      aadGatedDecrypt(buildTeamEntryAAD("team-1", "entry-1", vaultType, sealedVersion), JSON.stringify({ password: "reused-pw" })),
    );
    const setPolicyViolations = vi.fn();

    const { result } = renderHook(() =>
      useTeamLoginFormState({
        teamId: "team-1",
        editData: {
          id: "entry-1", title: "T", username: null, password: "current", url: null, notes: null,
          itemKeyVersion: 1, itemKeyId: "ik-1", teamKeyVersion: 1,
        },
        teamPolicy: { ...NO_POLICY, passwordHistoryCount: 5 },
        setPolicyViolations,
      }),
    );
    await waitFor(() => expect(mockDecryptData).toHaveBeenCalled());
    await act(async () => {});
    act(() => result.current.setPassword("reused-pw"));

    const last = setPolicyViolations.mock.calls.at(-1)?.[0] as { key: string }[];
    expect(last.some((v) => v.key === "policyPasswordReuse")).toBe(flagsReuse);
  });
});

describe("applyPolicyToGeneratorSettings", () => {
  it("returns settings unchanged when policy is null", () => {
    const settings = { ...DEFAULT_GENERATOR_SETTINGS };
    const result = applyPolicyToGeneratorSettings(settings, null);

    expect(result).toEqual(settings);
  });

  it("enforces minPasswordLength", () => {
    const result = applyPolicyToGeneratorSettings(
      { ...DEFAULT_GENERATOR_SETTINGS, length: 8 },
      { ...NO_POLICY, minPasswordLength: 20 },
    );

    expect(result.length).toBe(20);
  });

  it("does not reduce length below current setting", () => {
    const result = applyPolicyToGeneratorSettings(
      { ...DEFAULT_GENERATOR_SETTINGS, length: 32 },
      { ...NO_POLICY, minPasswordLength: 16 },
    );

    expect(result.length).toBe(32);
  });

  it("forces uppercase, numbers when required by policy", () => {
    const result = applyPolicyToGeneratorSettings(
      {
        ...DEFAULT_GENERATOR_SETTINGS,
        uppercase: false,
        numbers: false,
      },
      {
        ...NO_POLICY,
        requireUppercase: true,
        requireNumbers: true,
      },
    );

    expect(result.uppercase).toBe(true);
    expect(result.numbers).toBe(true);
  });

  it("forces symbol groups when requireSymbols is true", () => {
    const result = applyPolicyToGeneratorSettings(
      {
        ...DEFAULT_GENERATOR_SETTINGS,
        symbolGroups: { ...DEFAULT_SYMBOL_GROUPS },
      },
      { ...NO_POLICY, requireSymbols: true },
    );

    expect(result.symbolGroups.hashEtc).toBe(true);
    expect(result.symbolGroups.punctuation).toBe(true);
    // Other groups not forced by policy
    expect(result.symbolGroups.quotes).toBe(false);
    expect(result.symbolGroups.slashDash).toBe(false);
  });

  it("preserves user-enabled symbol groups when policy also requires symbols", () => {
    const result = applyPolicyToGeneratorSettings(
      {
        ...DEFAULT_GENERATOR_SETTINGS,
        symbolGroups: {
          ...DEFAULT_SYMBOL_GROUPS,
          brackets: true,
          mathCompare: true,
        },
      },
      { ...NO_POLICY, requireSymbols: true },
    );

    // User's selections preserved
    expect(result.symbolGroups.brackets).toBe(true);
    expect(result.symbolGroups.mathCompare).toBe(true);
    // Policy-required groups added
    expect(result.symbolGroups.hashEtc).toBe(true);
    expect(result.symbolGroups.punctuation).toBe(true);
  });
});
