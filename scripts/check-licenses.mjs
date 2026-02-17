#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_PATTERNS = [/AGPL/i, /\bGPL\b/i];
const REVIEW_PATTERNS = [/LGPL/i, /MPL/i, /EPL/i, /CDDL/i, /EUPL/i, /BlueOak/i, /CC-BY/i];

const REQUIRED_ALLOWLIST_FIELDS = [
  "package",
  "license",
  "category",
  "reason",
  "scope",
  "packageVersion",
  "approvedBy",
  "reviewedAt",
  "expiresAt",
  "ticket",
  "evidenceUrl",
];

function parseArgs(argv) {
  const args = {
    lockfile: "package-lock.json",
    name: "root",
    includeDev: false,
    strict: false,
    allowlistPath: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--include-dev") {
      args.includeDev = true;
      continue;
    }
    if (v === "--strict") {
      args.strict = true;
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
    if (v === "--allowlist") {
      args.allowlistPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${v}`);
  }
  return args;
}

function loadAllowlist(allowlistPath) {
  const filePath =
    allowlistPath || resolve(__dirname, "license-allowlist.json");
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { entries: [], schemaWarnings: [] };
    throw err;
  }

  const data = JSON.parse(raw);
  const entries = data.allowlist ?? [];
  const schemaWarnings = [];

  for (const entry of entries) {
    const missing = REQUIRED_ALLOWLIST_FIELDS.filter((f) => !entry[f]);
    if (missing.length > 0) {
      schemaWarnings.push(
        `${entry.package || "unknown"}: missing fields: ${missing.join(", ")}`,
      );
    }
  }

  return { entries, schemaWarnings };
}

function normalizePkgName(k) {
  return k.startsWith("node_modules/") ? k.slice("node_modules/".length) : k;
}

function auditLockfile(lockfilePath, { includeDev }, allowlist) {
  const raw = readFileSync(lockfilePath, "utf8");
  const lock = JSON.parse(raw);
  const packages = lock.packages ?? {};

  const today = new Date().toISOString().slice(0, 10);
  const allowlistMap = new Map();
  for (const entry of allowlist.entries) {
    allowlistMap.set(entry.package, entry);
  }

  const forbidden = [];
  const allowlisted = [];
  const expired = [];
  const unreviewed = [];
  const missingAllowlisted = [];
  const missingExpired = [];
  const missingUnreviewed = [];
  let scanned = 0;

  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    if (!includeDev && meta.dev) continue;
    scanned += 1;

    const license = (meta.license ?? "").toString().trim();
    const name = normalizePkgName(pkgPath);

    if (!license) {
      const entry = allowlistMap.get(name);
      if (entry) {
        if (entry.expiresAt && entry.expiresAt < today) {
          missingExpired.push(name);
        } else {
          missingAllowlisted.push(name);
        }
      } else {
        missingUnreviewed.push(name);
      }
      continue;
    }
    if (FORBIDDEN_PATTERNS.some((re) => re.test(license))) {
      forbidden.push({ name, license });
      continue;
    }
    if (REVIEW_PATTERNS.some((re) => re.test(license))) {
      const entry = allowlistMap.get(name);
      if (entry) {
        if (entry.expiresAt && entry.expiresAt < today) {
          expired.push({ name, license });
        } else {
          allowlisted.push({ name, license });
        }
      } else {
        unreviewed.push({ name, license });
      }
    }
  }

  return {
    scanned,
    forbidden,
    allowlisted,
    expired,
    unreviewed,
    missingAllowlisted,
    missingExpired,
    missingUnreviewed,
  };
}

function printList(title, rows) {
  if (rows.length === 0) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, 30)) {
    if (typeof row === "string") console.log(`  - ${row}`);
    else console.log(`  - ${row.name} (${row.license})`);
  }
  if (rows.length > 30) {
    console.log(`  ... and ${rows.length - 30} more`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const lockfilePath = resolve(process.cwd(), args.lockfile);
  const allowlist = loadAllowlist(args.allowlistPath);
  const result = auditLockfile(
    lockfilePath,
    { includeDev: args.includeDev },
    allowlist,
  );

  console.log(`[license-audit] target=${args.name}`);
  console.log(`[license-audit] lockfile=${args.lockfile}`);
  console.log(`[license-audit] scanned_packages=${result.scanned}`);
  if (args.strict) console.log(`[license-audit] mode=strict`);

  printList("Forbidden licenses (fail)", result.forbidden);
  printList("Allowlisted exceptions (ok)", result.allowlisted);
  printList("Allowlisted missing-metadata (ok)", result.missingAllowlisted);
  printList("Expired exceptions (review needed)", result.expired);
  printList("Expired missing-metadata (review needed)", result.missingExpired);
  printList("Unreviewed review-required licenses", result.unreviewed);
  printList("Unreviewed missing license metadata", result.missingUnreviewed);

  if (allowlist.schemaWarnings.length > 0) {
    console.log(`\nAllowlist schema warnings (${allowlist.schemaWarnings.length})`);
    for (const w of allowlist.schemaWarnings) {
      console.log(`  - ${w}`);
    }
  }

  const hasExpired = result.expired.length + result.missingExpired.length > 0;
  const hasUnreviewed =
    result.unreviewed.length + result.missingUnreviewed.length > 0;
  const hasSchemaIssues = allowlist.schemaWarnings.length > 0;

  if (result.forbidden.length > 0) {
    console.error("\n[license-audit] FAILED: forbidden licenses detected.");
    process.exit(1);
  }

  if (args.strict) {
    const failures = [];
    if (hasUnreviewed) failures.push("unreviewed exceptions");
    if (hasExpired) failures.push("expired exceptions");
    if (hasSchemaIssues) failures.push("allowlist schema issues");
    if (failures.length > 0) {
      console.error(
        `\n[license-audit] FAILED (strict): ${failures.join(", ")}.`,
      );
      process.exit(1);
    }
    const totalAllowlisted =
      result.allowlisted.length + result.missingAllowlisted.length;
    console.log(
      `\n[license-audit] PASSED (strict) — allowlisted=${totalAllowlisted}, unreviewed=0, expired=0`,
    );
  } else {
    console.log("\n[license-audit] PASSED");
  }
}

main();
