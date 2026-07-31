#!/usr/bin/env node
/**
 * C6 CI guard (AST, ts-morph): the CLI shell-emission/launch class, plus a
 * name-based tripwire for the tenant-access single-adjudicator boundary.
 *
 * ## The class (Rules A/B, over cli/src)
 *
 * F1 (`cmd /c start "" <url>` re-parsing an OAuth URL) and F4 (`eval $(...)`
 * output interpolating an unquoted socket path) share one root cause: the CLI
 * hands non-literal data to something a shell re-parses — either by
 * LAUNCHING a shell (Rule A) or by EMITTING text a shell reads later, whether
 * `eval`-ed or pasted (Rule B). Both were fixed once by hand (C1, C3), and
 * C3's own contract (I3.1) predicts the next miss: the member set "was never
 * derived from the primitive, it was read off files, so the next missed
 * member is likely still unwritten." This gate is that derivation, re-run on
 * every PR instead of once at review time.
 *
 * **Rule A (launch).** A `spawn`/`exec`/`execSync`/`execFile*` call is a
 * *shell launch* when its command argument is a literal shell-interpreter
 * name (`cmd`, `cmd.exe`, `sh`, `bash`, `powershell`, `pwsh`), or its options
 * object sets `shell: true` / a shell path, or the function itself always
 * shells out (`exec`/`execSync` invoke `/bin/sh` or `cmd.exe`
 * unconditionally — the `shell` option only picks which shell, not whether
 * one runs). A shell launch is a violation only once a non-literal value —
 * an interpolation, an identifier, a property read — reaches one of its
 * arguments: a launch built entirely from string literals has no seam for a
 * shell metacharacter to hide in, which is what keeps
 * `clipboard.ts:68,70`'s `execSync("pbcopy < /dev/null", ...)` green.
 *
 * **Rule B (emission).** A template literal is scanned when its STATIC
 * (quasi) text alone already looks like shell syntax — a bare
 * `NAME=` assignment, an `export NAME=` line, or a `trap` command, using the
 * ALL-CAPS shell-variable convention this repo's real emission sites use —
 * and is a violation if any of its interpolations is not a call to
 * `shellQuote`. Deliberately not anchored on `console.log`: I3.4 moved two
 * emission sites into pure functions that RETURN their lines instead of
 * printing them, so a `console.log`-anchored pattern would stop matching
 * exactly the sites C3 moved — green because the code became invisible to
 * the gate, not because it became safe. Numeric interpolations get no free
 * pass either (`child.pid` is quoted like anything else); the only discharge
 * is the call. Reading the shape off the STATIC text (not "any template
 * literal with an unwrapped interpolation") is what keeps
 * `env.ts`'s `` `${k}=${shellQuote(v)}` `` green: the emitted var NAME there
 * is itself an interpolation (validated upstream by `assertValidEnvName`, a
 * different and legitimate discharge, not a `shellQuote` call), so the
 * literal never spells `NAME=` in the source text the gate reads — there is
 * no static shell form for the rule to match in the first place.
 *
 * ## Rule C — a tripwire, not a boundary (over `src`, a different root)
 *
 * F2/C5 collapsed two adjudicators (CGNAT-only vs. CGNAT+WhoIs) that decided
 * the same predicate with different semantics into one. That collapse is a
 * structural property no name-matching gate can verify — an independently
 * written WhoIs-and-compare that never calls `verifyTailscalePeer` or
 * mentions its constants would pass this rule and BE the regression (the
 * literal R48 shape: it is how the original split arose). What this rule
 * catches is the cheap, recurring shape instead: a second call site, an
 * import alias, a re-typed literal. It raises the bar from "review every PR
 * by hand" to "a regression that copies the real primitive is noisy"; it
 * does not close the class C5's structural collapse closes, and must not be
 * cited as if it did. Three checks, matched as plain text over non-test
 * files — an AST identifier-vs-property-key distinction would not change
 * what a rewritten adjudicator could evade, so the extra machinery buys
 * nothing here:
 *
 *   - `verifyTailscalePeer` referenced from at most one file outside its own
 *     defining module (`services/tailscale-client.ts`).
 *   - the literal `64:ff9b` appears only in the NAT64 classifier
 *     (`lib/http/external-http.ts`) — R48: NAT64 knowledge must not spread
 *     to a second classifier.
 *   - `/localapi/v0/whois` appears only in the WhoIs client
 *     (`services/tailscale-client.ts`) — the one string a reimplementation
 *     cannot avoid, raising the bar from "must not call the function" to
 *     "must not talk to the API".
 *
 * ## Escape hatch
 *
 * None. Rules A and B admit no exemption marker: the fix is always to quote
 * (`shellQuote`) or to stop shelling out, never to annotate around the
 * check. Rule C's honest limits are documented above rather than worked
 * around; widening it to close them is future work, not this gate's job.
 *
 * Env: `CLI_SHELL_SAFETY_ROOT` overrides the Rule A/B scan root (default
 * `cli/src`); `SRC_ADJUDICATOR_ROOT` overrides Rule C's (default `src`) —
 * two independent variables, because one root cannot present two
 * differently-shaped fixture trees to the self-test (I6.3).
 *
 * Fail-closed: a file this gate cannot read or parse is an ERROR (exit 1),
 * not a skipped file.
 *
 * Exit 0 = OK, 1 = a violation was found or a file could not be processed.
 */
