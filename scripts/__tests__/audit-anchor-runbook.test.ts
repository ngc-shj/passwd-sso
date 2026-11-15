/**
 * The rotation runbook against what runs: every `npm run <name>` it shows is
 * a package.json script, and every flag it shows for an audit-anchor-keys
 * subcommand is one that subcommand's option table takes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBCOMMANDS } from "../audit-anchor-keys";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNBOOK = readFileSync(join(ROOT, "docs/operations/audit-anchor-rotation-runbook.md"), "utf8");
const PACKAGE_SCRIPTS = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
  .scripts;

// A floor: the runbook must show these, so a parser that finds nothing fails.
const REQUIRED_SCRIPTS = [
  "audit-anchor-kid",
  "audit-anchor-publish-pubkey",
  "audit-anchor-rotation-statement",
  "audit-anchor-chain-restart",
  "audit-anchor-publish-statement",
  "generate:audit-anchor-signing-key",
];

type ShownCommand = { script: string; flags: string[] };

/**
 * Every `npm run <name>` in `text` with the flags shown after its `--`. A
 * command runs to the end of its line, continued by a trailing backslash, or
 * to the backtick that closes an inline code span.
 */
function shownCommands(text: string): ShownCommand[] {
  const commands: ShownCommand[] = [];
  for (const match of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    const rest = text.slice(match.index + match[0].length);
    const end = /`|(?<!\\)\n/.exec(rest);
    const args = (end ? rest.slice(0, end.index) : rest).split(/\s--\s/).slice(1).join(" ");
    commands.push({ script: match[1], flags: [...args.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]) });
  }
  return commands;
}

/** The audit-anchor-keys subcommand a package.json script runs, or null for any other script. */
function subcommandOf(script: string): string | null {
  return /^tsx scripts\/audit-anchor-keys\.ts (\S+)$/.exec(PACKAGE_SCRIPTS[script] ?? "")?.[1] ?? null;
}

function unknownScripts(text: string): string[] {
  return [...new Set(shownCommands(text).map((c) => c.script))].filter((script) => !Object.hasOwn(PACKAGE_SCRIPTS, script));
}

function unknownFlags(text: string): string[] {
  const table: Record<string, { options: Record<string, string> }> = SUBCOMMANDS;
  const unknown: string[] = [];
  for (const { script, flags } of shownCommands(text)) {
    const subcommand = subcommandOf(script);
    if (subcommand === null) continue;
    const options = table[subcommand]?.options ?? {};
    for (const flag of flags) {
      if (!Object.hasOwn(options, flag)) unknown.push(`${script} --${flag}`);
    }
  }
  return unknown;
}

describe("audit-anchor rotation runbook", () => {
  it("has no step marked as not yet automated", () => {
    expect(RUNBOOK).not.toMatch(/not yet automated/i);
  });

  it("shows the five audit-anchor scripts and the key generator", () => {
    const shown = new Set(shownCommands(RUNBOOK).map((c) => c.script));
    expect(REQUIRED_SCRIPTS.filter((script) => !shown.has(script))).toEqual([]);
  });

  it("shows only npm scripts that package.json defines", () => {
    expect(unknownScripts(RUNBOOK)).toEqual([]);
  });

  it("reports an npm script that package.json does not define", () => {
    expect(unknownScripts(`${RUNBOOK}\nnpm run audit-anchor-emit-rotation-event -- --phase overlap-start\n`)).toEqual([
      "audit-anchor-emit-rotation-event",
    ]);
  });

  it("shows only flags the subcommand's option table takes", () => {
    expect(unknownFlags(RUNBOOK)).toEqual([]);
  });

  it("shows at least one flag for every audit-anchor-keys subcommand", () => {
    const withFlags = new Set(
      shownCommands(RUNBOOK)
        .filter((c) => c.flags.length > 0)
        .map((c) => subcommandOf(c.script)),
    );
    expect(Object.keys(SUBCOMMANDS).filter((name) => !withFlags.has(name))).toEqual([]);
  });

  it("reports a flag the subcommand does not take, across a continued line", () => {
    const text = "npm run audit-anchor-publish-statement -- \\\n  --file rotation.jws --key-file old.hex --confirm\n";
    expect(unknownFlags(text)).toEqual(["audit-anchor-publish-statement --key-file"]);
  });
});
