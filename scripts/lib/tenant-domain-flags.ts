/**
 * Argument parsing for `scripts/tenant-domain.ts`, in its own module so it can
 * be unit-tested without importing the CLI (which pulls in Prisma, the driver
 * adapter and `loadEnv()`).
 *
 * Round-3 M7: these were file-private in the CLI, so the only thing exercising
 * them was the CLI's own `main()` — which the integration suite deliberately
 * does not call, because `main()` sets `process.exitCode` and would kill the
 * vitest worker. The guard that refuses a flag written without its value was
 * therefore unproven, and round-3 S3-5 found it was also incomplete.
 *
 * The stance, one rule: **a flag the operator wrote must either take effect or
 * stop the command.** Never a silent fallback to a default. This tool is used
 * at incident time, where "I widened the window and it found nothing" and "I
 * did not widen the window" are the same output but opposite conclusions.
 */

/**
 * Every flag that takes a VALUE, with the hint printed when it arrives without
 * one. The member set is derived from this table by `findValuelessFlag` and
 * `parseFlags`, so a new value-taking flag joins both checks by being added
 * here rather than by someone remembering to write another bespoke guard
 * (round-2 F-E).
 */
export const VALUE_FLAG_HINTS = {
  tenant: "a tenant UUID, one of its registered claims, or its external id",
  domain: "the domain to register or remove",
  by: "a self-asserted operator label",
  from: "the current owner's tenant UUID, exactly as `list` prints it",
  days: "a positive integer number of days",
} as const satisfies Record<string, string>;

export type ValueFlag = keyof typeof VALUE_FLAG_HINTS;

/** Flags that take no value. `--yes` is the only one. */
export const BOOLEAN_FLAGS = ["yes"] as const;

export type ParsedFlags = Map<string, string | true>;

export type FlagParseResult =
  | { ok: true; flags: ParsedFlags }
  | { ok: false; error: string };

const REFUSAL_RATIONALE =
  "Refusing rather than falling back to the default: a flag written without its " +
  "value is an instruction the operator believes was applied.";

function isValueFlag(name: string): name is ValueFlag {
  return Object.prototype.hasOwnProperty.call(VALUE_FLAG_HINTS, name);
}

function isBooleanFlag(name: string): boolean {
  return (BOOLEAN_FLAGS as readonly string[]).includes(name);
}

/**
 * Parse `--name value`, `--name=value` and `--name` forms, refusing anything
 * this CLI does not define.
 *
 * The `--name=value` form is round-3 S3-5: the previous parser only understood
 * the space-separated form, so `--days=30` was stored under the key
 * `"days=30"`. `getStringFlag("days")` then returned undefined — the same
 * answer as "not given" — and `unmapped` silently queried the DEFAULT window
 * while the operator believed they had widened it to 30 days. The valueless
 * guard could not catch it either, because the key it checks was never
 * written. Supporting the form is half the fix; refusing unknown flags is the
 * other half, and it is what makes the class closed rather than this one
 * spelling fixed: `--dayss 30`, `--Days 30` and any future typo now stop the
 * command instead of being dropped.
 */
export function parseFlags(argv: string[]): FlagParseResult {
  const flags: ParsedFlags = new Map();

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      return {
        ok: false,
        error:
          `Unexpected argument "${tok}". Every input to this command is a flag; ` +
          "a bare word is either a typo or a value whose flag was dropped.",
      };
    }

    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (isBooleanFlag(name)) {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--${name} takes no value (got "${inlineValue}").` };
      }
      flags.set(name, true);
      continue;
    }

    if (!isValueFlag(name)) {
      return { ok: false, error: `Unknown flag --${name}. ${usageHint()}` };
    }

    if (inlineValue !== undefined) {
      if (inlineValue === "") {
        return { ok: false, error: valuelessError(name) };
      }
      flags.set(name, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // Stored as `true` so `findValuelessFlag` reports it by name. Returning
      // the error straight from here would be equivalent today; the two-step
      // shape is kept so a caller that wants to inspect the whole command line
      // before failing still can.
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    i += 1;
  }

  return { ok: true, flags };
}

function usageHint(): string {
  const known = [...Object.keys(VALUE_FLAG_HINTS), ...BOOLEAN_FLAGS]
    .map((n) => `--${n}`)
    .join(", ");
  return `Known flags: ${known}.`;
}

export function valuelessError(name: ValueFlag): string {
  return `--${name} requires a value (${VALUE_FLAG_HINTS[name]}). ${REFUSAL_RATIONALE}`;
}

export function getStringFlag(flags: ParsedFlags, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** The first value-taking flag that was given without a value, if any. */
export function findValuelessFlag(flags: ParsedFlags): ValueFlag | null {
  for (const name of Object.keys(VALUE_FLAG_HINTS) as ValueFlag[]) {
    if (flags.get(name) === true) return name;
  }
  return null;
}