import { Node, SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, walkSourceFiles } from "./lib/ast-project.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_SHELL_SAFETY_ROOT = process.env.CLI_SHELL_SAFETY_ROOT ?? join(REPO_ROOT, "cli/src");
const SRC_ADJUDICATOR_ROOT = process.env.SRC_ADJUDICATOR_ROOT ?? join(REPO_ROOT, "src");

const CLI_ROOT_LABEL = "cli/src";
const SRC_ROOT_LABEL = "src";

/** Thrown for a file this gate cannot read or parse — fail-closed, not a skip. */
class GateIOError extends Error {}

// ─── Rule A: shell launch with a non-literal argument ──────────────────────

const LAUNCH_FNS = new Set(["spawn", "exec", "execSync", "execFile", "execFileSync"]);
/** Node.js always runs these through a shell — the `shell` option only
 * chooses which one, it cannot turn shell mode off. */
const ALWAYS_SHELL_FNS = new Set(["exec", "execSync"]);
const SHELL_INTERPRETER_NAMES = new Set(["cmd", "cmd.exe", "sh", "bash", "powershell", "pwsh"]);

function calleeName(call) {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return null;
}

function stringLiteralText(node) {
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralText();
  }
  return null;
}

/** True for a node that can only ever hold a fixed, author-controlled value. */
function isLiteralArgTree(node) {
  if (Node.isParenthesizedExpression(node)) return isLiteralArgTree(node.getExpression());
  const kind = node.getKind();
  if (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.NumericLiteral ||
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (Node.isArrayLiteralExpression(node)) return node.getElements().every(isLiteralArgTree);
  return false;
}

/** The first non-literal sub-expression under `node`, or null. Drills into
 * array elements so the reported offender is the actual dynamic value
 * (`url`), not the whole `["/c","start","",url]` array. */
function firstNonLiteral(node) {
  if (Node.isParenthesizedExpression(node)) return firstNonLiteral(node.getExpression());
  if (isLiteralArgTree(node)) return null;
  if (Node.isArrayLiteralExpression(node)) {
    for (const el of node.getElements()) {
      const found = firstNonLiteral(el);
      if (found) return found;
    }
  }
  return node;
}

/** `{ shell: true }` or `{ shell: "/bin/sh" }` — any string counts, since
 * naming a shell still runs one. */
function optionsSetShell(obj) {
  const prop = obj.getProperty?.("shell");
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return false;
  const init = prop.getInitializer();
  if (!init) return false;
  if (init.getKind() === SyntaxKind.TrueKeyword) return true;
  return stringLiteralText(init) !== null;
}

function checkRuleA(call) {
  const name = calleeName(call);
  if (!name || !LAUNCH_FNS.has(name)) return null;

  let args = call.getArguments();
  if (args.length === 0) return null;

  let optionsNode = null;
  const last = args[args.length - 1];
  if (last && Node.isObjectLiteralExpression(last)) {
    optionsNode = last;
    args = args.slice(0, -1);
  }
  const trailing = args[args.length - 1];
  if (trailing && (Node.isArrowFunction(trailing) || Node.isFunctionExpression(trailing))) {
    args = args.slice(0, -1);
  }
  if (args.length === 0) return null;

  const commandArg = args[0];
  const commandText = stringLiteralText(commandArg);
  const commandIsShellName = commandText != null && SHELL_INTERPRETER_NAMES.has(commandText.toLowerCase());
  const isShellLaunch =
    ALWAYS_SHELL_FNS.has(name) || commandIsShellName || (optionsNode && optionsSetShell(optionsNode));
  if (!isShellLaunch) return null;

  let offender = null;
  for (const a of args) {
    offender = firstNonLiteral(a);
    if (offender) break;
  }
  if (!offender) return null;

  return {
    line: call.getStartLineNumber(),
    reason: `Rule A: ${name}(...) launches a shell interpreter with a non-literal argument \`${offender.getText()}\``,
  };
}

// ─── Rule B: shell-syntax emission with an unquoted interpolation ──────────

const SHELL_QUOTE_FN = "shellQuote";
// Static (quasi) text only — an ALL-CAPS run immediately before "=" (a POSIX
// shell variable, matching this repo's SSH_AUTH_SOCK / PSSO_AGENT_SOCK
// convention), "export NAME", or "trap". Deliberately does not match a bare
// lowerCamelCase "key=" (e.g. audit-verify.ts's `expected=${expected}`
// diagnostic text) or an interpolated variable NAME (env.ts's
// `${k}=${shellQuote(v)}`, where the NAME never appears as static text).
const SHELL_ASSIGNMENT_RE = /\b[A-Z_][A-Z0-9_]*=/;
const SHELL_EXPORT_RE = /\bexport\s+[A-Z_][A-Z0-9_]*\b/;
const SHELL_TRAP_RE = /\btrap\b/;

function isShellForm(quasiText) {
  return SHELL_ASSIGNMENT_RE.test(quasiText) || SHELL_EXPORT_RE.test(quasiText) || SHELL_TRAP_RE.test(quasiText);
}

function isShellQuoteCall(expr) {
  if (Node.isParenthesizedExpression(expr)) return isShellQuoteCall(expr.getExpression());
  // `cond ? shellQuote(a) : shellQuote(b)` — both arms must discharge.
  if (Node.isConditionalExpression(expr)) {
    return isShellQuoteCall(expr.getWhenTrue()) && isShellQuoteCall(expr.getWhenFalse());
  }
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === SHELL_QUOTE_FN) return true;
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === SHELL_QUOTE_FN) return true;
  }
  return false;
}

