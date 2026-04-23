import { buildGeneratorSummary } from "@/lib/generator/generator-summary";
import type { GeneratorSettings } from "@/lib/generator/generator-prefs";

export interface LoginFormDerivedArgs {
  scope: "personal" | "team";
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  tags: Array<{ id?: string; name: string; color: string | null }>;
  customFields: unknown[];
  totp: unknown | null;
  folderId: string | null;
  requireReprompt: boolean;
  travelSafe: boolean;
  expiresAt: string | null;
  generatorSettings: GeneratorSettings;
  // Translations
  tGen: (key: "modePassphrase" | "modePassword") => string;
  // Baseline for comparison
  initialSnapshot: string;
}

type SnapshotValues = Omit<LoginFormDerivedArgs, "scope" | "tGen" | "initialSnapshot">;

/**
 * Builds a stable JSON snapshot of the current form values.
 * Scope differences:
 *   - personal: tags compared by full object (deep equality), customFields/totp
 *     included directly, generatorSettings included
 *   - team: tags compared by sorted IDs only, customFields/totp double-stringified
 *     for stability, generatorSettings excluded
 */
export function buildSnapshot(scope: "personal" | "team", values: SnapshotValues): string {
  const {
    title,
    username,
    password,
    url,
    notes,
    tags,
    customFields,
    totp,
    folderId,
    requireReprompt,
    travelSafe,
    expiresAt,
    generatorSettings,
  } = values;

  if (scope === "personal") {
    return JSON.stringify({
      title,
      username,
      password,
      url,
      notes,
      tags,
      generatorSettings,
      customFields,
      totp,
      requireReprompt,
      travelSafe,
      expiresAt,
      folderId,
    });
  }

  // team scope
  return JSON.stringify({
    title,
    notes,
    username,
    password,
    url,
    customFields: JSON.stringify(customFields),
    totp: JSON.stringify(totp),
    selectedTagIds: tags.map((tag) => tag.id).sort(),
    teamFolderId: folderId,
    requireReprompt,
    travelSafe,
    expiresAt,
  });
}

export function buildLoginFormDerived(args: LoginFormDerivedArgs): {
  hasChanges: boolean;
  generatorSummary: string;
} {
  const { scope, tGen, initialSnapshot, ...values } = args;

  const currentSnapshot = buildSnapshot(scope, values);
  const hasChanges = currentSnapshot !== initialSnapshot;

  const generatorSummary = buildGeneratorSummary(values.generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  return { hasChanges, generatorSummary };
}
