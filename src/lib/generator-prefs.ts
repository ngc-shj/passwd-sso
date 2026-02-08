// ─── Symbol Group Definitions ──────────────────────────────────

export const SYMBOL_GROUPS = {
  hashEtc: "#$%&@^`~",
  punctuation: ".,:;",
  quotes: "\"'",
  slashDash: "\\/|_-",
  mathCompare: "<>*+!?=",
  brackets: "{}[]()",
} as const;

export type SymbolGroupKey = keyof typeof SYMBOL_GROUPS;

export const SYMBOL_GROUP_KEYS = Object.keys(
  SYMBOL_GROUPS
) as SymbolGroupKey[];

// ─── Types ─────────────────────────────────────────────────────

export interface SymbolGroupFlags {
  hashEtc: boolean;
  punctuation: boolean;
  quotes: boolean;
  slashDash: boolean;
  mathCompare: boolean;
  brackets: boolean;
}

export type GeneratorMode = "password" | "passphrase";

export interface PassphraseSettings {
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export interface GeneratorSettings {
  mode: GeneratorMode;
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbolGroups: SymbolGroupFlags;
  excludeAmbiguous: boolean;
  passphrase: PassphraseSettings;
}

// Characters that are easily confused: 0/O/o, I/l/1, |
export const AMBIGUOUS_CHARS = "0OoIl1|";

// ─── Defaults ──────────────────────────────────────────────────

export const DEFAULT_SYMBOL_GROUPS: SymbolGroupFlags = {
  hashEtc: false,
  punctuation: false,
  quotes: false,
  slashDash: false,
  mathCompare: false,
  brackets: false,
};

export const DEFAULT_PASSPHRASE_SETTINGS: PassphraseSettings = {
  wordCount: 4,
  separator: "-",
  capitalize: true,
  includeNumber: false,
};

export const DEFAULT_GENERATOR_SETTINGS: GeneratorSettings = {
  mode: "password",
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbolGroups: { ...DEFAULT_SYMBOL_GROUPS },
  excludeAmbiguous: false,
  passphrase: { ...DEFAULT_PASSPHRASE_SETTINGS },
};

// ─── Helper ────────────────────────────────────────────────────

export function buildSymbolString(groups: SymbolGroupFlags): string {
  return SYMBOL_GROUP_KEYS.filter((key) => groups[key])
    .map((key) => SYMBOL_GROUPS[key])
    .join("");
}
