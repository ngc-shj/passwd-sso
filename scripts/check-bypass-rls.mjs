#!/usr/bin/env node
/**
 * CI guard: ensure withBypassRls is only called from an approved allowlist.
 *
 * Any new usage of withBypassRls must be explicitly added to ALLOWED_FILES
 * after security review. This prevents accidental RLS bypass in new code.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

// Files allowed to call withBypassRls (relative to repo root).
// Test files (*.test.ts) are always allowed (mocks only).
const ALLOWED_FILES = new Set([
  "src/lib/tenant-rls.ts", // definition
  "src/lib/tenant-context.ts", // resolveUserTenantId wrapper
  "src/lib/auth-adapter.ts", // bootstrap tenant creation
  "src/auth.ts", // tenant lookup + membership
  "src/lib/audit.ts", // audit log writing
  "src/lib/scim-token.ts", // SCIM token validation
  "src/lib/extension-token.ts", // extension token validation
  "src/app/api/admin/rotate-master-key/route.ts", // admin key rotation
  "src/app/api/teams/route.ts", // cross-tenant team list
  "src/app/api/teams/archived/route.ts", // cross-tenant archived teams
  "src/app/api/teams/favorites/route.ts", // cross-tenant favorite teams
  "src/app/api/teams/trash/route.ts", // cross-tenant trashed teams
  "src/app/api/teams/pending-key-distributions/route.ts", // cross-tenant key distribution
  "src/app/api/teams/[teamId]/members/route.ts", // member tenant lookup
  "src/app/api/teams/invitations/accept/route.ts", // cross-tenant invitation accept
]);

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

const violations = [];

for (const file of getSourceFiles()) {
  // Skip test files — they mock withBypassRls, not call it for real
  if (file.includes(".test.") || file.includes("__tests__")) continue;

  const content = readFileSync(file, "utf8");
  if (!content.includes("withBypassRls")) continue;

  if (!ALLOWED_FILES.has(file)) {
    violations.push(file);
  }
}

if (violations.length > 0) {
  console.error(
    "withBypassRls usage found in files not on the allowlist.",
  );
  console.error(
    "Add the file to ALLOWED_FILES in scripts/check-bypass-rls.mjs after security review.",
  );
  console.error("");
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}

console.log("check-bypass-rls: OK");
