#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TARGETS = ["src/app/api", "src/lib"];
const CALLS = ["withUserTenantRls(", "withTeamTenantRls("];
const FORBIDDEN = ["requireTeamPermission(", "requireTeamMember("];

function getFiles() {
  const out = execSync(
    `rg --files ${TARGETS.join(" ")} -g '*.ts' -g '*.tsx'`,
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function extractCallSegment(text, start, callToken) {
  const openIdx = start + callToken.length - 1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function findViolations(path, text) {
  const violations = [];

  for (const callToken of CALLS) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(callToken, cursor);
      if (start === -1) break;

      const segment = extractCallSegment(text, start, callToken);
      if (segment) {
        const hasForbidden = FORBIDDEN.some((token) => segment.includes(token));
        if (hasForbidden) {
          violations.push({
            path,
            line: lineOf(text, start),
          });
        }
      }

      cursor = start + callToken.length;
    }
  }

  return violations;
}

const violations = [];
for (const file of getFiles()) {
  const text = readFileSync(file, "utf8");
  violations.push(...findViolations(file, text));
}

if (violations.length > 0) {
  console.error("Found forbidden nested team-auth calls under tenant RLS wrappers.");
  console.error(
    "Use requireTeamPermission/requireTeamMember directly; do not wrap them with withUserTenantRls/withTeamTenantRls.",
  );
  console.error("");
  for (const v of violations) {
    console.error(`${v.path}:${v.line}`);
  }
  process.exit(1);
}

console.log("check-team-auth-rls: OK");