/** The literal (quasi) parts of a template expression, concatenated —
 * excludes the interpolated expressions themselves, so a keyword appearing
 * only inside an interpolation's own text does not count as "static". */
function templateQuasiText(template) {
  const parts = [template.getHead().getLiteralText()];
  for (const span of template.getTemplateSpans()) parts.push(span.getLiteral().getLiteralText());
  return parts.join("");
}

function checkRuleB(sourceFile) {
  const findings = [];
  for (const template of sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    if (!isShellForm(templateQuasiText(template))) continue;
    for (const span of template.getTemplateSpans()) {
      const expr = span.getExpression();
      if (isShellQuoteCall(expr)) continue;
      findings.push({
        line: expr.getStartLineNumber(),
        reason: `Rule B: shell-syntax template literal interpolates \`${expr.getText()}\` without shellQuote()`,
      });
    }
  }
  return findings;
}

// ─── Rules A/B driver ───────────────────────────────────────────────────────

function scanRuleAB() {
  const project = createAstProject();
  const findings = [];
  for (const file of walkSourceFiles(CLI_SHELL_SAFETY_ROOT)) {
    const relToRoot = relative(CLI_SHELL_SAFETY_ROOT, file).split("\\").join("/");
    const label = `${CLI_ROOT_LABEL}/${relToRoot}`;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new GateIOError(`failed to read ${label}: ${err.message}`);
    }
    let sf;
    try {
      sf = project.createSourceFile(label, text, { overwrite: true });
    } catch (err) {
      throw new GateIOError(`failed to parse ${label}: ${err.message}`);
    }
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const hit = checkRuleA(call);
      if (hit) findings.push({ file: label, line: hit.line, reason: hit.reason });
    }
    for (const hit of checkRuleB(sf)) {
      findings.push({ file: label, line: hit.line, reason: hit.reason });
    }
  }
  return findings;
}

