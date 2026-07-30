import { describe, expect, it } from "vitest";
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

  it("the known-flag set is exactly the value flags plus the boolean flags", () => {
    // Anti-drift: a new flag added to the CLI's switch but not to these tables
    // would be refused at parse time, so the failure is loud here rather than
    // in an operator's terminal.
    const known = [...Object.keys(VALUE_FLAG_HINTS), ...BOOLEAN_FLAGS];
    expect(known).toEqual(["tenant", "domain", "by", "from", "days", "yes"]);
    for (const name of known) {
      expect(parseFlags([`--${name}`, "v"]).ok || parseFlags([`--${name}`]).ok).toBe(true);
    }
  });
});
