import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOOLEAN_FLAGS,
  SUBCOMMAND_FLAGS,
  VALUE_FLAG_HINTS,
  findStrayFlags,
  findValuelessFlag,
  getStringFlag,
  parseFlags,
  strayFlagsError,
  valuelessError,
} from "../lib/tenant-domain-flags";
import {
  applyOneCandidate,
  cmdBackfillOwningColumn,
  listDivergentCandidates,
  migrationClientFactory,
} from "../tenant-domain";
import { SIGNIN_ACTOR_LABEL } from "@/lib/tenant/tenant-claim-event";

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
    // (20260731170000) is `history`'s pagination cursor; "user" (round 7,
    // F-R7-2) names `realign`'s user; "limit" and "apply" (C4/#838) are
    // `backfill-owning-column`'s candidate cap and its apply/dry-run switch;
    // "provider", "claim", "out", "unbound", "accept-unused-provider" and
    // "from-members" are the claim-binding writers' (sso-claim-connection-binding C3);
    // "single-connection" is `legacy-accounts`' operator attestation.
    expect([...declared]).toEqual([
      "tenant", "domain", "by", "from", "days", "after", "user", "limit", "provider", "claim", "out",
      "yes", "apply", "unbound", "accept-unused-provider", "from-members", "single-connection",
    ]);
    expect(read.size).toBeGreaterThan(0);
  });

  // Round-4 S5. `Map.set` overwrote, so a repeated flag silently discarded the
  // operator's first token — and on `add --from A --from B` the discarded one
  // names a different losing tenant, with `--yes` removing the visual check.
  // Same rule as the valueless guard; the member set was derived from the
  // parser's state machine rather than from the spellings that got reported.
  it.each(["tenant", "domain", "by", "from", "days", "user", "limit"])(
    "refuses a repeated --%s instead of taking the last one",
    (name) => {
      const error = errorOf([`--${name}`, "a", `--${name}`, "b"]);
      expect(error).toContain(`--${name} was given more than once`);
    },
  );

  it("refuses a repeated --yes", () => {
    expect(errorOf(["--yes", "--yes"])).toContain("--yes was given more than once");
  });

  // Round-1 F4 (Phase 3): a flag valid for SOME subcommand passed parseFlags
  // everywhere and was dropped where nothing read it.
  describe("per-subcommand accepted flags", () => {
    function strayOf(subcommand: string, argv: string[]): string[] {
      const parsed = parseFlags(argv, subcommand);
      if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.error}`);
      return findStrayFlags(parsed.flags, subcommand);
    }

    it.each([
      ["remove", ["--tenant", "t", "--domain", "d", "--by", "ops", "--provider", "google"], ["provider"]],
      ["list", ["--provider", "google"], ["provider"]],
      ["list", ["--from-members", "--out", "/tmp/x"], ["from-members", "out"]],
      ["add", ["--tenant", "t", "--domain", "d", "--by", "ops", "--claim", "c"], ["claim"]],
      ["add", ["--tenant", "t", "--domain", "d", "--by", "ops", "--from-members"], ["from-members"]],
      ["history", ["--domain", "d", "--unbound"], ["unbound"]],
      ["realign", ["--user", "u", "--tenant", "t", "--by", "ops", "--accept-unused-provider"], ["accept-unused-provider"]],
      ["unmapped", ["--out", "/tmp/x"], ["out"]],
      ["measure", ["--yes"], ["yes"]],
      ["legacy-accounts", ["--tenant", "t"], ["tenant"]],
    ])("%s refuses %j", (subcommand, argv, stray) => {
      expect(strayOf(subcommand, argv)).toEqual(stray);
    });

    it.each([
      ["list", ["--tenant", "t", "--unbound"]],
      ["unmapped", ["--days", "180"]],
      ["add", ["--tenant", "t", "--domain", "d", "--by", "ops", "--from", "f", "--provider", "google", "--accept-unused-provider", "--yes"]],
      ["add", ["--tenant", "t", "--domain", "d", "--by", "ops", "--unbound"]],
      ["bind", ["--claim", "c", "--provider", "google", "--by", "ops", "--accept-unused-provider", "--yes"]],
      ["bind", ["--from-members", "--out", "/tmp/x"]],
      ["bind", ["--apply", "/tmp/x", "--by", "ops", "--yes"]],
      ["remove", ["--tenant", "t", "--domain", "d", "--by", "ops", "--yes"]],
      ["history", ["--domain", "d", "--tenant", "t", "--after", "3"]],
      ["realign", ["--user", "u", "--tenant", "t", "--by", "ops", "--yes"]],
      ["measure", []],
      ["legacy-accounts", []],
      ["legacy-accounts", ["--single-connection"]],
      ["backfill-owning-column", ["--by", "ops", "--apply", "--yes", "--limit", "5"]],
    ])("%s accepts the documented form %j", (subcommand, argv) => {
      expect(strayOf(subcommand, argv)).toEqual([]);
    });

    it("leaves an unknown subcommand to the usage", () => {
      expect(strayOf("preflight", ["--tenant", "t"])).toEqual([]);
    });

    it("names the subcommand and every stray flag, escaped", () => {
      expect(strayFlagsError(["provider", "claim"], "remove")).toMatch(/^remove does not read --provider, --claim\. Refusing/);
      expect(strayFlagsError(["x\u202e"], "list")).not.toContain("\u202e");
    });

    it("each subcommand accepts exactly the flags its dispatch reads", () => {
      // Derived from the CLI, the same three read spellings as the known-flag
      // test above: a case in main()'s switch (or dispatchBind, for bind) that
      // reads a flag its SUBCOMMAND_FLAGS entry lacks would refuse a valid
      // command; one that lists a flag the case never reads would drop it.
      const cli = readFileSync(resolve(__dirname, "../tenant-domain.ts"), "utf8");
      const switchStart = cli.indexOf("switch (subcommand) {");
      const switchBody = cli.slice(switchStart, cli.indexOf("    default:", switchStart));
      const bindBody = cli.slice(cli.indexOf("async function dispatchBind("), cli.indexOf("async function main("));
      const SPELLINGS = [
        /getStringFlag\(flags,\s*"([^"]+)"\)/g,
        /flags\.get\("([^"]+)"\)/g,
        /flags\.has\("([^"]+)"\)/g,
      ];
      const readsOf = (body: string): string[] => {
        const read = new Set<string>();
        for (const re of SPELLINGS) for (const m of body.matchAll(re)) read.add(m[1]);
        // `yes` is read once above the switch and passed on as an identifier.
        if (/(?<![-\w])yes(?=\s*[,})])/.test(body)) read.add("yes");
        return [...read].sort();
      };
      // A case that hands `flags` on whole (`cmdFoo(flags)`) reads flags this
      // derivation cannot see, so any `flags` reference other than the read
      // spellings and bind's dispatcher call fails the test, naming the case.
      const unrecognisedFlagsUse = (chunk: string): boolean => {
        let residue = chunk.replace("dispatchBind(flags, yes)", "");
        for (const re of SPELLINGS) residue = residue.replace(re, "");
        return /\bflags\b/.test(residue);
      };
      const cases = switchBody.split(/\n    case "/).slice(1).map((chunk) => {
        const name = chunk.slice(0, chunk.indexOf('"'));
        expect(unrecognisedFlagsUse(chunk), `case "${name}" uses flags other than by a recognised read`).toBe(false);
        return [name, readsOf(name === "bind" ? bindBody : chunk)] as const;
      });
      expect(unrecognisedFlagsUse('case "foo": return cmdFoo(flags);'), "the residue check against its own sample").toBe(true);
      // dispatchBind reads bind's flags itself, so its body gets the same check.
      // Its own signature and its stray-flag scan (`flags.keys()`, which reads
      // no flag's value) are the two uses it is allowed besides the read spellings.
      const BIND_SIGNATURE = "async function dispatchBind(flags: ParsedFlags, yes: boolean)";
      const BIND_STRAY_SCAN = "[...flags.keys()]";
      expect(bindBody.startsWith(BIND_SIGNATURE), "dispatchBind's signature as this test spells it").toBe(true);
      expect(bindBody.split(BIND_STRAY_SCAN).length - 1, "dispatchBind's stray-flag scan, once").toBe(1);
      const bindUnrecognised = (body: string): boolean =>
        unrecognisedFlagsUse(body.replace(BIND_SIGNATURE, "").replace(BIND_STRAY_SCAN, ""));
      expect(bindUnrecognised(bindBody), "dispatchBind uses flags other than by a recognised read").toBe(false);
      expect(
        bindUnrecognised(`${BIND_SIGNATURE} {\n  [...flags.keys()];\n  return cmdBindFoo(flags);\n}`),
        "the dispatchBind residue check against its own sample",
      ).toBe(true);
      expect(cases.map(([name]) => name)).toEqual(Object.keys(SUBCOMMAND_FLAGS));
      for (const [name, reads] of cases) {
        expect(reads, name).toEqual([...SUBCOMMAND_FLAGS[name as keyof typeof SUBCOMMAND_FLAGS]].sort());
      }
    });
  });

  describe("--apply under bind takes the reviewed file (C3)", () => {
    it("reads the value after --apply as bind's file", () => {
      const parsed = parseFlags(["--apply", "/tmp/bind.tsv", "--by", "ops"], "bind");
      expect(parsed.ok && getStringFlag(parsed.flags, "apply")).toBe("/tmp/bind.tsv");
    });

    it("reports a bare bind --apply as a missing file, not a switch", () => {
      const parsed = parseFlags(["--apply", "--by", "ops"], "bind");
      if (!parsed.ok) throw new Error(parsed.error);
      expect(findValuelessFlag(parsed.flags, "bind")).toBe("apply");
      expect(valuelessError("apply", "bind")).toContain("the reviewed bind file");
    });

    it("still refuses a value on --apply outside bind (the adjacent allow keeps it a switch there)", () => {
      expect(errorOf(["--apply", "/tmp/bind.tsv"])).toContain('Unexpected argument "/tmp/bind.tsv"');
      const parsed = parseFlags(["--apply", "/tmp/bind.tsv"], "backfill-owning-column");
      expect(parsed.ok).toBe(false);
    });
  });

  it("parses the boolean --apply", () => {
    const flags = flagsOf(["--apply"]);
    expect(flags.get("apply")).toBe(true);
    expect(findValuelessFlag(flags)).toBeNull();
  });

  it("does not set --apply when omitted — backfill-owning-column's dry-run default", () => {
    expect(flagsOf(["--by", "ops"]).get("apply")).toBeUndefined();
  });

  it("refuses a value on --apply", () => {
    expect(errorOf(["--apply=true"])).toContain("--apply takes no value");
  });

  it("refuses a repeated --apply", () => {
    expect(errorOf(["--apply", "--apply"])).toContain("--apply was given more than once");
  });

  it("refuses a repeat written in the other form", () => {
    // `--days 1 --days=2` is the same instruction twice in two spellings.
    expect(errorOf(["--days", "1", "--days=2"])).toContain("--days was given more than once");
  });
});

/**
 * A-C4-2c. `cmdBackfillOwningColumn` validates `--by` with the shared
 * `validateActorLabel` before `migrationClientFactory.create` is ever called —
 * same convention as `cmdRealign`'s bidi cell. These need no live database:
 * a rejection here returns before the client is built, so
 * `MIGRATION_DATABASE_URL` only has to be SET, never actually reachable.
 */
describe("backfill-owning-column: --by is validated before any client is built (A-C4-2c)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a --by carrying a bidi control, regardless of --apply", async () => {
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgresql://unreachable.invalid/db");
    const createSpy = vi.spyOn(migrationClientFactory, "create");
    try {
      const result = await cmdBackfillOwningColumn({
        by: `ops${String.fromCodePoint(0x202e)}admin`,
        apply: true,
        yes: true,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("--by contains a control, bidi or zero-width character");
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("rejects the reserved signin label", async () => {
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgresql://unreachable.invalid/db");
    const createSpy = vi.spyOn(migrationClientFactory, "create");
    try {
      const result = await cmdBackfillOwningColumn({ by: SIGNIN_ACTOR_LABEL, apply: true, yes: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`--by must not be "${SIGNIN_ACTOR_LABEL}"`);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("rejects an empty --by — the CLI's stand-in for --apply without --by", async () => {
    // main() refuses a bare `backfill-owning-column --apply` (no --by) with
    // printUsage()+exit 1 before ever calling this command, the same guard
    // `add`/`remove`/`realign` use — untestable here since main() sets
    // process.exitCode (module header, "run only when invoked as a CLI").
    // This pins the command-level backstop under it: an empty label is
    // refused the same way, so the class is closed at two layers, not one.
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgresql://unreachable.invalid/db");
    const createSpy = vi.spyOn(migrationClientFactory, "create");
    try {
      const result = await cmdBackfillOwningColumn({ by: "", apply: true, yes: true });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("--by is required");
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });
});

/**
 * issue-838 follow-ups review, finding C. D8 made the owning-tenant rule's
 * input order total — `[createdAt, id]`, not `createdAt` alone — in every
 * reader, including the two `backfill-owning-column` added here. The three
 * ORM readers in src/lib/tenant-context.ts are pinned by mock-call assertions
 * in tenant-context.test.ts; these two were not. Per D1, no DB fixture can
 * observe a tie (`tenant_members_one_active_per_user` makes one
 * unconstructible), so the secondary key can only be pinned by spying the
 * `tx` client passed in and asserting the SQL text / orderBy shape it sends —
 * never by a live row.
 */
describe("backfill-owning-column readers carry the total order (D8)", () => {
  it("listDivergentCandidates's raw SQL orders the LATERAL pick by created_at THEN id", async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([]);
    const tx = { $queryRawUnsafe: queryRawUnsafe } as unknown as Parameters<
      typeof listDivergentCandidates
    >[0];

    await listDivergentCandidates(tx, 10);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql] = queryRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain("ORDER BY tm.created_at ASC, tm.id ASC");
  });

  it("applyOneCandidate's re-read orders active memberships by createdAt THEN id", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const tx = { user: { findUnique } } as unknown as Parameters<typeof applyOneCandidate>[0];

    await applyOneCandidate(tx, "user-1", "ops-alice");

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          tenantMemberships: expect.objectContaining({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          }),
        }),
      }),
    );
  });
});
