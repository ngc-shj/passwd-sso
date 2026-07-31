import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOOLEAN_FLAGS,
  VALUE_FLAG_HINTS,
  findValuelessFlag,
  getStringFlag,
  parseFlags,
  valuelessError,
} from "../lib/tenant-domain-flags";

/**
 * Round-3 M7: this parser and its valueless-flag guard had no test at all —
 * the only caller is the CLI's `main()`, which the integration suite cannot
 * invoke (it sets `process.exitCode`). Round-3 S3-5 then found the guard was
 * also incomplete, which is exactly the defect an untested guard hides.
 *
 * The property under test is one rule: a flag the operator wrote either takes
 * effect or stops the command. Every case below is a way of writing a flag
 * whose previous outcome was "silently ignored".
 */

function flagsOf(argv: string[]) {
  const parsed = parseFlags(argv);
  if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.error}`);
  return parsed.flags;
}

function errorOf(argv: string[]): string {
  const parsed = parseFlags(argv);
  if (parsed.ok) throw new Error("expected parse to fail");
  return parsed.error;
}

describe("tenant-domain flag parsing", () => {
  /**
   * Round-6 F4. Round 5 declared the operator-echo escape class closed at "all
   * five sites"; it had enumerated the CLI file only, and four of the misses are
   * in this module — including one whose surrounding message string round 5
   * edited without escaping the interpolation inside it.
   *
   * These are the least validated echoes in the whole tool: a refused flag is
   * printed before any schema has seen it, straight off `process.argv`. Every
   * refusal message is checked here rather than one of them, because the missing
   * sites were siblings of a fixed one — which is the shape a per-site test does
   * not catch.
   */
  const RLO = String.fromCodePoint(0x202e);

  it.each([
    ["a bare positional", [`ops${RLO}admin`]],
    ["an unknown flag", [`--ops${RLO}admin`, "x"]],
    ["a repeated flag", ["--tenant", "a", "--tenant", "b"]],
    ["a boolean flag given a value", [`--yes=ops${RLO}admin`]],
  ])("escapes operator input in the refusal for %s", (_label, argv) => {
    const error = errorOf(argv as string[]);
    expect(error).not.toContain(RLO);
  });

  it("still renders the offending token, escaped rather than dropped", () => {
    // Escaping, not stripping: a stripped `ops<U+202E>admin` prints as
    // `opsadmin`, so the operator is shown a token they did not type and told it
    // was refused.
    expect(errorOf([`ops${RLO}admin`])).toContain("ops<U+202E>admin");
  });

  it("parses the space-separated form", () => {
    const flags = flagsOf(["--tenant", "acmecorp", "--domain", "alias.example"]);
    expect(getStringFlag(flags, "tenant")).toBe("acmecorp");
    expect(getStringFlag(flags, "domain")).toBe("alias.example");
  });

  it("parses the --name=value form", () => {
    // S3-5. The old parser keyed this as "days=30", so getStringFlag("days")
    // returned undefined — indistinguishable from "--days not given" — and
    // `unmapped` queried the DEFAULT window while the operator believed they
    // had widened it to 30 days. At incident time that is the difference
    // between "nothing was denied" and "I did not look".
    const flags = flagsOf(["--days=30"]);
    expect(getStringFlag(flags, "days")).toBe("30");
  });

  it("parses a value containing an equals sign after the first one", () => {
    const flags = flagsOf(["--by=ops=oncall"]);
    expect(getStringFlag(flags, "by")).toBe("ops=oncall");
  });

  it("parses the boolean --yes", () => {
    const flags = flagsOf(["--yes"]);
    expect(flags.get("yes")).toBe(true);
    expect(findValuelessFlag(flags)).toBeNull();
  });

  it("refuses a value on the boolean flag", () => {
    expect(errorOf(["--yes=true"])).toContain("--yes takes no value");
  });

  it("refuses an unknown flag instead of dropping it", () => {
    // The half of the fix that makes the class closed rather than one spelling
    // fixed: a typo used to be silently discarded, so the command ran with the
    // operator's instruction missing.
    const error = errorOf(["--dayss", "30"]);
    expect(error).toContain("Unknown flag --dayss");
    expect(error).toContain("--days");
  });

  it("refuses a flag whose case does not match", () => {
    expect(errorOf(["--Days", "30"])).toContain("Unknown flag --Days");
  });

  it("refuses a bare positional argument", () => {
    expect(errorOf(["--domain", "alias.example", "oops"])).toContain('Unexpected argument "oops"');
  });

  it.each(Object.keys(VALUE_FLAG_HINTS))(
    "reports --%s written without a value, by name",
    (name) => {
      const flags = flagsOf([`--${name}`]);
      expect(findValuelessFlag(flags)).toBe(name);
    },
  );

  it("reports a value flag followed by another flag as valueless", () => {
    // `--from --yes` must not read as "no reassignment requested".
    const flags = flagsOf(["--from", "--yes"]);
    expect(findValuelessFlag(flags)).toBe("from");
    expect(flags.get("yes")).toBe(true);
  });

  it("refuses an empty inline value", () => {
    expect(errorOf(["--domain="])).toContain("--domain requires a value");
  });

  it("names the flag and its hint in the valueless message", () => {
    const message = valuelessError("days");
    expect(message).toContain("--days requires a value");
    expect(message).toContain(VALUE_FLAG_HINTS.days);
  });

  it("returns null when every value flag has a value", () => {
    const flags = flagsOf(["--tenant", "acmecorp", "--domain", "alias.example", "--by", "ops"]);
    expect(findValuelessFlag(flags)).toBeNull();
  });

  it("getStringFlag reports a valueless flag as absent, which is why the guard exists", () => {
    // Pins the ambiguity the guard compensates for: without it, this
    // `undefined` is what reaches the command as "flag not given".
    const flags = flagsOf(["--days"]);
    expect(getStringFlag(flags, "days")).toBeUndefined();
    expect(findValuelessFlag(flags)).toBe("days");
  });

  it("the known-flag set is exactly the flags the CLI reads", () => {
    // Round-4 T8. The loop this replaces asserted that every flag in these
    // tables parses — a tautology, since `isValueFlag`/`isBooleanFlag` derive
    // acceptance from the same tables. The real anti-drift property is against
    // the CLI: a flag `tenant-domain.ts` reads but never declared here is
    // refused at parse time, so the operator's instruction silently never
    // reaches the command. Derived by reading the CLI's own flag reads.
    // Round-5 T7 wanted all three spellings proved live. Round-6 T5: it did not
    // get that. `flags.has("x")` matches NOTHING in the CLI — the parser's only
    // use is `flags.has(name)`, with a variable — so the guard exempted it from
    // the non-empty check, and the review log's claim that all three were
    // "asserted each matched" was false for exactly the one that could not.
    //
    // Two different properties, separated here rather than conflated:
    //   1. the REGEX is well-formed and matches the shape it names — proved
    //      against a synthetic sample, so a spelling the CLI does not use today
    //      still cannot rot into one that matches nothing;
    //   2. the CLI's actual flag reads are a subset of the declared tables —
    //      proved against the file, and only spellings the CLI genuinely uses
    //      can carry that half.
    const cli = readFileSync(resolve(__dirname, "../tenant-domain.ts"), "utf8");
    const SPELLINGS = [
      { re: /getStringFlag\(flags,\s*"([^"]+)"\)/g, sample: 'getStringFlag(flags, "probe")' },
      { re: /flags\.get\("([^"]+)"\)/g, sample: 'flags.get("probe")' },
      { re: /flags\.has\("([^"]+)"\)/g, sample: 'flags.has("probe")' },
    ];
    const read = new Set<string>();
    for (const { re, sample } of SPELLINGS) {
      // (1) Self-test: the regex can match, and captures the flag name.
      expect([...sample.matchAll(re)].map((m) => m[1]), `${re} against its own sample`).toEqual([
        "probe",
      ]);
      // (2) Whatever it finds in the CLI joins the member set.
      [...cli.matchAll(re)].map((m) => m[1]).forEach((f) => read.add(f));
    }

    const declared = new Set<string>([...Object.keys(VALUE_FLAG_HINTS), ...BOOLEAN_FLAGS]);
    expect([...read].sort().filter((f) => !declared.has(f))).toEqual([]);
    // And the literal pin, so ADDING a flag to the tables is a deliberate edit
    // rather than something that slips in with an unrelated change. "after"
    // (20260731170000) is `history`'s pagination cursor.
    expect([...declared]).toEqual(["tenant", "domain", "by", "from", "days", "after", "yes"]);
    expect(read.size).toBeGreaterThan(0);
  });

  // Round-4 S5. `Map.set` overwrote, so a repeated flag silently discarded the
  // operator's first token — and on `add --from A --from B` the discarded one
  // names a different losing tenant, with `--yes` removing the visual check.
  // Same rule as the valueless guard; the member set was derived from the
  // parser's state machine rather than from the spellings that got reported.
  it.each(["tenant", "domain", "by", "from", "days"])(
    "refuses a repeated --%s instead of taking the last one",
    (name) => {
      const error = errorOf([`--${name}`, "a", `--${name}`, "b"]);
      expect(error).toContain(`--${name} was given more than once`);
    },
  );

  it("refuses a repeated --yes", () => {
    expect(errorOf(["--yes", "--yes"])).toContain("--yes was given more than once");
  });

  it("refuses a repeat written in the other form", () => {
    // `--days 1 --days=2` is the same instruction twice in two spellings.
    expect(errorOf(["--days", "1", "--days=2"])).toContain("--days was given more than once");
  });
});
