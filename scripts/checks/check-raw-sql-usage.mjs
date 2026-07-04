#!/usr/bin/env node
/**
 * CI guard: raw-SQL usage allowlist + unconditional interpolation ban (C2).
 *
 * Two independent layers (see docs/archive/review/route-policy-sql-security-plan.md, C2):
 *
 * Layer 1 (file allowlist): every production file matching the shared `rawSql`
 * regex (route-class-patterns.json) MUST appear in raw-sql-usage.txt with a
 * purpose (>=10 chars). A listed file that no longer matches the regex fails
 * as STALE_EXEMPT (mirrors check-permanent-delete-stepup.sh's anti-drift check).
 *
 * Layer 2 (span-based interpolation ban, UNCONDITIONAL — runs on allowlisted
 * files too): tracks the backtick-delimited template-literal span of every
 * `$executeRawUnsafe(`/`$queryRawUnsafe(` call argument and flags any `${`
 * interpolation inside that span. This is the compensating control for Layer
 * 1's file-level granularity: a new injection-shaped call cannot hide inside
 * an already-allowlisted high-density file. A flagged span is exempt only if
 * it carries a `// raw-sql-ident: <reason, >=10 chars>` marker (on the call
 * line or inside the span) AND the file's raw-sql-usage.txt entry declares
 * `ident-markers=N` matching the marked-span count EXACTLY (no suffix = N=0,
 * fail-closed default).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

// ROOT and ALLOWLIST_FILE are env-overridable so the checker can run against an
// isolated fixture tree in tests (mirrors check-permanent-delete-stepup.sh's
// STEPUP_GUARD_* overrides). Defaults resolve to the real repo.
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.RAW_SQL_CHECK_ROOT ?? REPO_ROOT;

const PATTERNS_FILE = join(REPO_ROOT, "scripts/checks/route-class-patterns.json");
const ALLOWLIST_FILE =
  process.env.RAW_SQL_CHECK_ALLOWLIST ?? join(ROOT, "scripts/checks/raw-sql-usage.txt");

const MIN_PURPOSE_LENGTH = 10;
const MIN_MARKER_REASON_LENGTH = 10;
// How far back (lines) to search for a `const <ident> = \`...\`` declaration
// when an Unsafe call's argument is a bare identifier rather than a literal
// backtick template (e.g. sweep.ts's `const sql = \`...\`; ...; $executeRawUnsafe(sql, n)`).
const VARIABLE_LOOKBACK_LINES = 60;

// ---------------------------------------------------------------------------
// Shared pattern source (route-class-patterns.json) — native JSON import,
// no jq. Assert the required key is a non-empty string so a missing/null key
// fails CLOSED instead of silently producing an always-match or never-match
// regex.
// ---------------------------------------------------------------------------
const patterns = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
if (typeof patterns.rawSql !== "string" || patterns.rawSql.length === 0) {
  console.error(
    `PATTERNS_FILE_INVALID: "rawSql" in ${PATTERNS_FILE} is missing or not a non-empty string.`,
  );
  process.exit(1);
}
const RAW_SQL_RE = new RegExp(patterns.rawSql);

// ---------------------------------------------------------------------------
// File discovery — mirrors the seeding command:
//   grep -rlE '\$(queryRaw|executeRaw)(Unsafe)?\b' src scripts --include='*.ts' --include='*.tsx' \
//     | grep -vE '\.test\.|__tests__|manual-tests|/e2e/'
// ---------------------------------------------------------------------------
const SCAN_ROOTS = ["src", "scripts"];
const EXCLUDE_RE = /\.test\.|__tests__|manual-tests|\/e2e\//;

function getSourceFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootPath = join(ROOT, root);
    let dirEntries;
    try {
      dirEntries = readdirSync(rootPath, { recursive: true, withFileTypes: true });
    } catch {
      continue; // scan root absent (e.g. an isolated fixture tree) — skip
    }
    for (const entry of dirEntries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name);
      if (ext !== ".ts" && ext !== ".tsx") continue;
      const abs = join(entry.parentPath ?? entry.path, entry.name);
      const rel = abs.slice(ROOT.length).replace(/^\/+/, "");
      if (EXCLUDE_RE.test(rel)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Allowlist parsing — `path # purpose [# ident-markers=N]`, `#`-comment lines,
// blank lines skipped. Mirrors check-permanent-delete-stepup.sh conventions.
// ---------------------------------------------------------------------------
function parseAllowlist(text) {
  const entries = new Map(); // path -> { purpose, identMarkers, lineNo }
  const parseFailures = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue; // full-line comment

    const parts = raw.split("#").map((p) => p.trim());
    // parts[0] = path; parts[1] = purpose; parts[2] (optional) = ident-markers=N
    const path = parts[0];
    if (!path) continue;

    const purpose = parts[1] ?? "";
    if (purpose.length < MIN_PURPOSE_LENGTH) {
      parseFailures.push(
        `NO_PURPOSE: ${path} has no (or too short, <${MIN_PURPOSE_LENGTH} chars) purpose in raw-sql-usage.txt (line ${i + 1}).`,
      );
    }

    let identMarkers = 0;
    if (parts.length >= 3 && parts[2].length > 0) {
      const m = /^ident-markers=(\d+)$/.exec(parts[2]);
      if (!m) {
        parseFailures.push(
          `MALFORMED_IDENT_MARKERS: ${path} has an unparseable ident-markers suffix "${parts[2]}" (line ${i + 1}); expected "ident-markers=N".`,
        );
      } else {
        identMarkers = Number(m[1]);
      }
    }

    entries.set(path, { purpose, identMarkers, lineNo: i + 1 });
  }

  return { entries, parseFailures };
}

// ---------------------------------------------------------------------------
// Layer 2: span-based interpolation ban.
//
// Finds every `<expr>.$executeRawUnsafe(` / `<expr>.$queryRawUnsafe(` call
// site, resolves its first argument's backtick template-literal span (either
// the literal directly in the call, or — when the argument is a bare
// identifier — the nearest preceding `const/let <ident> = \`...\`` binding
// within VARIABLE_LOOKBACK_LINES), and flags any `${` found inside that span.
//
// A flagged span is exempt only if a `// raw-sql-ident: <reason>` marker is
// present on the call line or anywhere inside the span, with a reason of at
// least MIN_MARKER_REASON_LENGTH characters.
// ---------------------------------------------------------------------------
const UNSAFE_CALL_RE = /\.\$(?:executeRawUnsafe|queryRawUnsafe)\s*(?:<[^(]*>)?\s*\(/g;
// `m` flag: markers may sit on any line of a multi-line span, not just the
// string's last line.
const MARKER_RE = /\/\/\s*raw-sql-ident:\s*(.*)$/m;

/**
 * Find the span [start, end) of a backtick template literal beginning at
 * `openIdx` (which must point at the opening backtick). Handles nested
 * `${...}` expressions by brace-depth counting so an embedded `}` inside an
 * interpolation doesn't prematurely end the outer scan (not strictly needed
 * for this codebase's SQL strings, but keeps the scanner correct generally).
 * Returns null if no closing backtick is found (malformed / unsupported).
 */
