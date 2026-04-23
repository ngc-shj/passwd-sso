#!/usr/bin/env node
/**
 * CI guard: on a refactor PR that edits scripts/check-bypass-rls.mjs,
 * enforce that any path change in the ALLOWED_USAGE map is a PURE rename
 * (identical model list) matched by a corresponding git mv in the same PR.
 *
 * Usage:
 *   node scripts/verify-allowlist-rename-only.mjs
 *
 * Expected CI context: run on a feature branch with main as base.
 * Exit 0 = OK, Exit 1 = violation found.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// PR 2: check-bypass-rls.mjs moved from scripts/ to scripts/checks/.
const TARGET_FILE = "scripts/checks/check-bypass-rls.mjs";

/**
 * Parse ALLOWED_USAGE map from source text using a line-based regex parser.
 * The map literal starts at: const ALLOWED_USAGE = new Map([
 * Each entry: ["path/to/file.ts", ["model1", "model2"]],
 */
function parseAllowedUsage(source) {
  const result = new Map();
  const startMarker = "const ALLOWED_USAGE = new Map([";
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) return result;

  // Extract map body up to the closing ]);
  const after = source.slice(startIdx + startMarker.length);
  const endIdx = after.indexOf("]);");
  const mapBody = endIdx !== -1 ? after.slice(0, endIdx) : after;

  // Match entries: ["some/path.ts", ["model1", "model2"]]
  const entryRe = /\[\s*"([^"]+)"\s*,\s*(\[[^\]]*\])\s*\]/g;
  // Duplicate-key detection: a malicious edit could add a second entry with
  // the same path but different models. new Map() silently keeps the LAST one,
  // bypassing model-set change detection. Fail loudly if any key appears twice.
  const seen = new Set();
  const duplicates = [];
  let match;
  while ((match = entryRe.exec(mapBody)) !== null) {
    const filePath = match[1];
    const modelsRaw = match[2];
    const models = [];
    const modelRe = /"([^"]+)"/g;
    let m;
    while ((m = modelRe.exec(modelsRaw)) !== null) {
      models.push(m[1]);
    }
    if (seen.has(filePath)) {
      duplicates.push(filePath);
    } else {
      seen.add(filePath);
    }
    result.set(filePath, models);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate path(s) in ALLOWED_USAGE: ${duplicates.join(", ")}. ` +
      `new Map() silently keeps the last duplicate, which could hide a model-set change. ` +
      `Reject and fail.`
    );
  }
  return result;
}

function modelsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Check if the target file was changed vs main
let diff = "";
try {
  diff = execSync(`git diff main -- ${TARGET_FILE}`, { encoding: "utf8" });
} catch {
  diff = "";
}

if (!diff.trim()) {
  console.log("verify-allowlist-rename-only: no changes to check, exit 0.");
  process.exit(0);
}

// Read main version
let mainSource = "";
try {
  mainSource = execSync(`git show main:${TARGET_FILE}`, { encoding: "utf8" });
} catch (e) {
  console.error(`Could not read main:${TARGET_FILE}: ${String(e)}`);
  process.exit(1);
}

// Read current working-tree version
let currentSource = "";
try {
  currentSource = readFileSync(TARGET_FILE, "utf8");
} catch (e) {
  console.error(`Could not read working-tree ${TARGET_FILE}: ${String(e)}`);
  process.exit(1);
}

let mainMap, currentMap;
try {
  mainMap = parseAllowedUsage(mainSource);
  currentMap = parseAllowedUsage(currentSource);
} catch (e) {
  console.error(`[verify-allowlist-rename-only] ${e.message}`);
  process.exit(1);
}

const mainKeys = new Set(mainMap.keys());
const currentKeys = new Set(currentMap.keys());

const removed = [...mainKeys].filter((k) => !currentKeys.has(k));
const added = [...currentKeys].filter((k) => !mainKeys.has(k));
const common = [...mainKeys].filter((k) => currentKeys.has(k));
const modified = common.filter((k) => !modelsEqual(mainMap.get(k), currentMap.get(k)));

// Get renamed files from git diff
let nameStatusOut = "";
try {
  // Use `-M main` (not `main...HEAD`) so uncommitted renames in the working
  // tree are visible. On CI (no uncommitted state) this behaves identically
  // to `main...HEAD`; locally it also catches pre-commit verification runs.
  nameStatusOut = execSync("git diff --name-status -M main", { encoding: "utf8" });
} catch {
  nameStatusOut = "";
}

// Parse rename lines: R<similarity>\t<from>\t<to>
// Accept both R (rename) and C (copy-rename under diff.renames=copies).
const renames = new Map();
for (const line of nameStatusOut.split("\n")) {
  const parts = line.split("\t");
  if (parts.length === 3 && (parts[0].startsWith("R") || parts[0].startsWith("C"))) {
    renames.set(parts[1], parts[2]);
  }
}

const errors = [];

// Model-list edits on unchanged keys are forbidden in a refactor PR
if (modified.length > 0) {
  for (const key of modified) {
    errors.push(
      `Model-list edit on unchanged path "${key}": ` +
      `main=[${(mainMap.get(key) ?? []).join(",")}] current=[${(currentMap.get(key) ?? []).join(",")}]. ` +
      `Model-set changes are not allowed in a refactor PR.`
    );
  }
}

// Each added path must pair with a removed path with identical models + git mv
const usedRemoved = new Set();
for (const addedKey of added) {
  const addedModels = currentMap.get(addedKey) ?? [];
  // Find matching removed key with identical model list
  const matchedRemoved = removed.find(
    (r) => !usedRemoved.has(r) && modelsEqual(mainMap.get(r) ?? [], addedModels)
  );
  if (!matchedRemoved) {
    errors.push(
      `New ALLOWED_USAGE key "${addedKey}" has no matching removed key with identical model list. ` +
      `Models: [${addedModels.join(",")}]. ` +
      `Removed keys: [${removed.map((r) => `${r}=[${(mainMap.get(r) ?? []).join(",")}]`).join("; ")}]`
    );
    continue;
  }
  // Verify git mv: renames map should have matchedRemoved -> addedKey
  const gitTo = renames.get(matchedRemoved);
  if (gitTo !== addedKey) {
    errors.push(
      `ALLOWED_USAGE rename "${matchedRemoved}" -> "${addedKey}" not matched by git mv. ` +
      `git diff shows "${matchedRemoved}" -> "${gitTo ?? "(not found)"}".`
    );
  } else {
    usedRemoved.add(matchedRemoved);
  }
}

// Removed keys not consumed by a rename pairing
const unpaired = removed.filter((r) => !usedRemoved.has(r));
for (const r of unpaired) {
  errors.push(
    `ALLOWED_USAGE key "${r}" was removed without a corresponding added key. ` +
    `Either add the new path or revert the removal.`
  );
}

if (errors.length > 0) {
  console.error("[verify-allowlist-rename-only] FAILED:");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(
  `ALLOWED_USAGE rename-only OK: ${added.length} renames, 0 model-set edits.`
);
