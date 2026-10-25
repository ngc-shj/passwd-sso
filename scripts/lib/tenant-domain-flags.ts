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
 *
 * Every message below renders `process.argv` content, so every interpolation of
 * it goes through `escapeUnsafeDisplayChars` — round-6 F4. Round 5's "all five
 * operator echoes escaped" enumerated the CLI file and never looked at this
 * one, which is where argv is first turned into text: four of the six missed
 * sites are here, including one whose surrounding string round 5 edited. These
 * are the LEAST validated echoes in the tool — a rejected flag is printed
 * before any schema has seen it — so they are exactly the wrong ones to miss.
 */

import { escapeUnsafeDisplayChars } from "@/lib/security/unsafe-display-chars";

/**
 * Every flag that takes a VALUE, with the hint printed when it arrives without
 * one. The member set is derived from this table by `findValuelessFlag` and
 * `parseFlags`, so a new value-taking flag joins both checks by being added
 * here rather than by someone remembering to write another bespoke guard
 * (round-2 F-E).
 */
export const VALUE_FLAG_HINTS = {
  tenant: "a tenant UUID or one of its registered claims",
  domain: "the domain to register or remove",
  by: "a self-asserted operator label",
  from: "the current owner's tenant UUID, exactly as `list` prints it",
  days: "a positive integer number of days",
  after: "the seq cursor printed by a capped `history` result, to continue from",
  user: "the user's UUID, or their email (matched case-insensitively)",
  limit: "the maximum number of backfill candidates to list or apply",
  provider: "the full SSO provider id the claim is bound to, e.g. saml-jackson-acme or google",
  claim: "the registered claim whose provider binding changes",
  out: "the path of the bind file to create, outside the git worktree",
} as const satisfies Record<string, string>;

/**
 * Flags that take a value for ONE subcommand and none elsewhere. `--apply` is
 * `backfill-owning-column`'s dry-run switch and `bind`'s reviewed file (plan
 * sso-claim-connection-binding, C3); the subcommand decides which, so a file
 * name after `bind --apply` is never read as a stray positional and a value
 * after `backfill-owning-column --apply` is still refused.
 */
export const SUBCOMMAND_VALUE_FLAG_HINTS = {
  bind: {
    apply: "the reviewed bind file `bind --from-members --out` wrote",
  },
} as const satisfies Record<string, Record<string, string>>;

export type ValueFlag = keyof typeof VALUE_FLAG_HINTS;

type ScopedValueFlag = {
  [S in keyof typeof SUBCOMMAND_VALUE_FLAG_HINTS]: keyof (typeof SUBCOMMAND_VALUE_FLAG_HINTS)[S];
}[keyof typeof SUBCOMMAND_VALUE_FLAG_HINTS];

/** Any flag that takes a value under some subcommand. */
export type AnyValueFlag = ValueFlag | ScopedValueFlag;

/**
 * Flags that take no value. `--yes` and `--apply` (C4); `--unbound`,
 * `--accept-unused-provider` and `--from-members` are the binding writers'
 * (plan sso-claim-connection-binding, C3).
 */
export const BOOLEAN_FLAGS = ["yes", "apply", "unbound", "accept-unused-provider", "from-members"] as const;

export type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

/**
 * The flags each subcommand reads — every other one stops the command, the
 * module's rule applied per subcommand. Without it a flag valid for SOME
 * subcommand passed `parseFlags` everywhere and was dropped where nothing read
 * it: `remove --provider`, `list --from-members` and `add --claim` looked
 * applied and were not. `bind` additionally narrows this set per form
 * (`dispatchBind`). A subcommand absent here is not one, and gets the usage.
 */
export const SUBCOMMAND_FLAGS = {
  list: ["tenant", "unbound"],
  unmapped: ["days"],
  add: ["tenant", "domain", "by", "from", "provider", "unbound", "accept-unused-provider", "yes"],
  bind: ["claim", "provider", "by", "accept-unused-provider", "yes", "apply", "from-members", "out"],
  remove: ["tenant", "domain", "by", "yes"],
  history: ["domain", "tenant", "after"],
  realign: ["user", "tenant", "by", "yes"],
  measure: [],
  "legacy-accounts": [],
  "backfill-owning-column": ["by", "apply", "yes", "limit"],
} as const satisfies Record<string, readonly (ValueFlag | ScopedValueFlag | BooleanFlag)[]>;

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

