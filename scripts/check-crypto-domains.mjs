#!/usr/bin/env node
/**
 * CI guard: ensure all HKDF info strings and AAD scopes in crypto-*.ts files
 * are documented in docs/security/crypto-domain-ledger.md.
 *
 * Fails if:
 * - A HKDF info string in code is not in the ledger
 * - An AAD scope in code is not in the ledger
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

// ─── Known HKDF info strings (from ledger) ──────────────────────
const KNOWN_HKDF_INFO = new Set([
  "passwd-sso-enc-v1",
  "passwd-sso-auth-v1",
  "passwd-sso-team-v1",
  "passwd-sso-team-enc-v1",
  "passwd-sso-ecdh-v1",
  "passwd-sso-emergency-v1",
  "passwd-sso-recovery-wrap-v1",
  "passwd-sso-recovery-verifier-v1",
]);

// ─── Known AAD scopes (from ledger) ──────────────────────────────
const KNOWN_AAD_SCOPES = new Set(["PV", "OV", "AT", "OK"]);

/**
 * Extract HKDF info strings from source code.
 * Matches patterns like: "passwd-sso-xxx-v1" in string literals.
 * Skips commented-out lines (// comments).
 */
export function extractHkdfInfoStrings(content) {
  const pattern = /["']passwd-sso-[a-z0-9-]+["']/g;
  const matches = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    for (const m of line.matchAll(pattern)) {
      matches.push(m[0].slice(1, -1));
    }
  }
  return [...new Set(matches)];
}

/**
 * Extract AAD scope constants from source code.
 * Matches patterns like: SCOPE_xxx = "XX" or AAD_SCOPE_xxx = "XX"
 */
export function extractAadScopes(content) {
  const pattern = /(?:SCOPE_|AAD_SCOPE_)\w+\s*=\s*["']([A-Z]{2})["']/g;
  const matches = [];
  for (const m of content.matchAll(pattern)) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

/**
 * Parse the ledger markdown for documented HKDF info strings.
 */
export function parseLedgerHkdfInfo(ledgerContent) {
  const pattern = /`passwd-sso-[a-z0-9-]+`/g;
  const matches = [];
  for (const m of ledgerContent.matchAll(pattern)) {
    matches.push(m[0].slice(1, -1)); // remove backticks
  }
  return [...new Set(matches)];
}

/**
 * Parse the ledger markdown for documented AAD scopes.
 */
export function parseLedgerAadScopes(ledgerContent) {
  const pattern = /^\| `([A-Z]{2})` \|/gm;
  const matches = [];
  for (const m of ledgerContent.matchAll(pattern)) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

function main() {
  const cryptoFiles = [
    "src/lib/crypto-client.ts",
    "src/lib/crypto-team.ts",
    "src/lib/crypto-emergency.ts",
    "src/lib/crypto-aad.ts",
    "src/lib/crypto-server.ts",
    "src/lib/crypto-recovery.ts",
    "src/lib/export-crypto.ts",
  ];

  const ledgerPath = join(ROOT, "docs/security/crypto-domain-ledger.md");
  let ledgerContent;
  try {
    ledgerContent = readFileSync(ledgerPath, "utf-8");
  } catch {
    console.error("ERROR: Ledger not found at", ledgerPath);
    process.exit(1);
  }

  const ledgerHkdf = new Set(parseLedgerHkdfInfo(ledgerContent));
  const ledgerAad = new Set(parseLedgerAadScopes(ledgerContent));

  const errors = [];

  for (const file of cryptoFiles) {
    const filePath = join(ROOT, file);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue; // file may not exist in all configurations
    }

    const hkdfStrings = extractHkdfInfoStrings(content);
    for (const info of hkdfStrings) {
      if (!ledgerHkdf.has(info)) {
        errors.push(`Undocumented HKDF info "${info}" in ${file}`);
      }
    }

    const aadScopes = extractAadScopes(content);
    for (const scope of aadScopes) {
      if (!ledgerAad.has(scope)) {
        errors.push(`Undocumented AAD scope "${scope}" in ${file}`);
      }
    }
  }

  // Check for documented domains that don't exist in code
  const allCodeHkdf = new Set();
  const allCodeAad = new Set();
  for (const file of cryptoFiles) {
    const filePath = join(ROOT, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      extractHkdfInfoStrings(content).forEach((s) => allCodeHkdf.add(s));
      extractAadScopes(content).forEach((s) => allCodeAad.add(s));
    } catch {
      // ignore missing files
    }
  }

  for (const info of ledgerHkdf) {
    if (!allCodeHkdf.has(info)) {
      errors.push(`Ledger documents HKDF info "${info}" but not found in code`);
    }
  }
  for (const scope of ledgerAad) {
    if (!allCodeAad.has(scope)) {
      errors.push(`Ledger documents AAD scope "${scope}" but not found in code`);
    }
  }

  if (errors.length > 0) {
    console.error("Crypto domain ledger verification FAILED:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log(
    `Crypto domain ledger OK: ${allCodeHkdf.size} HKDF info strings, ${allCodeAad.size} AAD scopes verified.`
  );
}

main();
