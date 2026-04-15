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
  ["src/lib/audit-outbox.ts", ["auditOutbox"]],
  ["src/lib/audit-user-lookup.ts", ["user"]],
  ["src/lib/scim-token.ts", ["scimToken"]],
  ["src/lib/extension-token.ts", ["extensionToken"]],
  ["src/app/api/extension/bridge-code/route.ts", ["extensionBridgeCode"]],
  ["src/app/api/extension/token/exchange/route.ts", ["extensionBridgeCode"]],
  ["src/app/api/admin/rotate-master-key/route.ts", ["user", "passwordShare"]],
  ["src/app/api/maintenance/purge-history/route.ts", ["tenantMember", "passwordEntryHistory"]],
  ["src/app/api/teams/route.ts", ["teamMember"]],
  ["src/app/api/teams/pending-key-distributions/route.ts", ["teamMember"]],
  ["src/app/api/teams/[teamId]/members/route.ts", ["tenantMember"]],
  ["src/app/api/teams/invitations/accept/route.ts", ["teamInvitation"]],
  ["src/lib/account-lockout.ts", ["user", "tenant", "auditOutbox"]],
  ["src/lib/lockout-admin-notify.ts", ["user", "tenantMember"]],
  ["src/lib/new-device-detection.ts", ["session", "user"]],
  ["src/lib/notification.ts", ["user", "notification"]],
  ["src/lib/webhook-dispatcher.ts", ["teamWebhook", "tenantWebhook"]],
  ["src/lib/tenant-auth.ts", ["tenantMember"]],
  // Admin console: cross-tenant team membership query for scope selector
  ["src/lib/team-auth.ts", ["teamMember"]],
  ["src/lib/vault-reset.ts", ["*"]], // vault wipe: deletes across many tables in $transaction
  ["src/app/api/vault/admin-reset/route.ts", ["adminVaultReset"]],
  ["src/lib/api-key.ts", ["apiKey"]],
  ["src/lib/webauthn-authorize.ts", ["webAuthnCredential"]],
  ["src/app/api/auth/passkey/verify/route.ts", ["user", "session"]],
  ["src/app/api/auth/passkey/options/email/route.ts", ["user", "webAuthnCredential"]],
  ["src/lib/user-session-invalidation.ts", ["session", "extensionToken", "apiKey"]],
  ["src/app/api/tenant/policy/route.ts", ["user", "tenant"]],
  ["src/lib/access-restriction.ts", ["tenant"]],
  ["src/lib/team-policy.ts", ["teamMember", "teamPolicy", "tenant"]],
  ["src/app/api/maintenance/purge-audit-logs/route.ts", ["tenantMember", "tenant", "auditLog"]],
  ["src/app/api/maintenance/audit-outbox-metrics/route.ts", ["tenantMember"]],
  ["src/app/api/maintenance/audit-outbox-purge-failed/route.ts", ["tenantMember"]],
  ["src/app/api/maintenance/audit-chain-verify/route.ts", ["tenantMember"]],
  ["src/app/api/user/passkey-status/route.ts", ["webAuthnCredential", "user"]],
  ["src/app/api/share-links/route.ts", ["auditOutbox"]], // logAuditInTx for SHARE_CREATE
  ["src/app/api/share-links/[id]/route.ts", ["auditOutbox"]], // logAuditInTx for SHARE_REVOKE
  ["src/app/api/share-links/verify-access/route.ts", ["passwordShare"]],
  ["src/app/api/share-links/[id]/content/route.ts", ["passwordShare", "shareAccessLog"]],
  ["src/app/s/[token]/page.tsx", ["passwordShare", "shareAccessLog"]],
  ["src/app/s/[token]/download/route.ts", ["passwordShare", "shareAccessLog"]],
  // Emergency access: cross-tenant grantee look-ups require RLS bypass
  ["src/app/api/emergency-access/route.ts", ["emergencyAccessGrant", "user"]],
  ["src/app/api/emergency-access/accept/route.ts", ["emergencyAccessGrant", "emergencyAccessKeyPair", "user"]],
  ["src/app/api/emergency-access/reject/route.ts", ["emergencyAccessGrant", "user"]],
  ["src/app/api/emergency-access/[id]/accept/route.ts", ["emergencyAccessGrant", "emergencyAccessKeyPair", "user"]],
  ["src/app/api/emergency-access/[id]/approve/route.ts", ["user"]],
  ["src/app/api/emergency-access/[id]/decline/route.ts", ["emergencyAccessGrant", "user"]],
  ["src/app/api/emergency-access/[id]/request/route.ts", ["emergencyAccessGrant", "user"]],
  ["src/app/api/emergency-access/[id]/revoke/route.ts", ["user"]],
  ["src/app/api/emergency-access/[id]/vault/route.ts", ["emergencyAccessGrant"]],
  ["src/app/api/emergency-access/[id]/vault/entries/route.ts", ["emergencyAccessGrant", "passwordEntry"]],
  // Machine Identity: SA token validation + MCP Gateway operate cross-tenant by design
  ["src/lib/service-account-token.ts", ["serviceAccountToken"]],
  ["src/lib/mcp/oauth-server.ts", ["mcpAuthorizationCode", "mcpAccessToken", "mcpRefreshToken"]],
  ["src/app/api/mcp/authorize/route.ts", ["mcpClient", "user"]],
  ["src/app/api/mcp/register/route.ts", ["mcpClient"]],
  ["src/app/api/mcp/authorize/consent/route.ts", ["mcpClient", "user"]],
  ["src/app/[locale]/mcp/authorize/page.tsx", ["mcpClient", "user"]],
  ["src/app/api/maintenance/dcr-cleanup/route.ts", ["mcpClient", "tenantMember"]],
  // JIT access requests: SA self-service path uses bypass for SA lookup; approve reads tenant policy
  ["src/app/api/tenant/access-requests/route.ts", ["serviceAccount", "accessRequest"]],
  ["src/app/api/tenant/access-requests/[id]/approve/route.ts", ["tenant"]],
  // Delegated Decryption: cross-tenant session lookup + delegation CRUD
  ["src/lib/delegation.ts", ["delegationSession"]],
  ["src/app/api/vault/delegation/route.ts", ["mcpAccessToken", "tenant", "passwordEntry", "delegationSession"]],
  ["src/app/api/vault/delegation/check/route.ts", ["delegationSession"]],
  // MCP Connections: user's own token listing + revocation (userId + tenantId in WHERE)
  ["src/app/api/user/mcp-tokens/route.ts", ["mcpAccessToken", "mcpClient"]],
  ["src/app/api/user/mcp-tokens/[id]/route.ts", ["mcpAccessToken", "mcpRefreshToken", "delegationSession", "auditLog"]],
  // Auth provider check: userId-scoped Account query for passkey sign-in capability
  ["src/app/api/user/auth-provider/route.ts", ["account"]],
]);

