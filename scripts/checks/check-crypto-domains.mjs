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
 * - buildAADBytes or the inline length-prefix idiom appears outside the registry
 *   allowlist (Check A — AAD encoder containment)
 * - An AEAD-with-AAD site (additionalData / .setAAD) appears outside the
 *   declared primitive allowlist (Check B — C12)
 * - Any code AAD scope lacks a manifest entry, or any manifest entry's test
 *   files are missing (Check C — C16 bidirectional coverage)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// PR 2: moved from scripts/ to scripts/checks/ — bump one extra level up.
const ROOT = new URL("../..", import.meta.url).pathname;

// Files that match the crypto-* prefix but contain only non-cryptographic
// helpers (no HKDF info, no AAD scopes). Adding to this list requires
// documented justification — see docs/security/crypto-domain-ledger.md.
const LEDGER_EXEMPT = new Set([
  "src/lib/crypto/crypto-blob.ts", // field-name helpers only (toBlobColumns, toOverviewColumns); no HKDF/AAD
]);

// ── Check A: AAD encoder containment allowlist ────────────────────────────────
// Only these files may define or call buildAADBytes, or use the inline
// length-prefix DataView/setUint16 idiom that replicates the encoder.
//
// Rationale per entry:
//   crypto-aad.ts       — the single app-side AAD registry; buildAADBytes lives here.
//   extension/crypto.ts — extension bundle (separate JS heap); byte-parity guarded
//                         by aad-parity.test.ts (PV scope).
//   extension/crypto-team.ts — extension bundle; byte-parity guarded for OV/IK/OK.
const AAD_ENCODER_ALLOWLIST = new Set([
  "src/lib/crypto/crypto-aad.ts",
  "extension/src/lib/crypto.ts",
  "extension/src/lib/crypto-team.ts",
]);

