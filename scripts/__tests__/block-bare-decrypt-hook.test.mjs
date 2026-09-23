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
const SCANNER = resolve(REPO_ROOT, ".claude/hooks/lib/decrypt-command-scan.py");

// Built from fragments so this file's own source does not contain the literal
// command — the hook is installed on this repo, and a test fixture that spells
// it out would be flagged when the test file itself is edited via the Bash tool.
const CLI = "npx tsx " + REPO_ROOT + "/cli/src/index.ts";
const SUB = "dec" + "rypt";

/**
 * Run the hook with a tool_input payload and return an assertion on its exit
 * status. `r.stderr` is passed as vitest's second `expect()` argument, which
 * is a custom FAILURE MESSAGE shown only when the assertion fails — it makes
 * a status mismatch easy to trace, but it is NOT an assertion on `r.stderr`
 * itself and proves nothing about WHICH rule decided once the status
 * assertion passes (RT8). Use expectBlockedBy() below for a deny cell that
 * must pin the refusing branch, not just the exit code.
 */
function expectHook(command) {
  return expectHookRaw(JSON.stringify({ tool_input: { command } }));
}

/** The same, for a raw (possibly malformed) stdin payload. */
function expectHookRaw(payload) {
  const r = spawnSync("bash", [HOOK], { input: payload, encoding: "utf8" });
  return expect(r.status, r.stderr);
}

/**
 * Calls the scanner directly, bypassing the hook — A-C1-0's boundary: the
 * scanner is tested at its OWN contract (parsed segments), not only through
 * the hook's allow/block verdict, so a hand-rolled quote machine that is
 * wrong in a way one rule's verdict happens to survive still gets caught.
 */