// Regex to match prisma model access: prisma.modelName.method(...) or tx.modelName.method(...)
// Captures the model name (e.g., "tenant" from "prisma.tenant.findUnique" or "tx.session.create").
// tx is the transaction client inside prisma.$transaction(async (tx) => { ... }) — when nested
// inside withBypassRls, tx inherits the bypass context via the Proxy.
const PRISMA_MODEL_RE = /(?:prisma|tx)\.(\w+)\./g;

// Regex to find withBypassRls call sites (not imports).
const BYPASS_CALL_RE = /withBypassRls\s*\(/;

// Regex to verify BYPASS_PURPOSE constant is used (not a string literal).
const BYPASS_PURPOSE_RE = /BYPASS_PURPOSE\.\w+/;

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
const purposeViolations = [];

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

  // Check 2: file must use BYPASS_PURPOSE constant (not string literals)
  // The definition file (tenant-rls.ts) is exempt — it defines, not consumes.
  if (file !== "src/lib/tenant-rls.ts" && !BYPASS_PURPOSE_RE.test(content)) {
    purposeViolations.push({ file, line: 0 });
  }

  // Check 3: scan each call site for prisma model references and purpose constant
  const lines = content.split("\n");
  const allowedSet = allowedModels.includes("*") ? null : new Set(allowedModels);

  for (let i = 0; i < lines.length; i++) {
    if (!BYPASS_CALL_RE.test(lines[i])) continue;

    // Scan forward from the call site
    const end = Math.min(i + SCAN_RADIUS, lines.length);

    // Check 3b: model allowlist (skip for wildcard files)
    if (!allowedSet) continue;
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

if (purposeViolations.length > 0) {
  failed = true;
  if (fileViolations.length > 0 || modelViolations.length > 0) console.error("");
  console.error(
    "withBypassRls call sites missing BYPASS_PURPOSE constant.",
  );
  console.error(
    "Use BYPASS_PURPOSE.* from @/lib/tenant-rls instead of string literals.",
  );
  console.error("");
  for (const { file, line } of purposeViolations) {
    console.error(`  ${file}:${line}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-bypass-rls: OK");
