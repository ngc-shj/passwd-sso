#!/usr/bin/env node
// Gate: `npm audit --audit-level=high` over the whole tree, with a documented,
// expiring suppression for advisories that have NO fixed version to move to.
//
// Used only for CI's dev-scope audit step. The production step stays a plain
// `npm audit --omit=dev --audit-level=high`, which nothing here can suppress.
//
// Suppressions live in scripts/checks/npm-audit-suppressions.json:
//   { "suppressions": [ { "id": "GHSA-…", "package": "<name>",
//                         "reason": "…", "expires": "YYYY-MM-DD" } ] }
//
// Fails closed on:
//   - a high/critical advisory with no matching, unexpired suppression
//   - a suppression past its expiry, or expiring more than 90 days out
//   - a suppression that matches no current advisory (stale — delete it)
//   - an advisory it cannot identify by GHSA id
//   - npm audit output it cannot parse, or an npm error report
//
// Seams for the self-test: NPM_AUDIT_JSON (read this file instead of running
// npm audit), CHECK_NPM_AUDIT_TODAY (YYYY-MM-DD), --suppressions <path>.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUPPRESSIONS = resolve(__dirname, "npm-audit-suppressions.json");
const GATED_SEVERITIES = new Set(["high", "critical"]);
const MAX_SUPPRESSION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GHSA_URL_RE = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$/;
const GHSA_ID_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(lines) {
  console.error("npm audit gate failed:");
  for (const l of lines) console.error(`  - ${l}`);
  console.error("See docs/security/vulnerability-triage.md (npm audit suppression).");
  process.exit(1);
}

/** Epoch ms for a real calendar date, or null. */
function parseDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function parseArgs(argv) {
  let suppressions = DEFAULT_SUPPRESSIONS;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--suppressions" && argv[i + 1]) {
      suppressions = resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    fail([`unknown argument: ${argv[i]}`]);
  }
  return { suppressions };
}

function readAuditReport() {
  let raw;
  if (process.env.NPM_AUDIT_JSON) {
    raw = readFileSync(process.env.NPM_AUDIT_JSON, "utf8");
  } else {
    // npm audit exits non-zero whenever it finds anything, so the exit status
    // says nothing here; the report's shape is what is checked below.
    const r = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) fail([`could not run npm audit: ${r.error.message}`]);
    raw = r.stdout;
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    fail(["npm audit output is not JSON"]);
  }
  if (report?.error) fail([`npm audit reported an error: ${report.error.summary ?? report.error.code ?? "unknown"}`]);
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    fail(["npm audit output is not an auditReportVersion 2 report"]);
  }
  return report;
}

function loadSuppressions(path, todayMs) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail([`cannot read suppressions ${path}: ${e.message}`]);
  }
  if (!Array.isArray(doc?.suppressions)) fail([`${path}: "suppressions" must be an array`]);
  const errors = [];
  const entries = [];
  for (const [i, s] of doc.suppressions.entries()) {
    const where = `${path} suppressions[${i}]`;
    const expiresMs = parseDate(s?.expires);
    if (!GHSA_ID_RE.test(s?.id ?? "")) errors.push(`${where}: id must be a GHSA id`);
    else if (typeof s.package !== "string" || s.package === "") errors.push(`${where}: package is required`);
    else if (typeof s.reason !== "string" || s.reason.trim().length < 20) errors.push(`${where}: reason must explain why the advisory does not apply`);
    else if (expiresMs === null) errors.push(`${where}: expires must be a YYYY-MM-DD date`);
    else if (expiresMs < todayMs) errors.push(`${s.id} (${s.package}): suppression expired on ${s.expires} — re-evaluate, then fix or renew`);
    else if (expiresMs - todayMs > MAX_SUPPRESSION_DAYS * MS_PER_DAY) errors.push(`${s.id} (${s.package}): expires ${s.expires} is more than ${MAX_SUPPRESSION_DAYS} days out`);
    else entries.push(s);
  }
  return { entries, errors };
}

function main() {
  const { suppressions } = parseArgs(process.argv);
  const todayStr = process.env.CHECK_NPM_AUDIT_TODAY ?? new Date().toISOString().slice(0, 10);
  const todayMs = parseDate(todayStr);
  if (todayMs === null) fail([`invalid CHECK_NPM_AUDIT_TODAY: ${todayStr}`]);

  const report = readAuditReport();
  const { entries, errors } = loadSuppressions(suppressions, todayMs);
  const used = new Set();
  const suppressed = [];

  // Advisory objects in `via` are the roots; string entries name a dependency
  // that is vulnerable only because of a root reported elsewhere in the map.
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln?.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      if (!GATED_SEVERITIES.has(via.severity)) continue;
      const id = GHSA_URL_RE.exec(via.url ?? "")?.[1];
      if (!id) {
        errors.push(`${via.name ?? vuln.name}: ${via.severity} advisory without a GHSA url (${via.url ?? "none"})`);
        continue;
      }
      const match = entries.find((s) => s.id === id && s.package === via.name);
      if (match) {
        used.add(match);
        suppressed.push(`${id} (${via.name}) until ${match.expires}`);
      } else {
        errors.push(`${id} (${via.name}, ${via.severity}): ${via.title ?? ""} — ${via.range ?? ""}`);
      }
    }
  }
  for (const s of entries) {
    if (!used.has(s)) errors.push(`${s.id} (${s.package}): suppression matches no current advisory — delete it`);
  }

  if (errors.length > 0) fail(errors);
  for (const s of new Set(suppressed)) console.log(`suppressed: ${s}`);
  console.log("npm audit gate passed (no unsuppressed high/critical advisories).");
}

main();
