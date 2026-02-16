#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN_PATTERNS = [/AGPL/i, /\bGPL\b/i];
const REVIEW_PATTERNS = [/LGPL/i, /MPL/i, /EPL/i, /CDDL/i, /EUPL/i, /BlueOak/i, /CC-BY/i];

function parseArgs(argv) {
  const args = {
    lockfile: "package-lock.json",
    name: "root",
    includeDev: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--include-dev") {
      args.includeDev = true;
      continue;
    }
    if (v === "--lockfile") {
      args.lockfile = argv[i + 1];
      i += 1;
      continue;
    }
    if (v === "--name") {
      args.name = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${v}`);
  }
  return args;
}

function normalizePkgName(k) {
  return k.startsWith("node_modules/") ? k.slice("node_modules/".length) : k;
}

function auditLockfile(lockfilePath, { includeDev }) {
  const raw = readFileSync(lockfilePath, "utf8");
  const lock = JSON.parse(raw);
  const packages = lock.packages ?? {};

  const forbidden = [];
  const review = [];
  const missing = [];
  let scanned = 0;

  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    if (!includeDev && meta.dev) continue;
    scanned += 1;

    const license = (meta.license ?? "").toString().trim();
    const name = normalizePkgName(pkgPath);
    if (!license) {
      missing.push(name);
      continue;
    }
    if (FORBIDDEN_PATTERNS.some((re) => re.test(license))) {
      forbidden.push({ name, license });
      continue;
    }
    if (REVIEW_PATTERNS.some((re) => re.test(license))) {
      review.push({ name, license });
    }
  }

  return { scanned, forbidden, review, missing };
}

function printList(title, rows) {
  if (rows.length === 0) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, 30)) {
    if (typeof row === "string") console.log(`- ${row}`);
    else console.log(`- ${row.name} (${row.license})`);
  }
  if (rows.length > 30) {
    console.log(`... and ${rows.length - 30} more`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const lockfilePath = resolve(process.cwd(), args.lockfile);
  const result = auditLockfile(lockfilePath, { includeDev: args.includeDev });

  console.log(`[license-audit] target=${args.name}`);
  console.log(`[license-audit] lockfile=${args.lockfile}`);
  console.log(`[license-audit] scanned_packages=${result.scanned}`);

  printList("Forbidden licenses (fail)", result.forbidden);
  printList("Review required licenses (warning)", result.review);
  printList("Missing license metadata (warning)", result.missing);

  if (result.forbidden.length > 0) {
    console.error("\n[license-audit] FAILED: forbidden licenses detected.");
    process.exit(1);
  }
  console.log("\n[license-audit] PASSED");
}

main();
