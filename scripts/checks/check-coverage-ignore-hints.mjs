#!/usr/bin/env node
/**
 * CI guard: no coverage member carries a coverage-ignore hint.
 *
 * A per-file floor is only as honest as what it counts. `c8 ignore next` (and
 * its istanbul / v8 / node:coverage spellings) removes code from the count, so
 * one hint can lift a file over its floor without a test. This gate refuses
 * every hint the v8 provider would honour, in both of the scopes the provider
 * reads them (ast-v8-to-istanbul, dist/index.mjs `src/ignore-hints.ts`):
 *
 *   if|else|next|file — read from COMMENTS only. Comments are found with the
 *                       TypeScript scanner (via the parser's comment ranges),
 *                       so the same words in a string or JSX text are not hits.
 *   start|stop        — read from every RAW source LINE, so a string, template
 *                       literal or JSX text that spells the hint is a hit too.
 *
 * Both scans are case-insensitive and unanchored, i.e. wider than the provider
 * (which anchors the comment form at the comment's start): a near-miss
 * spelling that a future provider might accept is refused now.
 *
 * Member set: scripts/checks/lib/coverage-members.mjs (shared with
 * check-coverage-scope). An empty member list refuses — scanning nothing proves
 * nothing.
 *
 * Background: docs/archive/review/close-coverage-and-clipboard-gaps-plan.md, C2c.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { listMembers } from "./lib/coverage-members.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const COMMENT_HINT = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)/i;
const LINE_HINT = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(start|stop)/i;
// Every comment hint is also a substring of the raw text, so files without this
// never need parsing.
const ANY_HINT = /(?:istanbul|[cv]8|node:coverage)\s+ignore/i;

function commentRanges(path, text) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const seen = new Map();
  // Every comment sits in the trivia before some token: the part up to the
  // first line break is what TypeScript calls trailing (of the previous token),
  // the rest leading, so both are read at each token's pos. getChildren()
  // materialises punctuation tokens too (a `}` closing a JSX expression holds
  // `{/* … */}`'s comment), and JsxText is a token whose text is not trivia.
  const visit = (node) => {
    for (const r of ts.getTrailingCommentRanges(text, node.pos) ?? []) seen.set(r.pos, r);
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) seen.set(r.pos, r);
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...seen.values()];
}

function lineOf(text, pos) {
  return text.slice(0, pos).split("\n").length;
}

/** Hits in one file's source text, as `path:line: <scope> hint "<text>"`. */
export function scanSource(path, text) {
  if (!ANY_HINT.test(text)) return [];
  const hits = [];
  for (const r of commentRanges(path, text)) {
    const comment = text.slice(r.pos, r.end);
    const m = comment.match(COMMENT_HINT);
    if (m) {
      hits.push(`${path}:${lineOf(text, r.pos + (m.index ?? 0))}: COVERAGE_IGNORE_HINT (comment): "${m[0].replace(/\s+/g, " ")}"`);
    }
  }
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(LINE_HINT);
    if (m) hits.push(`${path}:${i + 1}: COVERAGE_IGNORE_HINT (line): "${m[0].replace(/\s+/g, " ")}"`);
  });
  return hits;
}

export function scanMembers(members, root = REPO_ROOT) {
  if (members.length === 0) {
    throw new Error("COVERAGE_MEMBERS_EMPTY: no members to scan");
  }
  return members.flatMap((m) => scanSource(m, readFileSync(resolve(root, m), "utf8")));
}

function main() {
  let hits;
  let members;
  try {
    members = listMembers();
    hits = scanMembers(members);
  } catch (err) {
    console.error(`check-coverage-ignore-hints: FAIL\n  - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (hits.length > 0) {
    console.error("check-coverage-ignore-hints: FAIL — a coverage-ignore hint removes code from the per-file floor's count; test the code instead");
    for (const h of hits) console.error(`  - ${h}`);
    process.exit(1);
  }
  console.log(`check-coverage-ignore-hints: OK (${members.length} members scanned)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
