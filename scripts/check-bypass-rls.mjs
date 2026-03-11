#!/usr/bin/env node
/**
 * CI guard: ensure withBypassRls is only called from approved files,
 * and only accesses approved Prisma models within each file.
 *
 * Any new usage of withBypassRls must be explicitly added to ALLOWED_USAGE
 * after security review. This prevents accidental RLS bypass in new code.
 *
 * For each withBypassRls call site, the script scans the surrounding lines
 * (up to SCAN_RADIUS lines after) for `prisma.<model>` references and
 * verifies they are in the per-file allowlist.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

// Lines to scan after each withBypassRls call for prisma model references.
const SCAN_RADIUS = 10;

// Per-file allowlist: file path → allowed Prisma model names.
// "*" means any model is allowed (use sparingly, only for definitions or
// complex transactional code that touches many models by design).
const ALLOWED_USAGE = new Map([
  ["src/lib/tenant-rls.ts", ["*"]], // definition
  ["src/lib/tenant-context.ts", ["tenantMember", "team"]],
  ["src/lib/auth-adapter.ts", ["session", "user", "tenant", "account", "tenantMember"]],
  ["src/auth.ts", ["*"]], // session callbacks: tenant, user, membership, vault reset ($transaction)
  ["src/lib/audit.ts", ["team", "user", "auditLog"]],
  ["src/lib/scim-token.ts", ["scimToken"]],
  ["src/lib/extension-token.ts", ["extensionToken"]],
  ["src/app/api/admin/rotate-master-key/route.ts", ["user"]],
  ["src/app/api/teams/route.ts", ["teamMember", "team"]],
  ["src/app/api/teams/archived/route.ts", ["teamMember", "teamPasswordEntry"]],
  ["src/app/api/teams/favorites/route.ts", ["teamMember", "teamPasswordFavorite"]],
  ["src/app/api/teams/trash/route.ts", ["teamMember", "teamPasswordEntry"]],
  ["src/app/api/teams/pending-key-distributions/route.ts", ["teamMember"]],
  ["src/app/api/teams/[teamId]/members/route.ts", ["tenantMember"]],
  ["src/app/api/teams/invitations/accept/route.ts", ["teamInvitation"]],
  ["src/lib/new-device-detection.ts", ["session", "user"]],
  ["src/lib/notification.ts", ["user", "notification"]],
  ["src/lib/webhook-dispatcher.ts", ["teamWebhook"]],
  ["src/lib/tenant-auth.ts", ["tenantMember"]],
  ["src/lib/vault-reset.ts", ["*"]], // vault wipe: deletes across many tables in $transaction
  ["src/app/api/vault/admin-reset/route.ts", ["adminVaultReset"]],
  ["src/lib/api-key.ts", ["apiKey"]],
  ["src/lib/webauthn-authorize.ts", ["webAuthnCredential"]],
  ["src/app/api/auth/passkey/verify/route.ts", ["user"]],
  ["src/app/api/auth/passkey/options/email/route.ts", ["user", "webAuthnCredential"]],
  ["src/lib/user-session-invalidation.ts", ["session", "extensionToken", "apiKey"]],
  ["src/app/api/tenant/policy/route.ts", ["user", "tenant"]],
  ["src/lib/access-restriction.ts", ["tenant"]],
  ["src/app/api/share-links/verify-access/route.ts", ["passwordShare"]],
  ["src/app/api/share-links/[id]/content/route.ts", ["passwordShare", "shareAccessLog"]],
]);

// Regex to match prisma model access: prisma.modelName.method(...)
// Captures the model name (e.g., "tenant" from "prisma.tenant.findUnique").
const PRISMA_MODEL_RE = /prisma\.(\w+)\./g;

// Regex to find withBypassRls call sites (not imports).
const BYPASS_CALL_RE = /withBypassRls\s*\(/;

function getSourceFiles() {
  const files = [];
  for (const entry of readdirSync("src", { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== ".ts" && ext !== ".tsx") continue;
    files.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return files;
}

const fileViolations = [];
const modelViolations = [];

for (const file of getSourceFiles()) {
  // Skip test files — they mock withBypassRls, not call it for real
  if (file.includes(".test.") || file.includes("__tests__")) continue;

  const content = readFileSync(file, "utf8");
  if (!BYPASS_CALL_RE.test(content)) continue;

  const allowedModels = ALLOWED_USAGE.get(file);

  // Check 1: file must be in the allowlist
  if (!allowedModels) {
    fileViolations.push(file);
    continue;
  }

  // Check 2: wildcard — skip model checking for this file
  if (allowedModels.includes("*")) continue;

  // Check 3: scan each call site for prisma model references
  const lines = content.split("\n");
  const allowedSet = new Set(allowedModels);

  for (let i = 0; i < lines.length; i++) {
    if (!BYPASS_CALL_RE.test(lines[i])) continue;

    // Scan forward from the call site
    const end = Math.min(i + SCAN_RADIUS, lines.length);
    for (let j = i; j < end; j++) {
      let match;
      while ((match = PRISMA_MODEL_RE.exec(lines[j])) !== null) {
        const model = match[1];
        // Skip prisma client meta-properties
        if (model.startsWith("$")) continue;
        if (!allowedSet.has(model)) {
          modelViolations.push({ file, line: j + 1, model });
        }
      }
    }
  }
}

let failed = false;

if (fileViolations.length > 0) {
  failed = true;
  console.error(
    "withBypassRls usage found in files not on the allowlist.",
  );
  console.error(
    "Add the file to ALLOWED_USAGE in scripts/check-bypass-rls.mjs after security review.",
  );
  console.error("");
  for (const v of fileViolations) {
    console.error(`  ${v}`);
  }
}

if (modelViolations.length > 0) {
  failed = true;
  if (fileViolations.length > 0) console.error("");
  console.error(
    "withBypassRls accesses Prisma models not on the per-file allowlist.",
  );
  console.error(
    "Add the model to the file's entry in ALLOWED_USAGE after security review.",
  );
  console.error("");
  for (const { file, line, model } of modelViolations) {
    console.error(`  ${file}:${line}  prisma.${model}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-bypass-rls: OK");