// ─── Rule C: single-adjudicator tripwire ───────────────────────────────────

// Paths are relative to SRC_ADJUDICATOR_ROOT.
const TAILSCALE_CLIENT_REL = "lib/services/tailscale-client.ts";
const EXTERNAL_HTTP_REL = "lib/http/external-http.ts";

const RULE_C_CHECKS = [
  {
    pattern: /\bverifyTailscalePeer\b/,
    definer: TAILSCALE_CLIENT_REL,
    maxExternalFiles: 1,
    reason: (label) =>
      `Rule C: verifyTailscalePeer referenced from ${label}, a second site outside ${TAILSCALE_CLIENT_REL} — the single adjudicator C5 established may have grown a second caller`,
  },
  {
    pattern: /64:ff9b/,
    definer: EXTERNAL_HTTP_REL,
    maxExternalFiles: 0,
    reason: (label) =>
      `Rule C: the literal 64:ff9b appears in ${label}, outside the NAT64 classifier (${EXTERNAL_HTTP_REL}) — NAT64 knowledge must not spread to a second classifier`,
  },
  {
    pattern: /\/localapi\/v0\/whois/,
    definer: TAILSCALE_CLIENT_REL,
    maxExternalFiles: 0,
    reason: (label) =>
      `Rule C: /localapi/v0/whois appears in ${label}, outside the WhoIs client (${TAILSCALE_CLIENT_REL}) — a second caller may be a reimplementation that never calls verifyTailscalePeer`,
  },
];

function scanRuleC() {
  const findings = [];
  const hitsByCheck = RULE_C_CHECKS.map(() => []);

  for (const file of walkSourceFiles(SRC_ADJUDICATOR_ROOT)) {
    const relToRoot = relative(SRC_ADJUDICATOR_ROOT, file).split("\\").join("/");
    const label = `${SRC_ROOT_LABEL}/${relToRoot}`;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new GateIOError(`failed to read ${label}: ${err.message}`);
    }
    const lines = text.split("\n");

    RULE_C_CHECKS.forEach((check, i) => {
      if (relToRoot === check.definer) return; // the defining module is exempt by definition
      const matchLines = [];
      lines.forEach((lineText, idx) => {
        if (check.pattern.test(lineText)) matchLines.push(idx + 1);
      });
      if (matchLines.length > 0) hitsByCheck[i].push({ label, matchLines });
    });
  }

  RULE_C_CHECKS.forEach((check, i) => {
    const hits = hitsByCheck[i];
    if (hits.length <= check.maxExternalFiles) return;
    for (const hit of hits) {
      for (const line of hit.matchLines) {
        findings.push({ file: hit.label, line, reason: check.reason(hit.label) });
      }
    }
  });

  return findings;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(
    `check-cli-shell-safety: CLI_SHELL_SAFETY_ROOT=${CLI_SHELL_SAFETY_ROOT} SRC_ADJUDICATOR_ROOT=${SRC_ADJUDICATOR_ROOT}`,
  );

  let findings;
  try {
    findings = [...scanRuleAB(), ...scanRuleC()];
  } catch (err) {
    if (err instanceof GateIOError) {
      console.error(`check-cli-shell-safety: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (findings.length > 0) {
    console.error("CLI shell-safety violations:\n");
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.reason}`);
    }
    console.error(
      "\nQuote a shell-launch argument via a literal argv element (never a shell interpreter " +
        "fed non-literal data), or wrap a shell-syntax interpolation in shellQuote() " +
        "(cli/src/lib/shell-quote.ts). Rule C findings mean a second site now touches the " +
        "tenant-access adjudicator or its NAT64/WhoIs internals — see C5's structural fix, " +
        "not a pattern exemption.",
    );
    process.exit(1);
  }

  console.log("check-cli-shell-safety: OK");
}

main();
