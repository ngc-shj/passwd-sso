#!/usr/bin/env node
/**
 * CI guard: ensure all HKDF info strings and AAD scopes in crypto-*.ts files
 * are documented in docs/security/crypto-domain-ledger.md.
 *
 * Refactor for split-overcrowded-feature-dirs: file discovery is now glob-based
 * so new crypto files under `src/lib/` or `src/lib/crypto/` (after the refactor)
 * are automatically included.
 *
 * Fails if:
 * - A HKDF info string in code is not in the ledger
 * - An AAD scope in code is not in the ledger
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Files that match the crypto-* prefix but contain only non-cryptographic
// helpers (no HKDF info, no AAD scopes). Adding to this list requires
// documented justification — see docs/security/crypto-domain-ledger.md.
const LEDGER_EXEMPT = new Set([
  "src/lib/crypto-blob.ts", // field-name helpers only (toBlobColumns, toOverviewColumns); no HKDF/AAD
]);

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

/**
 * Discover crypto files under src/lib (and subdirectories after refactor).
 * Pass 1: files matching crypto-*.ts prefix or export-crypto.ts.
 * Pass 2: any .ts/.tsx file under src/ that contains HKDF info-string tokens
 *         or AAD scope tokens but is not already in the scan set.
 */
function discoverCryptoFiles() {
  const scanSet = new Set();

  // Pass 1: glob src/lib for crypto-*.ts and export-crypto.ts
  let libEntries;
  try {
    libEntries = readdirSync(join(ROOT, "src/lib"), { recursive: true });
  } catch {
    libEntries = [];
  }
  for (const entry of libEntries) {
    if (typeof entry !== "string") continue;
    const basename = entry.split("/").pop();
    if (!/\.ts$/.test(basename)) continue;
    if (/^crypto-.*\.ts$/.test(basename) || basename === "export-crypto.ts") {
      const rel = `src/lib/${entry}`;
      if (!LEDGER_EXEMPT.has(rel)) {
        scanSet.add(rel);
      }
    }
  }

  // Pass 2: scan all .ts/.tsx under src/ for HKDF or AAD tokens.
  // HKDF info-string token: passwd-sso-<slug>-v<N> (versioned suffix distinguishes
  // real crypto info strings from DOM IDs, event names, or app labels that also
  // use the passwd-sso- prefix).
  // AAD scope token: SCOPE_xxx = "XX" or AAD_SCOPE_xxx = "XX".
  const hkdfTokenRe = /passwd-sso-[a-z0-9-]+-v\d+/;
  const aadTokenRe = /(?:SCOPE_|AAD_SCOPE_)\w+\s*=\s*["'][A-Z]{2}["']/;

  let srcEntries;
  try {
    srcEntries = readdirSync(join(ROOT, "src"), { recursive: true });
  } catch {
    srcEntries = [];
  }
  for (const entry of srcEntries) {
    if (typeof entry !== "string") continue;
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const rel = `src/${entry}`;
    if (LEDGER_EXEMPT.has(rel) || scanSet.has(rel)) continue;
    const filePath = join(ROOT, rel);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    if (hkdfTokenRe.test(content) || aadTokenRe.test(content)) {
      scanSet.add(rel);
    }
  }

  return [...scanSet].sort();
}

function main() {
  const cryptoFiles = discoverCryptoFiles();

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
      throw new Error(`Crypto file discovered but not readable: ${file}`);
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
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      throw new Error(`Crypto file discovered but not readable: ${file}`);
    }
    extractHkdfInfoStrings(content).forEach((s) => allCodeHkdf.add(s));
    extractAadScopes(content).forEach((s) => allCodeAad.add(s));
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