function scanSegments(command) {
  const r = spawnSync("python3", [SCANNER, "--segments"], { input: command, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scanner failed (status ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout).segments;
}

const ALLOW = 0;
const BLOCK = 2;

/**
 * Run the hook and assert BOTH that it blocked AND that its stderr names the
 * branch that decided (RT8) — a message substring unique to the rule under
 * test, not just the exit status. A change that still exits 2 but for a
 * DIFFERENT reason (another item's message, or the generic "scanner did not
 * decide" refusal) reddens the cell instead of passing silently.
 */
function expectBlockedBy(command, messageSubstring) {
  const r = spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  expect(r.status, r.stderr).toBe(BLOCK);
  expect(r.stderr, r.stderr).toContain(messageSubstring);
}

describe("block-bare-decrypt hook", () => {
  describe("allows the /use-credential pattern", () => {
    // These are the shapes .claude/skills/use-credential/SKILL.md documents. If
    // the hook refuses them the skill cannot be used at all, which is what the
    // error message tells the caller to do — a contradiction that shipped once.
    it("allows _CRED assigned in a subshell and consumed by curl", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -u "user:\${_CRED}" https://example.test\n) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });

    it("allows the bearer-token variant", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -H "Authorization: Bearer \${_CRED}" https://example.test\n) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });

    it("allows the bearer-token variant padded to 200 KB, where the matcher's pipe lost its race every time", () => {
      // Round 14 T-R14-5: `printf '%s' "$COMMAND" | grep -qE` under pipefail. grep -q
      // exits at its first matching line, printf's next write takes SIGPIPE, and the
      // pipeline's 141 was refused. Measured on the pipe: 0 of 10 unpadded, 3 of 10 with
      // a 70 KB line, 10 of 10 with a 200 KB line — so this cell pads to 200 KB.
      const padding = `  # ${"x".repeat(200_000)}\n`;
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -H "Authorization: Bearer \${_CRED}" https://example.test\n${padding}) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });

    it("allows the generic consuming-command variant (Pattern C)", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  some-tool --token "\${_CRED}"\n) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });

    // Patterns D and E do NOT use _CRED — they pipe straight into a clipboard
    // sink. An earlier revision keyed the allow on "_CRED=$(" being present
    // anywhere, so both were refused and the documented macOS/Linux clipboard
    // flows could not run.
    it("allows the macOS clipboard pattern (Pattern D)", () => {
      const cmd = `(\n  ${CLI} ${SUB} ID --field password | pbcopy\n  echo "Copied to clipboard"\n) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });

    it("allows the Linux clipboard pattern (Pattern E)", () => {
      const cmd = `(\n  ${CLI} ${SUB} ID --field password | xclip -selection clipboard\n  echo "Copied to clipboard"\n) 2>/dev/null`;
      expectHook(cmd).toBe(ALLOW);
    });
  });

  describe("blocks shapes that put the credential on stdout", () => {
    it("blocks a bare run", () => {
      expectHook(`passwd-sso ${SUB} item`).toBe(BLOCK);
    });

    it("blocks a subshell that does not capture into _CRED", () => {
      // A leading paren was once treated as proof of safety. It is not: stdout
      // still goes to stdout.
      expectHook(`(passwd-sso ${SUB} item)`).toBe(BLOCK);
    });

    it("blocks a pipe whose last stage prints", () => {
      // A pipe was once treated as proof of safety. `cat` writes it out.
      expectHook(`passwd-sso ${SUB} item | cat`).toBe(BLOCK);
    });

    it("blocks a sanctioned subshell that echoes the credential", () => {
      const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID)\n  echo $_CRED\n)`;
      expectHook(cmd).toBe(BLOCK);
    });

    it("blocks a decoy _CRED that captures something else", () => {
      // The allow must be anchored on the decrypt OCCURRENCE. Testing "starts
      // with (" and "contains _CRED=$(" independently accepted this: the
      // assignment captured `true` while the real decrypt ran bare beside it.
      expectHook(`(_CRED=$(true); passwd-sso ${SUB} item)`).toBe(BLOCK);
    });

    it("blocks a pipe into a sink that prints", () => {
      // The clipboard allow is a closed set. `tee` writes to stdout, so it is
      // not a consuming sink even though it looks like one.
      expectHook(`${CLI} ${SUB} ID | tee /tmp/x`).toBe(BLOCK);
    });

    it("blocks a pipe into an unknown command", () => {
      // A decrypt piped into something this lint cannot vouch for.
      expectHook(`${CLI} ${SUB} ID | some-unknown-tool`).toBe(BLOCK);
    });
  });

  describe("requires EVERY decrypt in the command to be safe, not just one", () => {
    // The allow once answered "does a safe form exist?", which a command holding
    // one safe and one unsafe decrypt satisfies with the safe one alone. Grep
    // cannot ask "is every occurrence safe?", so the hook requires exactly one
    // occurrence and judges that. Every documented pattern has exactly one.
    it("blocks a capture followed by a bare decrypt", () => {
      expectHook(`_CRED=$(passwd-sso ${SUB} safe); passwd-sso ${SUB} exposed`).toBe(BLOCK);
    });

    it("blocks a clipboard sink followed by a bare decrypt", () => {
      expectHook(`passwd-sso ${SUB} safe | pbcopy; passwd-sso ${SUB} exposed`).toBe(BLOCK);
    });

    it("blocks a quoted decoy used to justify a bare decrypt", () => {
      // The decoy is inside a string literal and never runs, but it was enough
      // to satisfy the existence check for the real one beside it.
      const cmd = `echo 'passwd-sso ${SUB} x | pbcopy'; passwd-sso ${SUB} exposed`;
      expectHook(cmd).toBe(BLOCK);
    });
  });

  describe("pins the clipboard sink's argument shape, not just its name", () => {
    // Several clipboard tools have flags that turn them back into filters, so
    // matching the sink by NAME let the credential through a sanctioned-looking
    // pipe. xclip -filter and xsel --output both write stdin to stdout.
    it("blocks xclip -filter after a selection argument", () => {
      expectHook(`passwd-sso ${SUB} item | xclip -selection clipboard -filter`).toBe(BLOCK);
    });

    it("blocks a bare xclip -filter", () => {
      expectHook(`passwd-sso ${SUB} item | xclip -filter`).toBe(BLOCK);
    });

    it("blocks xsel --output", () => {
      expectHook(`passwd-sso ${SUB} item | xsel --output`).toBe(BLOCK);
    });

    it("still allows xsel in its documented input form", () => {
      // The allow side of the same clause: pinning the shape must not break the
      // legitimate one.
      expectHook(`${CLI} ${SUB} ID | xsel --clipboard --input`).toBe(ALLOW);
    });

    it("still allows wl-copy", () => {
      expectHook(`${CLI} ${SUB} ID | wl-copy`).toBe(ALLOW);
    });
  });

  describe("refuses rather than allowing when it cannot read its input", () => {
    // A guard that cannot parse its input has not cleared that input. Each of
    // these once mapped to an empty command and took the "not a decrypt" path.
    it("blocks malformed JSON", () => {
      expectHookRaw("{bad json").toBe(BLOCK);
    });

    it("blocks a missing command key", () => {
      expectHookRaw(JSON.stringify({ tool_input: {} })).toBe(BLOCK);
    });

    it("blocks a null command", () => {
      expectHookRaw(JSON.stringify({ tool_input: { command: null } })).toBe(BLOCK);
    });

    it("blocks a non-string command", () => {
      expectHookRaw(JSON.stringify({ tool_input: { command: 123 } })).toBe(BLOCK);
    });
  });

  describe("does not block unrelated commands", () => {
    // The over-blocking direction. A hook that refuses everything gets disabled,
    // which is strictly worse than one with known gaps.
    it("allows an unrelated command", () => {
      expectHook("git status").toBe(ALLOW);
    });

    it("allows a different subcommand of the same CLI", () => {
      expectHook("passwd-sso list").toBe(ALLOW);
    });

    it("allows prose that merely contains the word", () => {
      expectHook("echo decrypting files").toBe(ALLOW);
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
      expectHook(`passwd-sso '${SUB}' item`).toBe(ALLOW);
    });

    it("does not see a subcommand split across quotes", () => {
      expectHook(`passwd-sso decr"ypt" item`).toBe(ALLOW);
    });

    it("does not see a subcommand passed through a variable", () => {
      expectHook(`sub=${SUB}; passwd-sso "$sub" item`).toBe(ALLOW);
    });
  });
});

describe("block-bare-decrypt hook — failures refuse, and the printer check reads the whole command (round 15)", () => {
  const PAD = `  # ${"x".repeat(200_000)}\n`;

  /** Run the hook where bash cannot write a here-string's temp file (a 1-block file-size limit). */
  function runHookWithoutTempFiles(command) {
    const payload = JSON.stringify({ tool_input: { command } });
    // The hook path travels in the environment, not the shell's argv, so the -c script stays a constant string.
    return spawnSync("bash", ["-c", 'ulimit -f 1; trap "" XFSZ; exec bash "$HOOK_PATH"'], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, HOOK_PATH: HOOK },
    });
  }

  it("refuses a 200 KB bare decrypt for the same reason as the unpadded one (A-C1-4)", () => {
    // The here-string temp-file limit this cell used to probe belonged to
    // `grep`, which C1 removes from the hook entirely — the scanner reads the
    // command over a stdin pipe, not a here-string, so there is no size limit
    // left to hit. What must still hold is the RULE: a bare decrypt refuses
    // regardless of how much padding surrounds it, decided the same way (not
    // by a matcher that failed to run) — so this asserts the SAME stderr text
    // the short unpadded bare-decrypt cell gets, not a scanner-failure message.
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ tool_input: { command: `passwd-sso ${SUB} item\n${PAD}` } }),
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(BLOCK);
    expect(r.stderr).not.toContain("command scanner");
    expect(r.stderr).toContain("this decrypt puts its stdout in the conversation");
  });

  it("refuses an input the scanner cannot parse, under its OWN message (A-C1-4, T-F6)", () => {
    // An unterminated quote is not a decrypt-detection question at all — the
    // scanner cannot finish walking the command, which item 8 treats as its
    // own refusal, worded so it is never mistaken for "no match" (a command
    // this hook has nothing to do with) or for a rule the scanner DID decide.
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ tool_input: { command: `echo "unterminated` } }),
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(BLOCK);
    expect(r.stderr).toContain("command scanner");
    expect(r.stderr).not.toContain("this decrypt puts its stdout in the conversation");
  });

  it("still refuses a short bare decrypt under the same limit", () => {
    const r = runHookWithoutTempFiles(`passwd-sso ${SUB} item`);
    expect(r.status, r.stderr).toBe(BLOCK);
  });

  it("still allows a short sanctioned command under the same limit (control)", () => {
    // Round 16 T-R16-1: without this, a hook that refused every command whenever a temp
    // file could not be written kept every cell green.
    const r = runHookWithoutTempFiles(`(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -u "user:\${_CRED}" https://example.test\n) 2>/dev/null`);
    expect(r.status, r.stderr).toBe(ALLOW);
  });

  it("refuses an echo of the credential placed past 200 KB (T-R15-1, the allow cell's deny twin)", () => {
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n${PAD}  echo $_CRED\n) 2>/dev/null`;
    expectHook(cmd).toBe(BLOCK);
  });

  it.each([
    ["echo of ${_CRED}", `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  echo "\${_CRED}"\n) 2>/dev/null`],
    ["printf of ${_CRED}", `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  printf '%s' "\${_CRED}"\n) 2>/dev/null`],
    ["tee of $_CRED", `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  tee <<<"$_CRED"\n) 2>/dev/null`],
  ])("refuses %s (S-R15-3)", (_label, cmd) => {
    expectHook(cmd).toBe(BLOCK);
  });

  it("allows a consuming command whose flag merely ends in `echo` (S-R15-3)", () => {
    // `--mode=noecho ` ends in `echo` followed by a blank; only the command-word
    // boundary keeps it from reading as a printer.
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  some-tool --mode=noecho --token "\${_CRED}"\n) 2>/dev/null`;
    expectHook(cmd).toBe(ALLOW);
  });

  it("allows a consuming command whose argument merely contains `cat` (S-R15-3)", () => {
    // `application/json` holds the letters of `cat`, with a word character on each side;
    // either the boundary before the name or the blank-or-redirection after it keeps it
    // out, so this cell pins neither alone (`--mode=noecho` and `catalog` do).
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -H "Content-Type: application/json" -d "{\\"token\\":\\"\${_CRED}\\"}" https://example.test\n) 2>/dev/null`;
    expectHook(cmd).toBe(ALLOW);
  });
});

