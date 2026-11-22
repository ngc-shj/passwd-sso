#!/usr/bin/env node
/**
 * CI guard (output layer): the merged coverage report measured every member.
 *
 * Usage: node scripts/checks/check-coverage-scope.mjs coverage/coverage-summary.json
 *
 * Runs in `app-coverage` after `npx vitest --merge-reports --coverage`. The
 * config layer (vitest.config.ts's include/exclude cover every member, every
 * threshold key floors something) is proven by this gate's self-test against
 * the real config; this layer adjudicates on what vitest actually measured, so
 * a member dropped by anything the config check cannot see — a provider
 * default, a CLI override, a file vitest failed to load — still reds.
 *
 * Fails closed on a missing, unparseable or empty summary and on an empty
 * member set: none of those can prove every member was measured.
 *
 * Background: docs/archive/review/close-coverage-and-clipboard-gaps-plan.md, C1(b).
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSummary, listMembers } from "./lib/coverage-members.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Returns failure messages for the summary at `summaryPath`; empty means OK. */
export function checkCoverageSummaryFile(summaryPath, members, root = REPO_ROOT) {
  let text;
  try {
    text = readFileSync(summaryPath, "utf8");
  } catch (err) {
    return [`COVERAGE_SUMMARY_MISSING: cannot read ${summaryPath}: ${err instanceof Error ? err.message : String(err)}`];
  }
  let summary;
  try {
    summary = JSON.parse(text);
  } catch (err) {
    return [`COVERAGE_SUMMARY_UNPARSEABLE: ${summaryPath}: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return [`COVERAGE_SUMMARY_UNPARSEABLE: ${summaryPath} is not a JSON object`];
  }
  if (Object.keys(summary).filter((k) => k !== "total").length === 0) {
    return [`COVERAGE_SUMMARY_EMPTY: ${summaryPath} has no per-file entries`];
  }
  if (members.length === 0) {
    return ["COVERAGE_MEMBERS_EMPTY: no members to check the summary against"];
  }
  return checkSummary(summary, members, root).map(
    (m) => `COVERAGE_MEMBER_MISSING: ${m} is a member but the coverage report did not measure it`,
  );
}

function main() {
  const summaryPath = process.argv[2];
  if (!summaryPath) {
    console.error("usage: check-coverage-scope.mjs <coverage-summary.json>");
    process.exit(1);
  }
  let members;
  try {
    members = listMembers();
  } catch (err) {
    console.error(`check-coverage-scope: FAIL\n  - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const failures = checkCoverageSummaryFile(resolve(summaryPath), members);
  if (failures.length > 0) {
    console.error("check-coverage-scope: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`check-coverage-scope: OK (${members.length} members measured)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
