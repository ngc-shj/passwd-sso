interface EnvIntOpts {
  min?: number;
  max?: number;
}

/**
 * Parse env var as strict integer with range guard.
 * Uses Number() (not parseInt) to reject partial numbers like "20ms" or "10abc".
 * Falls back to defaultVal on invalid/missing values.
 */
export function envInt(
  name: string,
  defaultVal: number,
  opts: EnvIntOpts = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  const parsed = Number(raw);
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return defaultVal;
  }
  return parsed;
}