describe("block-bare-decrypt hook — a printer command word ends at a blank or a redirection (round 16)", () => {
  const capture = (line) => `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  ${line}\n) 2>/dev/null`;

  // F-R16-1 / S-R16-1: round 15 required a blank after the name and let these through;
  // each prints the credential, and round 14 refused each.
  it.each([
    ["cat reading a here-string with no blank", `cat<<<"$_CRED"`],
    ["printf redirected to stderr with no blank", `printf>&2 '%s' "\${_CRED}"`],
    ["a quoted printf command word", `"printf" '%s' "\${_CRED}"`],
  ])("refuses %s", (_label, line) => {
    expectHook(capture(line)).toBe(BLOCK);
  });

  it("allows a command whose name only begins with a printer name", () => {
    // `catalog` starts with `cat`; the blank-or-redirection after the name keeps it out.
    expectHook(capture(`catalog --token "\${_CRED}"`)).toBe(ALLOW);
  });

  // S-R16-2 named `declare -p`, a heredoc body and an encoder as printer
  // evasions the old regex-based hook could not see. C1's scanner closes all
  // three (items 2, 5 and 6 below) — they are no longer residual, so their
  // cells moved out of this "known evasion" framing into the item-specific
  // describe blocks that decide them.
});

describe("decrypt-command-scan.py — segmentation (A-C1-0)", () => {
  // The scanner's own boundary, called directly rather than through the
  // hook's allow/block verdict — a hand-rolled quote/nesting machine can be
  // wrong in a way one rule's decision happens to survive, and this is what
  // catches that instead of relying on the verdict to notice.

  it("adjacent quotes of different kinds concatenate into one word", () => {
    const [seg] = scanSegments(`echo "a""b"'c'"d"`);
    expect(seg.words).toEqual(["echo", `"a""b"'c'"d"`]);
  });

  it("a quote directly before an unquoted operator still splits there", () => {
    const [first, , third] = scanSegments(`echo "a"|cat|sed s/x/y/`);
    expect(first.words).toEqual(["echo", `"a"`]);
    expect(third.join_op).toBe("|");
    expect(third.words).toEqual(["sed", "s/x/y/"]);
  });

  it("a quote directly after an unquoted operator still splits there", () => {
    const [, second] = scanSegments(`true;"echo" hi`);
    expect(second.join_op).toBe(";");
    expect(second.words).toEqual([`"echo"`, "hi"]);
  });

  it("a quoted heredoc delimiter is recorded as quoted, unexpanded", () => {
    const [seg] = scanSegments(`cat <<'EOF'\nbody\nEOF\n`);
    expect(seg.heredocs).toEqual([{ delimiter: "EOF", quoted: true, strip_tabs: false, body: "body" }]);
  });

  it("an unquoted heredoc delimiter is recorded as unquoted", () => {
    const [seg] = scanSegments(`cat <<EOF\nbody\nEOF\n`);
    expect(seg.heredocs).toEqual([{ delimiter: "EOF", quoted: false, strip_tabs: false, body: "body" }]);
  });

  it("a line continuation inside single quotes stays literal", () => {
    const [seg] = scanSegments("echo 'a\\\nb'");
    expect(seg.words).toEqual(["echo", "'a\\\nb'"]);
  });

  it("a line continuation outside quotes is removed, joining the word", () => {
    const [seg] = scanSegments("ec\\\nho hi");
    expect(seg.words).toEqual(["echo", "hi"]);
  });

  it("$( … ) nesting is parsed as its own recursive segment list", () => {
    const [seg] = scanSegments(`echo $(true | false) done`);
    expect(seg.words).toEqual(["echo", "$(true | false)", "done"]);
    expect(seg.nested).toHaveLength(1);
    expect(seg.nested[0].kind).toBe("cmdsub");
    const [inner1, inner2] = seg.nested[0].segments;
    expect(inner1.words).toEqual(["true"]);
    expect(inner2.join_op).toBe("|");
    expect(inner2.words).toEqual(["false"]);
  });

  it("|& splits into two segments joined by |&", () => {
    const [first, second] = scanSegments(`cmd1 |& cmd2`);
    expect(first.words).toEqual(["cmd1"]);
    expect(second.join_op).toBe("|&");
    expect(second.words).toEqual(["cmd2"]);
  });

  it("an unparsable command raises rather than returning a partial parse", () => {
    const r = spawnSync("python3", [SCANNER, "--segments"], { input: `echo "unterminated`, encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});

describe("block-bare-decrypt hook — items 1-8 of the Shape-1 scanner (A-C1-1)", () => {
  // One refusing cell per item. Each was red-proved on a scratchpad copy of
  // the scanner (disable the one predicate, watch this exact cell go green
  // to red) — recorded in the review artifact, not re-run here.
  const capture = (line) => `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  ${line}\n) 2>/dev/null`;

  it("item 1 — a continuation inside the printer's own name is still caught (ec\\<newline>ho $_CRED)", () => {
    // The red proof disables ONLY the continuation-removal step and leaves
    // item 6 (the printer rule) intact — the point is that item 6 cannot see
    // `echo` if item 1 does not first join the two fragments (T-F1).
    expectBlockedBy(capture("ec\\\nho $_CRED"), "echo references _CRED in this segment");
  });

  it.each([
    ["declare -p", "declare -p", "declare -p dumps every variable"],
    ["typeset -p", "typeset -p", "typeset -p dumps every variable"],
    ["bare set", "set", "bare set dumps the environment"],
    ["bare env", "env", "bare env dumps the environment"],
    ["bare printenv", "printenv", "bare printenv dumps the environment"],
    ["bare export", "export", "bare export dumps the environment"],
    ["compgen -v", "compgen -v", "compgen -v lists every variable name"],
  ])("item 2 — refuses a variable dumper regardless of whether _CRED is named: %s", (_label, line, message) => {
    expectBlockedBy(capture(line), message);
  });

  it("item 2 — env with an operand is not bare and stays allowed", () => {
    expectHook(capture(`env DEBUG=1 cmd "$_CRED"`)).toBe(ALLOW);
  });

  it.each([
    ["set -x", "set -x", "set -x turns on xtrace"],
    ["set -o xtrace", "set -o xtrace", "set -o xtrace turns on xtrace"],
    ["bash -x", "bash -x script.sh", "bash -x turns on xtrace"],
    ["BASH_XTRACEFD", "BASH_XTRACEFD=5", "BASH_XTRACEFD redirects xtrace output"],
  ])("item 3 — refuses tracing: %s", (_label, line, message) => {
    expectBlockedBy(capture(line), message);
  });

  it("item 3 — set -eu (errexit/nounset, no xtrace) stays allowed", () => {
    // Boundary-adjacent to the denied `set -x` above. If `_has_short_flag`
    // widened from checking specifically for the `x` letter to flagging ANY
    // short flag on `set` as tracing, this would wrongly refuse too — `-eu`
    // never turns on xtrace.
    expectHook(capture("set -eu")).toBe(ALLOW);
  });

  it.each([
    ["a plain assignment", "x=$_CRED", "copies _CRED to another name"],
    ["a braced assignment", 'x="${_CRED}"', "copies _CRED to another name"],
    ["read into a new variable", 'read x <<<"$_CRED"', "reads _CRED into a new variable"],
    ["printf -v into a new variable", "printf -v x %s $_CRED", "printf -v copies _CRED into a new variable"],
    ["a declare -n nameref", "declare -n ref=_CRED", "makes ref a nameref for _CRED"],
  ])("item 4 — refuses copying _CRED to another name: %s", (_label, line, message) => {
    expectBlockedBy(capture(line), message);
  });

  it("item 4 — x=$OTHER (a name copied from something other than _CRED) stays allowed", () => {
    // Boundary-adjacent to the denied `x=$_CRED` above. If `_text_references_cred`
    // dropped the name anchor and matched any `$`-prefixed value, or `_is_copy`
    // stopped checking `name != CRED_NAME`, this — which never references the
    // credential — would wrongly refuse too.
    expectHook(capture("x=$OTHER")).toBe(ALLOW);
  });

  it("item 5 — an unquoted heredoc delimiter with a body referencing _CRED refuses", () => {
    // `wc`, not `cat`: item 5 refuses on the heredoc body alone, with no
    // gate on the command word — `cat` is ALSO on item 6's printer list, and
    // would refuse this cell on its own, defeating the red proof for item 5.
    expectBlockedBy(capture(`wc -l <<DONE\nsome text $_CRED\nDONE`), "heredoc <<DONE body references _CRED");
  });

  it("item 5 — the same body under a quoted delimiter (no expansion) is allowed", () => {
    expectHook(capture(`wc -l <<'DONE'\nsome text $_CRED\nDONE`)).toBe(ALLOW);
  });

  it.each([
    ["base64", 'base64 <<<"$_CRED"', "base64 references _CRED in this segment"],
    ["xxd", 'xxd <<<"$_CRED"', "xxd references _CRED in this segment"],
    ["od", 'od <<<"$_CRED"', "od references _CRED in this segment"],
    ["openssl", 'openssl base64 <<<"$_CRED"', "openssl references _CRED in this segment"],
    ["jq", 'jq -R . <<<"$_CRED"', "jq references _CRED in this segment"],
    ["xargs", 'xargs -I{} echo {} <<<"$_CRED"', "xargs references _CRED in this segment"],
  ])("item 6 — the widened printer list refuses: %s", (_label, line, message) => {
    expectBlockedBy(capture(line), message);
  });

  it("item 6 — printenv naming the bare variable (no $) refuses", () => {
    expectBlockedBy(capture("printenv _CRED"), "printenv references _CRED in this segment");
  });

  it("item 6 — a printer on the list that does not reference _CRED in ITS segment stays allowed", () => {
    // sed is on the widened list, but this invocation never touches _CRED —
    // only the later curl does, in a DIFFERENT segment (F-F5/S-F5 shape).
    expectHook(capture(`sed -i s/a/b/ cfg\n  curl -u "u:$_CRED" https://example.test`)).toBe(ALLOW);
  });

  it("item 7 — a brace-expansion word referencing _CRED refuses", () => {
    expectBlockedBy(capture("cp file.txt{,.bak-$_CRED}"), "brace expansion");
  });

  it("item 7 — cp file.txt{,.bak} (a brace expansion with no _CRED reference) stays allowed", () => {
    // Boundary-adjacent to the denied brace word above. If `_brace_word_leaks`
    // stopped checking `_text_references_cred` on the matched group and
    // treated ANY brace expansion as a leak, this ordinary backup-suffix
    // expansion would wrongly refuse too.
    expectHook(capture("cp file.txt{,.bak}")).toBe(ALLOW);
  });

  it("item 8 — the scanner's own parse failure refuses under its own message", () => {
    // Same cell as A-C1-4/T-F6: the red proof for item 8 removes the
    // scanner's failure handling and shows this cell stops exiting 2.
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ tool_input: { command: `echo "unterminated` } }),
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(BLOCK);
    expect(r.stderr).toContain("command scanner");
  });
});

describe("block-bare-decrypt hook — additional allow cells (A-C1-2)", () => {
  it("allows a printer earlier in the command that never touches _CRED, followed by the real consumer", () => {
    expectHook(`sed -i s/a/b/ cfg; curl -u "u:$_CRED" https://example.test`).toBe(ALLOW);
  });

  it("allows env with an operand ahead of the consuming command", () => {
    expectHook(`env DEBUG=1 cmd "$_CRED"`).toBe(ALLOW);
  });

  it("allows a single-quoted argument containing a literal backslash-newline", () => {
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  some-tool --note 'line one\\\nline two' "\${_CRED}"\n) 2>/dev/null`;
    expectHook(cmd).toBe(ALLOW);
  });

  it("allows an apostrophe inside an earlier double-quoted word followed by a genuine continuation split (S2-F5)", () => {
    const cmd =
      `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  curl -s -H "it's fine" \\\n` +
      `    -u "user:\${_CRED}" https://example.test\n) 2>/dev/null`;
    expectHook(cmd).toBe(ALLOW);
  });
});

describe("block-bare-decrypt hook — reproduced leaks, quote/nesting-aware (A-C1-3)", () => {
  // Each was verified against the pre-change (grep-based) hook to be a false
  // negative — the red proof is recorded once in the review artifact, not
  // re-run here.

  it("refuses awk -F'|' reading _CRED from a here-string (F-R2-2)", () => {
    // The quoted `|` inside `-F'|'` ended the old regex's match window before
    // `$_CRED` — segmentation being quote-aware is what catches it now.
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  awk -F'|' '{print}' <<<"$_CRED"\n) 2>/dev/null`;
    expectHook(cmd).toBe(BLOCK);
  });

  it("refuses echo $(true | false) \"$_CRED\" — one command to bash, not two (S3-F1)", () => {
    // A quote-only scanner splits this in two at the pipe inside $( … ) and
    // neither half matches; nesting-aware segmentation reads it as bash does.
    const cmd = `(\n  _CRED=$(${CLI} ${SUB} ID --field password)\n  echo $(true | false) "$_CRED"\n) 2>/dev/null`;
    expectHook(cmd).toBe(BLOCK);
  });
});