function findTemplateLiteralSpan(content, openIdx) {
  let i = openIdx + 1;
  let braceDepth = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (braceDepth === 0 && ch === "`") {
      return { start: openIdx, end: i + 1 };
    }
    if (ch === "$" && content[i + 1] === "{") {
      braceDepth += 1;
      i += 2;
      continue;
    }
    if (braceDepth > 0 && ch === "{") {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (braceDepth > 0 && ch === "}") {
      braceDepth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/** Find all `${` occurrence indices strictly inside [start, end) (excluding the delimiter backticks). */
function findInterpolations(content, start, end) {
  const hits = [];
  const inner = content.slice(start + 1, end - 1);
  const re = /\$\{/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    hits.push(start + 1 + m.index);
  }
  return hits;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Skip whitespace/newlines AND leading `//` line comments starting at idx —
 * a `// raw-sql-ident:` marker is commonly placed on its own line directly
 * before the template literal argument (see sweepAuditProvenanceEntry in
 * sweep.ts), so the argument scanner must see past it to find the backtick.
 */
function skipWhitespaceAndComments(content, idx) {
  let i = idx;
  for (;;) {
    while (i < content.length && /\s/.test(content[i])) i += 1;
    if (content[i] === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Given the index of the `(` that opens an Unsafe call's argument list,
 * resolve the template-literal span used as the SQL argument.
 *   - If the first token is a backtick, that literal IS the span.
 *   - If the first token is a bare identifier, search backward (within
 *     VARIABLE_LOOKBACK_LINES) for `const <ident> = \`` / `let <ident> = \``
 *     and use that literal's span instead.
 * Returns:
 *   - a { start, end } span when the argument is a backtick literal or a
 *     bare identifier bound to one within VARIABLE_LOOKBACK_LINES;
 *   - the UNRESOLVED sentinel when the argument is a bare identifier we could
 *     NOT bind to a single backtick literal (reassignment/concatenation, an
 *     imported constant, a function-call result, etc.) — the checker cannot
 *     prove such a string is interpolation-free, so it must fail closed rather
 *     than silently skip (a `let sql = f(); sql = sql + \`...${x}...\`` shape
 *     would otherwise evade Layer 2);
 *   - null only when the argument is not an identifier or literal at all
 *     (e.g. an inline object / array) — genuinely out of Layer 2's model.
 */
const UNRESOLVED = Symbol("unresolved-sql-arg");

function resolveArgSpan(content, openParenIdx) {
  const argStart = skipWhitespaceAndComments(content, openParenIdx + 1);
  if (content[argStart] === "`") {
    return findTemplateLiteralSpan(content, argStart);
  }

  const identMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(content.slice(argStart));
  if (!identMatch) return null;
  const ident = identMatch[0];

  // Search backward from openParenIdx for the nearest `const/let <ident> = \``.
  // A reassignment (`<ident> = ...`) between that decl and the call would make
  // the literal stale, so reject if we see the identifier reassigned after its
  // backtick binding.
  const callLine = lineNumberAt(content, openParenIdx);
  const lines = content.split("\n");
  const declRe = new RegExp(`^\\s*(?:const|let)\\s+${ident}\\s*=\\s*\``);
  const reassignRe = new RegExp(`^\\s*${ident}\\s*(?:\\+)?=[^=]`);
  const searchFloor = Math.max(0, callLine - 1 - VARIABLE_LOOKBACK_LINES);
  for (let ln = callLine - 1; ln >= searchFloor; ln--) {
    const lineText = lines[ln - 1] ?? "";
    if (declRe.test(lineText)) {
      const lineStartIdx = lines.slice(0, ln - 1).join("\n").length + (ln > 1 ? 1 : 0);
      const backtickIdx = content.indexOf("`", lineStartIdx);
      if (backtickIdx === -1) return UNRESOLVED;
      return findTemplateLiteralSpan(content, backtickIdx);
    }
    // A bare `<ident> =` / `<ident> +=` above the call but before any backtick
    // decl was found means the string is built by reassignment — unverifiable.
    if (reassignRe.test(lineText)) return UNRESOLVED;
  }
  return UNRESOLVED;
}

/**
 * Scan one file's content for Layer-2 violations, grouped by CALL SITE (one
 * entry per Unsafe call whose argument span contains >=1 `${` interpolation).
 * Call site is the correct unit for the ident-markers=N pairing rule: a
 * single marker covers the whole span, however many `${` occurrences it has.
 */
function scanFileByCallSite(content) {
  const results = []; // { line, hasInterpolation, marked, reasonLength }

  UNSAFE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = UNSAFE_CALL_RE.exec(content)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const span = resolveArgSpan(content, openParenIdx);
    if (span === null) continue; // not an identifier/literal arg — out of model
    if (span === UNRESOLVED) {
      // Fail closed: the SQL string is built in a way we cannot statically
      // prove is interpolation-free (reassignment, imported const, fn result).
      results.push({
        callLine: lineNumberAt(content, m.index),
        firstHitLine: lineNumberAt(content, m.index),
        marker: null,
        unresolved: true,
      });
      continue;
    }

    const hits = findInterpolations(content, span.start, span.end);
    if (hits.length === 0) continue;

    const callLine = lineNumberAt(content, m.index);
    const spanText = content.slice(span.start, span.end);
    const callLineText = content.split("\n")[callLine - 1] ?? "";
    const precedingLine = content.split("\n")[callLine - 2] ?? "";
    const spanStartLine = lineNumberAt(content, span.start);
    const linePrecedingSpan = content.split("\n")[spanStartLine - 2] ?? "";

    const markerOnCallLine = MARKER_RE.exec(callLineText);
    const markerInSpan = MARKER_RE.exec(spanText);
    const markerPreceding = MARKER_RE.exec(precedingLine);
    const markerPrecedingSpan = MARKER_RE.exec(linePrecedingSpan);
    const marker = markerOnCallLine ?? markerInSpan ?? markerPreceding ?? markerPrecedingSpan;

    results.push({
      callLine,
      firstHitLine: lineNumberAt(content, hits[0]),
      marker: marker ? marker[1].trim() : null,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allowlistText = readFileSync(ALLOWLIST_FILE, "utf8");
const { entries, parseFailures } = parseAllowlist(allowlistText);

const sourceFiles = getSourceFiles();
const matchingFiles = sourceFiles.filter((f) => RAW_SQL_RE.test(readFileSync(join(ROOT, f), "utf8")));

let failed = false;

if (parseFailures.length > 0) {
  failed = true;
  console.error("raw-sql-usage.txt parse errors:");
  for (const f of parseFailures) console.error(`  ${f}`);
  console.error("");
}

// Layer 1a: every matching file must be allowlisted.
const missingFromAllowlist = matchingFiles.filter((f) => !entries.has(f));
if (missingFromAllowlist.length > 0) {
  failed = true;
  console.error(
    "MISSING_FROM_ALLOWLIST: files call a raw-SQL primitive but are not listed in scripts/checks/raw-sql-usage.txt:",
  );
  for (const f of missingFromAllowlist) console.error(`  ${f}`);
  console.error(
    "\nAdd a line: `<path> # <purpose, >=10 chars>` to scripts/checks/raw-sql-usage.txt.",
  );
  console.error("");
}

// Layer 1b: STALE_EXEMPT — listed files that no longer match the regex.
const matchingSet = new Set(matchingFiles);
const staleEntries = [...entries.keys()].filter((f) => !matchingSet.has(f));
if (staleEntries.length > 0) {
  failed = true;
  console.error(
    "STALE_EXEMPT: files are listed in raw-sql-usage.txt but no longer match a raw-SQL primitive — remove the entry:",
  );
  for (const f of staleEntries) console.error(`  ${f}`);
  console.error("");
}

// Layer 2: span-based interpolation ban — runs on EVERY matching file,
// allowlisted or not (unconditional; independent of Layer 1's outcome).
// Note: an orphaned marker (marker present, no interpolation nearby) is
// caught by countMismatches below — it never contributes to markedCount, so
// a nonzero declared ident-markers=N with no matching marked call site is a
// mismatch, not a silent pass.
const unmarkedViolations = [];
const shortReasonViolations = [];
const countMismatches = [];
const unresolvedViolations = [];
const absentValidatorViolations = [];

for (const file of matchingFiles) {
  const content = readFileSync(join(ROOT, file), "utf8");
  const callSites = scanFileByCallSite(content);

  const markedCount = callSites.filter(
    (c) => !c.unresolved && c.marker !== null && c.marker.length >= MIN_MARKER_REASON_LENGTH,
  ).length;
  const declaredN = entries.get(file)?.identMarkers ?? 0;

  for (const site of callSites) {
    if (site.unresolved) {
      // A marker cannot bless a string we cannot statically resolve.
      unresolvedViolations.push({ file, line: site.firstHitLine });
    } else if (site.marker === null) {
      unmarkedViolations.push({ file, line: site.firstHitLine });
    } else if (site.marker.length < MIN_MARKER_REASON_LENGTH) {
      shortReasonViolations.push({ file, line: site.firstHitLine, reason: site.marker });
    } else {
      // RESIDUAL (accepted, review-enforced): this checks the named validator
      // EXISTS in the file, not that it is invoked on the interpolated value.
      // A decoy function with a validator-shaped name + a marker naming it
      // still passes — a `git diff` reviewer must confirm the named mechanism
      // actually guards the marked span. This is the ceiling of a lexical
      // guard; see TODO(route-policy-sql-security) in the plan's C2 residual.
      // If the marker names a validation function, that function MUST appear
      // in the same file — catches a copy-pasted marker naming an absent
      // mechanism. Only tokens that look like an actual call are considered:
      // an empty-paren call (`validateRegistry()`) or a validator-verb-prefixed
      // call (`assertIdentifier(`, `validateX(`, ...). This deliberately does
      // NOT match English prose like "clause string (never ...)" — free-text
      // reasons that explain safety inline (without naming a function) are fine.
      const VALIDATOR_TOKEN_RE =
        /\b([A-Za-z_$][A-Za-z0-9_$]*\(\)|(?:assert|validate|check|sanitize|escape|guard)[A-Za-z0-9_$]*\()/g;
      const named = site.marker.match(VALIDATOR_TOKEN_RE) ?? [];
      for (const tok of named) {
        const fn = tok.replace(/\(\)?$/, "");
        const declaredElsewhere = new RegExp(`\\b${fn}\\s*\\(`).test(
          content.replace(site.marker, ""),
        );
        if (!declaredElsewhere) {
          absentValidatorViolations.push({ file, line: site.firstHitLine, fn });
        }
      }
    }
  }

  if (entries.has(file) || markedCount > 0) {
    if (markedCount !== declaredN) {
      countMismatches.push({ file, markedCount, declaredN });
    }
  }
}

if (unresolvedViolations.length > 0) {
  failed = true;
  console.error(
    "UNRESOLVED_SQL_ARG: an Unsafe raw-SQL call's argument is a SQL string this checker cannot statically resolve to a single backtick literal (reassignment/concatenation, imported const, or function result) — it cannot be proven interpolation-free and is rejected:",
  );
  for (const v of unresolvedViolations) console.error(`  ${v.file}:${v.line}`);
  console.error(
    "\nInline the SQL as a single `const <name> = \`...\`` template with $N bound params, so Layer 2 can verify it.",
  );
  console.error("");
}

if (absentValidatorViolations.length > 0) {
  failed = true;
  console.error(
    "MARKER_VALIDATOR_ABSENT: a `raw-sql-ident` marker names a validation function that does not appear in the same file (likely a copy-pasted marker):",
  );
  for (const v of absentValidatorViolations) {
    console.error(`  ${v.file}:${v.line}  names \`${v.fn}(\` which is not present in the file`);
  }
  console.error(
    "\nThe marker reason must name the actual validation mechanism used at this call site.",
  );
  console.error("");
}

if (unmarkedViolations.length > 0) {
  failed = true;
  console.error(
    "UNMARKED_INTERPOLATION: `${...}` interpolation found inside an Unsafe raw-SQL call with no `// raw-sql-ident:` marker:",
  );
  for (const v of unmarkedViolations) console.error(`  ${v.file}:${v.line}`);
  console.error(
    "\nEither remove the interpolation (prefer $N bound params) or add a `// raw-sql-ident: <reason, >=10 chars>` marker naming the validation mechanism, and bump `ident-markers=N` in raw-sql-usage.txt.",
  );
  console.error("");
}

if (shortReasonViolations.length > 0) {
  failed = true;
  console.error("SHORT_MARKER_REASON: `raw-sql-ident` marker reason is shorter than 10 characters:");
  for (const v of shortReasonViolations) console.error(`  ${v.file}:${v.line}  "${v.reason}"`);
  console.error("");
}

if (countMismatches.length > 0) {
  failed = true;
  console.error(
    "IDENT_MARKERS_MISMATCH: marked-span count does not match the declared ident-markers=N in raw-sql-usage.txt (fails in EITHER direction — an orphaned marker after a refactor fails too):",
  );
  for (const v of countMismatches) {
    console.error(`  ${v.file}: found ${v.markedCount} marked span(s), declared ident-markers=${v.declaredN}`);
  }
  console.error(
    "\nUpdate the `# ident-markers=N` suffix in raw-sql-usage.txt to match the actual marked-span count.",
  );
  console.error("");
}

if (failed) {
  process.exit(1);
}

console.log("check-raw-sql-usage: OK");