// ── Check B: AEAD-with-AAD primitive allowlist (C12) ─────────────────────────
// Only these files may perform AEAD operations that bind AAD (either Web Crypto
// additionalData or Node crypto setAAD).
//
// Rationale per entry:
//   crypto-client.ts      — app primitive for personal vault + entry encryption.
//   crypto-team.ts        — team wrap/unwrap (wrapItemKey, wrapTeamKeyForMember,
//                           4 sites); delegates entry encrypt/decrypt to crypto-client.
//   crypto-emergency.ts   — ECDH key-escrow wrap (2 sites, EM scope).
//   crypto-server.ts      — Node crypto AES-256-GCM for server-side secrets
//                           (webhook, account-token); uses setAAD.
//   envelope.ts           — shared server-side encryption envelope; uses setAAD.
//   extension/crypto.ts   — extension primitive (additionalData, PV scope).
//   extension/crypto-team.ts — extension primitive (additionalData, OV/IK/OK).
const AEAD_AAD_ALLOWLIST = new Set([
  "src/lib/crypto/crypto-client.ts",
  "src/lib/crypto/crypto-team.ts",
  "src/lib/crypto/crypto-emergency.ts",
  "src/lib/crypto/crypto-server.ts",
  "src/lib/crypto/envelope.ts",
  "extension/src/lib/crypto.ts",
  "extension/src/lib/crypto-team.ts",
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

// Crypto directories where string-delimited AAD (e.g. .join("|")) is a
// regression indicator — all AAD in these dirs is now binary.
const CRYPTO_DIRS = [
  "src/lib/crypto/",
  "extension/src/lib/",
];

/**
 * Check A — AAD encoder containment.
 *
 * Flags any non-test .ts/.tsx file under src/ or extension/src/ that:
 *   - calls buildAADBytes(  (referencing the private encoder by name), OR
 *   - uses the inline length-prefix idiom: setUint16(<expr>, false)
 *     (the big-endian field-length write that replicates the encoder header), OR
 *   - uses a single-char-delimiter .join("|") / .join(":") in a crypto dir
 *     (string-delimited AAD reformat regression — all AAD is now binary)
 * … EXCEPT files in the AAD_ENCODER_ALLOWLIST.
 *
 * Comment/block-comment lines are stripped before matching (mirror
 * extractHkdfInfoStrings). Test files (*.test.* / __tests__/) are excluded.
 *
 * @param {Array<{rel: string, content: string}>} files - {rel, content} pairs
 * @returns {string[]} error messages
 */
export function checkAadEncoderContainment(files) {
  const errors = [];
  // setUint16 with a second arg of `false` (explicit big-endian) is the
  // distinctive marker for the inline length-prefix idiom used in the encoder.
  const encoderPatterns = [
    /\bbuildAADBytes\s*\(/,
    /\.setUint16\s*\([^)]*,\s*false\s*\)/,
  ];
  // String-delimited AAD: a single-char delimiter join in a crypto module
  // signals a reformat regression back to the old "|"-joined format.
  const stringJoinPattern = /\.join\s*\(\s*["'][|:]["']\s*\)/;

  for (const { rel, content } of files) {
    if (AAD_ENCODER_ALLOWLIST.has(rel)) continue;
    // Strip comment lines before matching (// lines, * block-comment lines,
    // and /* block-comment openers)
    const activeLines = content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return (
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("/*")
        );
      })
      .join("\n");
    for (const pat of encoderPatterns) {
      if (pat.test(activeLines)) {
        errors.push(
          `Check A: AAD encoder idiom (${pat}) found in non-registry file: ${rel}`
        );
        break; // one error per file
      }
    }
    // String-join check: only fires for crypto-dir files
    const inCryptoDir = CRYPTO_DIRS.some((dir) => rel.startsWith(dir));
    if (inCryptoDir && stringJoinPattern.test(activeLines)) {
      errors.push(
        `Check A: string-delimited AAD idiom (.join("|") or .join(":")) found in crypto module: ${rel} — AAD must be binary`
      );
    }
  }
  return errors;
}

/**
 * Check B — AEAD-with-AAD allowlist (C12).
 *
 * Flags any non-test .ts/.tsx file under src/ or extension/src/ that:
 *   - uses Web Crypto additionalData  (object property in AES-GCM params), OR
 *   - calls Node crypto .setAAD(      (cipher/decipher method)
 * … EXCEPT files in the AEAD_AAD_ALLOWLIST.
 *
 * Comment/block-comment lines are stripped before matching.
 * Test files (*.test.* / __tests__/) are excluded.
 *
 * @param {Array<{rel: string, content: string}>} files - {rel, content} pairs
 * @returns {string[]} error messages
 */
export function checkAeadAadAllowlist(files) {
  const errors = [];
  const aeadPatterns = [
    /\badditionalData\s*[=:]/,   // additionalData: or additionalData =
    /\.setAAD\s*\(/,             // Node crypto cipher/decipher .setAAD(
  ];

  for (const { rel, content } of files) {
    if (AEAD_AAD_ALLOWLIST.has(rel)) continue;
    // Strip comment lines before matching
    const activeLines = content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*");
      })
      .join("\n");
    for (const pat of aeadPatterns) {
      if (pat.test(activeLines)) {
        errors.push(
          `Check B: AEAD-with-AAD site (${pat}) found outside allowlist: ${rel}`
        );
        break; // one error per file
      }
    }
  }
  return errors;
}

/**
 * Check E — keyVersion hardcode guard.
 *
 * Flags any non-test .ts/.tsx file under src/ or extension/src/ that contains
 * a `keyVersion: <digit>` literal — case-sensitive lowercase `keyVersion`.
 * This pattern does NOT match `teamKeyVersion`, `itemKeyVersion`, or
 * `cekKeyVersion` (those have an uppercase K after the prefix).
 *
 * The two allowlisted files are legitimate key-material-creation sites where a
 * literal version is correct by design:
 *   - vault/setup:  a brand-new vault's first personal key is always v1.
 *   - vault-reset:  a reset baseline personal key starts at v0.
 *
 * All other sites MUST thread the version from the in-memory key (client-held),
 * because under concurrent rotation the server's users.key_version may be ahead
 * of the client's stale in-memory key.
 *
 * Comment/block-comment lines are stripped before matching (mirror existing checks).
 *
 * @param {Array<{rel: string, content: string}>} files - {rel, content} pairs
 * @returns {string[]} error messages
 */
export function checkKeyVersionHardcode(files) {
  // Sites where a literal keyVersion is correct by design.
  const KEY_VERSION_HARDCODE_ALLOWLIST = new Set([
    "src/app/api/vault/setup/route.ts",   // brand-new vault: first key is v1
    "src/lib/vault/vault-reset.ts",        // reset baseline: key starts at v0
  ]);

  // Matches `keyVersion: <digit>` as an object property (not a ternary colon).
  // Requires that `keyVersion` is preceded only by whitespace or a comma/brace —
  // i.e. it appears in object-literal position, not after `data.keyVersion`.
  // This avoids false positives from ternary expressions like `... ? data.keyVersion : 1`.
  const keyVersionLiteralRe = /(?:^|[,{])\s*keyVersion\s*:\s*\d/m;
  const errors = [];

  for (const { rel, content } of files) {
    if (KEY_VERSION_HARDCODE_ALLOWLIST.has(rel)) continue;
    const activeLines = content
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*");
      })
      .join("\n");
    if (keyVersionLiteralRe.test(activeLines)) {
      errors.push(
        `Check E: hardcoded keyVersion literal found in non-allowlisted file: ${rel} — thread the live key version instead`
      );
    }
  }
  return errors;
}

