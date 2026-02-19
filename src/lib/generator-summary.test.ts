import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { buildGeneratorSummary } from "@/lib/generator-summary";

describe("buildGeneratorSummary", () => {
  it("builds password mode summary", () => {
    const summary = buildGeneratorSummary(
      { ...DEFAULT_GENERATOR_SETTINGS, mode: "password", length: 24 },
      { modePassword: "Password", modePassphrase: "Passphrase" },
    );
    expect(summary).toBe("Password · 24");
  });

  it("builds passphrase mode summary", () => {
    const summary = buildGeneratorSummary(
      {
        ...DEFAULT_GENERATOR_SETTINGS,
        mode: "passphrase",
        passphrase: { ...DEFAULT_GENERATOR_SETTINGS.passphrase, wordCount: 6 },
      },
      { modePassword: "Password", modePassphrase: "Passphrase" },
    );
    expect(summary).toBe("Passphrase · 6");
  });
});
