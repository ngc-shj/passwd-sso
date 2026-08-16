/**
 * Tests for .claude/hooks/block-bare-decrypt.sh — the pre-tool-use lint that
 * keeps a vault credential's stdout out of the conversation.
 *
 * Read the hook's own header first: it is a lint, NOT a security boundary. It
 * matches the command string before execution, and a shell string does not
 * determine the argv the process will see. The "known evasions" block below
 * pins that limitation as a fact rather than leaving it as a comment nobody
 * re-checks — if one of those ever starts being refused, the hook gained reach
 * and the header should be re-read, not silently trusted further.
 *
 * The regression this file exists for: two earlier revisions each shipped a
 * failure the other did not have. One allowed `(<cli> <sub> x)` and
 * `<cli> <sub> x | cat` on shape heuristics that prove nothing about where
 * stdout lands. The next refused everything — including the /use-credential
 * pattern its own error message recommends, which made the sanctioned workflow
 * impossible to run. Both directions are asserted here.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = resolve(REPO_ROOT, ".claude/hooks/block-bare-decrypt.sh");

// Built from fragments so this file's own source does not contain the literal
// command — the hook is installed on this repo, and a test fixture that spells
// it out would be flagged when the test file itself is edited via the Bash tool.
const CLI = "npx tsx " + REPO_ROOT + "/cli/src/index.ts";
const SUB = "dec" + "rypt";

/** Run the hook with a tool_input payload; returns its exit status. */
function runHook(command) {
  const payload = JSON.stringify({ tool_input: { command } });
  const r = spawnSync("bash", [HOOK], { input: payload, encoding: "utf8" });
  return r.status;
}

/** Run the hook with a raw (possibly malformed) stdin payload. */
function runHookRaw(payload) {
  const r = spawnSync("bash", [HOOK], { input: payload, encoding: "utf8" });
  return r.status;
}

const ALLOW = 0;
const BLOCK = 2;