/**
 * Check D — iOS golden-vector anti-drift (Node-gate, no Xcode required).
 *
 * For each entry in aad-golden-vectors.json (skipping `_`-prefixed keys):
 *   1. Asserts the hex literal appears in the app parity test
 *      (src/__tests__/aad-parity.test.ts) — confirms the TS side is pinned.
 *   2. When the entry has `ios: true`, converts the hex to the Swift
 *      `[0xNN, 0xNN, ...]` byte-array form and asserts that comma-joined
 *      sequence appears in the iOS parity test
 *      (ios/PasswdSSOTests/AADParityTests.swift) — confirms the Swift side
 *      is pinned to the same bytes. Whitespace/newlines between bytes are
 *      tolerated on both sides before comparison.
 *      When `ios: false`, the iOS check is skipped (scope not implemented
 *      on iOS, e.g. OK which is app+extension only).
 *
 * This check runs in main CI (Node only). iOS CI (Xcode) separately verifies
 * that the builder actually produces those bytes at runtime.
 *
 * @param {{ goldenJson: Object, appParityContent: string, iosParityContent: string }} opts
 * @returns {string[]} error messages
 */
export function checkIosGoldenParity({ goldenJson, appParityContent, iosParityContent }) {
  const errors = [];

  // Normalize the iOS file for substring matching:
  //   1. Strip inline // comments from each line (comments break contiguous
  //      byte sequences like "0x50, 0x56,  // "PV"\n      0x01," which would
  //      otherwise not match "0x50, 0x56, 0x01").
  //   2. Collapse whitespace/newlines around commas to a canonical comma-space form.
  const normalizeIos = (content) =>
    content
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))  // strip // comments
      .join(" ")
      .replace(/\s*,\s*/g, ", ")   // normalize comma spacing
      .replace(/\s+/g, " ");       // collapse remaining whitespace

  const normalizedIos = normalizeIos(iosParityContent);

  for (const [key, entry] of Object.entries(goldenJson)) {
    if (key.startsWith("_")) continue;
    const { hex, ios } = entry;

    // 1. App parity: the raw hex string must appear literally in the TS file
    //    for every vector, regardless of ios flag.
    if (!appParityContent.includes(hex)) {
      errors.push(
        `Check D: golden vector "${key}" hex "${hex}" not found in app parity test (src/__tests__/aad-parity.test.ts)`
      );
    }

    // 2. iOS parity: only check when ios: true.
    //    Vectors with ios: false are not implemented on iOS — skip.
    if (ios === true) {
      const swiftBytes = hex
        .match(/.{2}/g)
        .map((b) => `0x${b}`)
        .join(", ");

      if (!normalizedIos.includes(swiftBytes)) {
        errors.push(
          `Check D: golden vector "${key}" Swift bytes "${swiftBytes}" not found in iOS parity test (ios/PasswdSSOTests/AADParityTests.swift)`
        );
      }
    }
  }

  return errors;
}

/**
 * Check C — per-scope test coverage via manifest (C16).
 *
 * Bidirectionally enforces:
 *   (a) every AAD scope found in code has a manifest entry, and
 *       every manifest scope exists in code;
 *   (b) for each manifest entry, the roundTrip file exists on disk;
 *       if crossCodebase is true, the parity file must also exist.
 *
 * @param {Set<string>} codeScopes - scopes found in code (from extractAadScopes)
 * @param {Object} manifest - parsed aad-scope-manifest.json
 * @param {string} root - repository root path (for fs.existsSync resolution)
 * @returns {string[]} error messages
 */
