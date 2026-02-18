import type { GeneratorSettings } from "@/lib/generator-prefs";

interface GeneratorSummaryLabels {
  modePassword: string;
  modePassphrase: string;
}

export function buildGeneratorSummary(
  settings: GeneratorSettings,
  labels: GeneratorSummaryLabels,
): string {
  return settings.mode === "passphrase"
    ? `${labels.modePassphrase} · ${settings.passphrase.wordCount}`
    : `${labels.modePassword} · ${settings.length}`;
}