/** The value-taking flags only `subcommand` declares, with their hints. */
function scopedValueFlags(subcommand: string | undefined): Readonly<Record<string, string>> {
  if (subcommand === undefined || !Object.prototype.hasOwnProperty.call(SUBCOMMAND_VALUE_FLAG_HINTS, subcommand)) {
    return {};
  }
  return SUBCOMMAND_VALUE_FLAG_HINTS[subcommand as keyof typeof SUBCOMMAND_VALUE_FLAG_HINTS];
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
export function parseFlags(argv: string[], subcommand?: string): FlagParseResult {
  const flags: ParsedFlags = new Map();
  const scoped = scopedValueFlags(subcommand);

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      return {
        ok: false,
        error:
          `Unexpected argument "${escapeUnsafeDisplayChars(tok)}". Every input to this command is a flag; ` +
          "a bare word is either a typo or a value whose flag was dropped.",
      };
    }

    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    // Round-4 S5. `Map.set` overwrites, so a repeated flag silently discarded
    // the operator's first token: `remove --tenant A --tenant B` acts on B,
    // and `add --from A --from B` reassigns away from a different owner than
    // the one they named — on a path where `--yes` removes the visual check.
    // That is the same "an instruction the operator believes was applied"
    // failure the valueless guard exists for, so it belongs to the same rule,
    // and the member set is derived from the parser's own state machine
    // rather than from the spellings that happened to be reported.
    if (flags.has(name)) {
      // The rationale that generalises is the module's own rule, not the
      // reassignment case (round-5 F7): this guard fires for `--yes` and
      // `--days` too, and telling an operator repeating `--days` that "the
      // discarded token names a different tenant" is internal jargon about
      // someone else's flag.
      return {
        ok: false,
        error:
          `--${escapeUnsafeDisplayChars(name)} was given more than once. Refusing rather than taking the last one: ` +
          "a flag the operator wrote must either take effect or stop the command.",
      };
    }

    const isScopedValue = Object.prototype.hasOwnProperty.call(scoped, name);

    if (!isScopedValue && isBooleanFlag(name)) {
      if (inlineValue !== undefined) {
        return {
          ok: false,
          error: `--${escapeUnsafeDisplayChars(name)} takes no value (got "${escapeUnsafeDisplayChars(inlineValue)}").`,
        };
      }
      flags.set(name, true);
      continue;
    }

    if (!isScopedValue && !isValueFlag(name)) {
      return { ok: false, error: `Unknown flag --${escapeUnsafeDisplayChars(name)}. ${usageHint()}` };
    }

    if (inlineValue !== undefined) {
      if (inlineValue === "") {
        return { ok: false, error: valuelessError(name as AnyValueFlag, subcommand) };
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

export function valuelessError(name: AnyValueFlag, subcommand?: string): string {
  const scoped = scopedValueFlags(subcommand);
  const hint = Object.prototype.hasOwnProperty.call(scoped, name)
    ? scoped[name]
    : VALUE_FLAG_HINTS[name as ValueFlag];
  return `--${name} requires a value (${hint}). ${REFUSAL_RATIONALE}`;
}

export function getStringFlag(flags: ParsedFlags, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * The first value-taking flag that was given without a value, if any — under
 * `subcommand`, whose scoped value flags count too (a bare `bind --apply` is
 * a missing file, not a switch).
 */
export function findValuelessFlag(flags: ParsedFlags, subcommand?: string): AnyValueFlag | null {
  for (const name of Object.keys(VALUE_FLAG_HINTS) as ValueFlag[]) {
    if (flags.get(name) === true) return name;
  }
  for (const name of Object.keys(scopedValueFlags(subcommand)) as ScopedValueFlag[]) {
    if (flags.get(name) === true) return name;
  }
  return null;
}

/**
 * The flags given that `subcommand` does not read, in command-line order. Empty
 * for a subcommand `SUBCOMMAND_FLAGS` does not list — the caller prints the
 * usage for that one.
 */
export function findStrayFlags(flags: ParsedFlags, subcommand: string | undefined): string[] {
  if (subcommand === undefined || !Object.prototype.hasOwnProperty.call(SUBCOMMAND_FLAGS, subcommand)) return [];
  const accepted: readonly string[] = SUBCOMMAND_FLAGS[subcommand as keyof typeof SUBCOMMAND_FLAGS];
  return [...flags.keys()].filter((name) => !accepted.includes(name));
}

export function strayFlagsError(stray: readonly string[], subcommand: string): string {
  return (
    `${escapeUnsafeDisplayChars(subcommand)} does not read ${stray.map((name) => `--${escapeUnsafeDisplayChars(name)}`).join(", ")}. ` +
    "Refusing rather than ignoring it: a flag the operator wrote must either take effect or stop the command."
  );
}