export function checkScopeManifest(codeScopes, manifest, root) {
  const errors = [];
  const manifestScopes = new Set(Object.keys(manifest));

  // (a) bidirectional scope membership
  for (const scope of codeScopes) {
    if (!manifestScopes.has(scope)) {
      errors.push(
        `Check C: code AAD scope "${scope}" has no entry in aad-scope-manifest.json`
      );
    }
  }
  for (const scope of manifestScopes) {
    if (!codeScopes.has(scope)) {
      errors.push(
        `Check C: manifest scope "${scope}" not found in code — stale entry`
      );
    }
  }

  // (b) file existence for each manifest entry
  for (const [scope, entry] of Object.entries(manifest)) {
    const rtPath = join(root, entry.roundTrip);
    if (!existsSync(rtPath)) {
      errors.push(
        `Check C: manifest scope "${scope}" roundTrip file not found: ${entry.roundTrip}`
      );
    }
    if (entry.crossCodebase) {
      if (!entry.parity) {
        errors.push(
          `Check C: manifest scope "${scope}" is crossCodebase but has no parity field`
        );
      } else {
        const parityPath = join(root, entry.parity);
        if (!existsSync(parityPath)) {
          errors.push(
            `Check C: manifest scope "${scope}" parity file not found: ${entry.parity}`
          );
        }
      }
    }
  }

  return errors;
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

/**
 * Collect non-test .ts/.tsx files under src/ and extension/src/ for
 * structural checks (A and B).
 */
function collectStructuralFiles() {
  const files = [];
  const roots = ["src", "extension/src"];

  for (const base of roots) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, base), { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // Exclude test files
      if (/\.test\.|__tests__\//.test(entry)) continue;
      const rel = `${base}/${entry}`;
      const filePath = join(ROOT, rel);
      let content;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      files.push({ rel, content });
    }
  }
  return files;
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

  // ── Check A: AAD encoder containment ───────────────────────────────────────
  const structuralFiles = collectStructuralFiles();
  const checkAErrors = checkAadEncoderContainment(structuralFiles);
  errors.push(...checkAErrors);

  // ── Check B: AEAD-with-AAD allowlist ───────────────────────────────────────
  const checkBErrors = checkAeadAadAllowlist(structuralFiles);
  errors.push(...checkBErrors);

  // ── Check E: keyVersion hardcode guard ─────────────────────────────────────
  const checkEErrors = checkKeyVersionHardcode(structuralFiles);
  errors.push(...checkEErrors);

  // ── Check C: per-scope manifest coverage ───────────────────────────────────
  const manifestPath = join(ROOT, "scripts/checks/aad-scope-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    errors.push("Check C: aad-scope-manifest.json not found or not valid JSON");
    manifest = null;
  }
  if (manifest !== null) {
    const checkCErrors = checkScopeManifest(allCodeAad, manifest, ROOT);
    errors.push(...checkCErrors);
  }

  // ── Check D: iOS golden-vector anti-drift ──────────────────────────────────
  const goldenPath = join(ROOT, "scripts/checks/aad-golden-vectors.json");
  const appParityPath = join(ROOT, "src/__tests__/aad-parity.test.ts");
  const iosParityPath = join(ROOT, "ios/PasswdSSOTests/AADParityTests.swift");

  let goldenJson, appParityContent, iosParityContent;
  let checkDSkipped = false;
  try {
    goldenJson = JSON.parse(readFileSync(goldenPath, "utf-8"));
  } catch {
    errors.push("Check D: aad-golden-vectors.json not found or not valid JSON at " + goldenPath);
    checkDSkipped = true;
  }
  if (!checkDSkipped) {
    try {
      appParityContent = readFileSync(appParityPath, "utf-8");
    } catch {
      errors.push("Check D: app parity test not found at " + appParityPath);
      checkDSkipped = true;
    }
  }
  if (!checkDSkipped) {
    try {
      iosParityContent = readFileSync(iosParityPath, "utf-8");
    } catch {
      errors.push("Check D: iOS parity test not found at " + iosParityPath);
      checkDSkipped = true;
    }
  }
  if (!checkDSkipped) {
    const checkDErrors = checkIosGoldenParity({ goldenJson, appParityContent, iosParityContent });
    errors.push(...checkDErrors);
  }

  if (errors.length > 0) {
    console.error("Crypto domain ledger verification FAILED:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  const goldenCount = Object.keys(goldenJson).filter((k) => !k.startsWith("_")).length;
  console.log(
    `Crypto domain ledger OK: ${allCodeHkdf.size} HKDF info strings, ${allCodeAad.size} AAD scopes verified.`
  );
  console.log(`  Check A: AAD encoder containment OK`);
  console.log(`  Check B: AEAD-with-AAD allowlist OK`);
  console.log(`  Check C: scope manifest coverage OK (${manifest ? Object.keys(manifest).length : 0} scopes)`);
  console.log(`  Check D: iOS golden-vector parity OK (${goldenCount} vectors, app + iOS pinned)`);
  console.log(`  Check E: keyVersion hardcode guard OK`);
}

main();