describe("block-bare-decrypt hook", () => {
  describe("allows the /use-credential pattern", () => {
    // These are the shapes .claude/skills/use-credential/SKILL.md documents. If
    // the hook refuses them the skill cannot be used at all, which is what the
    // error message tells the caller to do — a contradiction that shipped once.
    it("allows _CRED assigned in a subshell and consumed by curl", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -u "user:\${_CRED}" https://example.test\n) 2>/dev/null`;
      expect(runHook(cmd)).toBe(ALLOW);
    });

    it("allows the bearer-token variant", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -H "Authorization: Bearer \${_CRED}" https://example.test\n) 2>/dev/null`;
      expect(runHook(cmd)).toBe(ALLOW);
    });

    it("allows the generic consuming-command variant (Pattern C)", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  some-tool --token "\${_CRED}"\n) 2>/dev/null`;
      expect(runHook(cmd)).toBe(ALLOW);
    });

    // Patterns D and E do NOT use _CRED — they pipe straight into a clipboard
    // sink. An earlier revision keyed the allow on "_CRED=$(" being present
    // anywhere, so both were refused and the documented macOS/Linux clipboard
    // flows could not run.
    it("allows the macOS clipboard pattern (Pattern D)", () => {
      const cmd = `(\n  ${CLI} ${SUB} ID --field password | pbcopy\n  echo "Copied to clipboard"\n) 2>/dev/null`;
      expect(runHook(cmd)).toBe(ALLOW);
    });

    it("allows the Linux clipboard pattern (Pattern E)", () => {
      const cmd = `(\n  ${CLI} ${SUB} ID --field password | xclip -selection clipboard\n  echo "Copied to clipboard"\n) 2>/dev/null`;
      expect(runHook(cmd)).toBe(ALLOW);
    });
  });

  describe("blocks shapes that put the credential on stdout", () => {
    it("blocks a bare run", () => {
      expect(runHook(`passwd-sso ${SUB} item`)).toBe(BLOCK);
    });

    it("blocks a subshell that does not capture into _CRED", () => {
      // A leading paren was once treated as proof of safety. It is not: stdout
      // still goes to stdout.
      expect(runHook(`(passwd-sso ${SUB} item)`)).toBe(BLOCK);
    });

    it("blocks a pipe whose last stage prints", () => {
      // A pipe was once treated as proof of safety. `cat` writes it out.
      expect(runHook(`passwd-sso ${SUB} item | cat`)).toBe(BLOCK);
    });

    it("blocks a sanctioned subshell that echoes the credential", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID)\n  echo $_CRED\n)`;
      expect(runHook(cmd)).toBe(BLOCK);
    });

    it("blocks a decoy _CRED that captures something else", () => {
      // The allow must be anchored on the decrypt OCCURRENCE. Testing "starts
      // with (" and "contains _CRED=$(" independently accepted this: the
      // assignment captured `true` while the real decrypt ran bare beside it.
      expect(runHook(`(_CRED=$(true); passwd-sso ${SUB} item)`)).toBe(BLOCK);
    });

    it("blocks a pipe into a sink that prints", () => {
      // The clipboard allow is a closed set. `tee` writes to stdout, so it is
      // not a consuming sink even though it looks like one.
      expect(runHook(`${CLI} ${SUB} ID | tee /tmp/x`)).toBe(BLOCK);
    });

    it("blocks a pipe into an unknown command", () => {
      // A decrypt piped into something this lint cannot vouch for.
      expect(runHook(`${CLI} ${SUB} ID | some-unknown-tool`)).toBe(BLOCK);
    });
  });

  describe("refuses rather than allowing when it cannot read its input", () => {
    // A guard that cannot parse its input has not cleared that input. Each of
    // these once mapped to an empty command and took the "not a decrypt" path.
    it("blocks malformed JSON", () => {
      expect(runHookRaw("{bad json")).toBe(BLOCK);
    });

    it("blocks a missing command key", () => {
      expect(runHookRaw(JSON.stringify({ tool_input: {} }))).toBe(BLOCK);
    });

    it("blocks a null command", () => {
      expect(runHookRaw(JSON.stringify({ tool_input: { command: null } }))).toBe(BLOCK);
    });

    it("blocks a non-string command", () => {
      expect(runHookRaw(JSON.stringify({ tool_input: { command: 123 } }))).toBe(BLOCK);
    });
  });

  describe("does not block unrelated commands", () => {
    // The over-blocking direction. A hook that refuses everything gets disabled,
    // which is strictly worse than one with known gaps.
    it("allows an unrelated command", () => {
      expect(runHook("git status")).toBe(ALLOW);
    });

    it("allows a different subcommand of the same CLI", () => {
      expect(runHook("passwd-sso list")).toBe(ALLOW);
    });

    it("allows prose that merely contains the word", () => {
      expect(runHook("echo decrypting files")).toBe(ALLOW);
    });
  });

  describe("known evasions — pinned as limitations, not as coverage", () => {
    // These reach the same program and the hook does not see them, because it
    // matches the pre-execution string rather than the runtime argv. They are
    // asserted as ALLOW deliberately: the hook is documented as a lint against
    // accidents, and this is the evidence for that claim rather than a promise
    // it is safe. Closing them requires moving the decrypt off Bash entirely
    // (a dedicated tool or MCP surface that never returns plaintext).
    //
    // If one of these flips to BLOCK, do not simply update the expectation —
    // the hook's reach changed, and its header's scope statement needs revising.
    it("does not see a quoted subcommand", () => {
      expect(runHook(`passwd-sso '${SUB}' item`)).toBe(ALLOW);
    });

    it("does not see a subcommand split across quotes", () => {
      expect(runHook(`passwd-sso decr"ypt" item`)).toBe(ALLOW);
    });

    it("does not see a subcommand passed through a variable", () => {
      expect(runHook(`sub=${SUB}; passwd-sso "$sub" item`)).toBe(ALLOW);
    });
  });
});
