#!/usr/bin/env node
/**
 * CI guard: ensure withBypassRls is only called from approved files,
 * and only accesses approved Prisma models within each file.
 *
 * Any new usage of withBypassRls must be explicitly added to ALLOWED_USAGE
 * after security review. This prevents accidental RLS bypass in new code.
 *
 * Call sites and their `prisma.<model>` / `tx.<model>` references are read from
 * the parse tree (ts-morph, no Program), so a call's extent is exact and
 * comments, strings and regex literals are out of scope structurally. SCAN_RADIUS
 * survives only for the tx-less-callback text check, which is a line-shape rule.
 */
import { SyntaxKind } from "ts-morph";
import { createAstProject } from "./lib/ast-project.mjs";
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
  ["src/lib/auth/session/auth-adapter.ts", ["session", "user", "tenant", "account", "tenantMember"]],
  ["src/auth.ts", ["*"]], // session callbacks: tenant, user, membership, vault reset ($transaction)
  ["src/lib/audit/audit.ts", ["team", "user", "auditLog"]],
  ["src/lib/audit/audit-outbox.ts", ["auditOutbox"]],
  ["src/lib/audit/audit-user-lookup.ts", ["user"]],
  ["src/lib/auth/tokens/scim-token.ts", ["scimToken"]],
  ["src/lib/auth/tokens/extension-token.ts", ["extensionToken", "tenant", "tenantMember"]],
  // C5: shared DPoP validate helper for IOS_APP + BROWSER_EXTENSION rows.
  // Updates lastUsedAt / lastUsedIp / lastUsedUserAgent on the resolved row.
  ["src/lib/auth/dpop/validate-token-dpop.ts", ["extensionToken"]],
  // C12: user-initiated key reset revokes the calling user's cnfJkt-bound
  // ExtensionToken rows (after body-cnfJkt-must-match-proof check).
  ["src/app/api/extension/key/reset/route.ts", ["extensionToken"]],
  ["src/lib/auth/access/maintenance-auth.ts", ["tenantMember"]],
  ["src/app/api/extension/bridge-code/route.ts", ["extensionBridgeCode"]],
  // C8: passkey-enforcement gate pre-read on the cookieless MCP refresh path.
  // Resolves userId/tenantId from the refresh-token row (RLS would filter it to
  // null for a DPoP-bearer request) before re-deriving passkey state + gating.
  ["src/app/api/mcp/token/route.ts", ["mcpRefreshToken"]],
  ["src/app/api/extension/token/exchange/route.ts", ["extensionBridgeCode"]],
  // A04-4: execute is the only phase that revokes shares system-wide; the
  // master key is global, so old-version shares across ALL tenants must be
  // revoked regardless of which tenant approved the rotation (NF4).
  // The legacy single-actor endpoint at /api/admin/rotate-master-key/route.ts
  // returned 410 Gone post-A04-4 and no longer touches PasswordShare — its
  // prior allowlist entry has been removed.
  ["src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts", ["passwordShare"]],
  ["src/app/api/maintenance/purge-history/route.ts", ["tenant", "passwordEntryHistory"]],
  ["src/app/api/teams/route.ts", ["teamMember"]],
  ["src/app/api/teams/pending-key-distributions/route.ts", ["teamMember"]],
  // Team key distribution: guest members require cross-tenant public-key lookup
  ["src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts", ["user"]],
  // Team invitations: existing-user lookup must see guest users across tenants
  ["src/app/api/teams/[teamId]/invitations/route.ts", ["user"]],
  // Team key rotation prep: guest members require cross-tenant public-key lookup
  ["src/app/api/teams/[teamId]/rotate-key/data/route.ts", ["user"]],
  ["src/app/api/teams/invitations/accept/route.ts", ["teamInvitation"]],
  ["src/lib/auth/policy/account-lockout.ts", ["user", "tenant", "auditOutbox"]],
  ["src/lib/auth/policy/lockout-admin-notify.ts", ["user", "tenantMember"]],
  ["src/lib/auth/policy/new-device-detection.ts", ["session", "user"]],
  // C8: shared fail-closed re-derivation of passkey-enforcement state for the
  // token-issuance gates (derivePasskeyState). Reads a user-global passkey
  // count + the tenant policy row under bypass — the cookieless token paths and
  // the session callback have no RLS context. Mirrors src/auth.ts's read.
  ["src/lib/auth/policy/passkey-enforcement.ts", ["webAuthnCredential", "tenant"]],
  // Shared step-up helper: reads Session.createdAt from the session-token cookie.
  ["src/lib/auth/session/step-up.ts", ["session"]],
  // Route-level chooser: selects passkey freshness vs generic recent-session by session provider.
  // C5 member 1: canRecoverSessionWithPasskey re-checks the bound credential row by id.
  ["src/lib/auth/session/recent-current-auth-method.ts", ["session", "webAuthnCredential"]],
  ["src/lib/notification.ts", ["user", "notification"]],
  ["src/lib/webhook-dispatcher.ts", ["teamWebhook", "tenantWebhook"]],
  ["src/lib/auth/access/tenant-auth.ts", ["tenantMember"]],
  // Admin console: cross-tenant team membership query for scope selector
  ["src/lib/auth/access/team-auth.ts", ["teamMember"]],
  ["src/lib/vault/vault-reset.ts", ["*"]], // vault wipe: deletes across many tables in $transaction
  ["src/app/api/vault/admin-reset/route.ts", ["adminVaultReset"]],
  ["src/lib/auth/tokens/api-key.ts", ["apiKey", "tenantMember"]],
  ["src/lib/auth/webauthn/webauthn-authorize.ts", ["webAuthnCredential"]],
  ["src/app/api/auth/passkey/verify/route.ts", ["user", "session"]],
  ["src/app/api/auth/passkey/options/email/route.ts", ["user", "webAuthnCredential"]],
  // C3: also reads the session row to resolve the bound credential.
  ["src/app/api/auth/passkey/reauth/options/route.ts", ["webAuthnCredential", "session"]],
  ["src/app/api/auth/passkey/reauth/verify/route.ts", ["webAuthnCredential", "session"]],
  ["src/lib/auth/session/user-session-invalidation.ts", [
    "session", "extensionToken", "apiKey",
    "mcpAccessToken", "mcpRefreshToken", "delegationSession",
    "operatorToken",
  ]],
  // C18 (OWASP A04-1): per-user / per-tenant resource quotas need to count
  // total usage that may span beyond the current request's tenant context.
  // RLS would clip the count to the calling tenant's view, producing
  // under-counts on shared resources. SYSTEM_MAINTENANCE bypass purpose.
  ["src/lib/quota/resource-quotas.ts", [
    "passwordEntry", "attachment", "passwordShare",
    "tenantWebhook", "teamWebhook",
  ]],
  ["src/app/api/tenant/policy/route.ts", ["user", "tenant", "teamPolicy"]],
  ["src/lib/auth/policy/access-restriction.ts", ["tenant"]],
  ["src/lib/team/team-policy.ts", ["teamMember", "teamPolicy", "tenant"]],
  // Team member display: cross-tenant user + home-tenant name hydration for guest members
  ["src/lib/team/team-member-display.ts", ["user", "tenantMember"]],
  // Session timeout resolver: cross-team policy read for session lifetime enforcement
  ["src/lib/auth/session/session-timeout.ts", ["user"]],
  // Extension token refresh: cross-tenant token lookup + family-absolute check
  ["src/app/api/extension/token/refresh/route.ts", ["tenant"]],
  // iOS auth: token row updates (lastUsedIp/UA, replay-detection family revoke)
  // happen across tenant boundary because the bearer token's tenantId is
  // resolved from the row, not the request session.
  ["src/lib/auth/tokens/mobile-token.ts", ["extensionToken", "tenant"]],
  // iOS authorize: bridge-code creation atomically counts active bridge codes
  // per user across tenants (parity with extension/bridge-code/route.ts).
  ["src/app/api/mobile/authorize/route.ts", ["mobileBridgeCode"]],
  // iOS token exchange: bridge-code single-use consumption requires bypass
  // because the row predates the issued session (parity with extension exchange).
  ["src/app/api/mobile/token/route.ts", ["mobileBridgeCode"]],
  // iOS token refresh: cross-tenant token row read for family-absolute check.
  // C13: deactivated-user rejection requires tenantMember lookup.
  ["src/app/api/mobile/token/refresh/route.ts", ["tenant", "extensionToken", "tenantMember"]],
  // Team policy route: pre-write tenant cap check (cross-tenant read of tenant row)
  ["src/app/api/teams/[teamId]/policy/route.ts", ["team"]],
  ["src/app/api/maintenance/purge-audit-logs/route.ts", ["tenant", "auditLog"]],
  ["src/app/api/maintenance/audit-outbox-metrics/route.ts", []],
  ["src/app/api/maintenance/audit-outbox-purge-failed/route.ts", []],
  ["src/app/api/maintenance/audit-chain-verify/route.ts", []],
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
  ["src/lib/auth/tokens/service-account-token.ts", ["serviceAccountToken"]],
  // Operator-token validator: cross-tenant lookup is required because the
  // bearer-token caller has no tenant context until the token row resolves it
  ["src/lib/auth/tokens/operator-token.ts", ["operatorToken"]],
  ["src/lib/mcp/oauth-server.ts", ["mcpAuthorizationCode", "mcpAccessToken", "mcpRefreshToken", "tenantMember"]],
  ["src/app/api/mcp/authorize/route.ts", ["mcpClient", "user"]],
  ["src/app/api/mcp/register/route.ts", ["mcpClient"]],
  ["src/app/api/mcp/authorize/consent/route.ts", ["mcpClient", "user"]],
  ["src/app/[locale]/mcp/authorize/page.tsx", ["mcpClient", "user"]],
  ["src/app/api/maintenance/dcr-cleanup/route.ts", []],
  // JIT access requests: SA self-service path uses bypass for SA lookup; approve reads tenant policy
  ["src/app/api/tenant/access-requests/route.ts", ["serviceAccount", "accessRequest"]],
  ["src/app/api/tenant/access-requests/[id]/approve/route.ts", ["tenant"]],
  // Delegated Decryption: cross-tenant session lookup + delegation CRUD
  ["src/lib/auth/access/delegation.ts", ["delegationSession"]],
  ["src/app/api/vault/delegation/route.ts", ["mcpAccessToken", "tenant", "passwordEntry", "delegationSession"]],
  ["src/app/api/vault/delegation/check/route.ts", ["delegationSession"]],
  // SSH agent per-signature authorize: cross-tenant SSH_KEY lookup scoped by userId in WHERE
  ["src/app/api/vault/ssh/sign-authorize/route.ts", ["passwordEntry"]],
  // MCP Connections: user's own token listing + revocation (userId + tenantId in WHERE)
  // The last three were always used by the bulk-revoke callback (refresh-token
  // families, delegation sessions, one summary audit row) but sat past the old
  // fixed 10-line scan window, so the entry only listed what the window could
  // see. The sibling [id]/route.ts entry below has carried the same four for as
  // long as it has existed; this is the same operation, one level up.
  ["src/app/api/user/mcp-tokens/route.ts", [
    "mcpAccessToken", "mcpClient", "mcpRefreshToken", "delegationSession", "auditLog",
  ]],
  ["src/app/api/user/mcp-tokens/[id]/route.ts", ["mcpAccessToken", "mcpRefreshToken", "delegationSession", "auditLog"]],
  // Auth provider check: userId-scoped Account query for passkey sign-in capability
  ["src/app/api/user/auth-provider/route.ts", ["account"]],
  // Audit anchor publisher: cross-tenant manifest generation reads all tenants + chain state
  ["src/workers/audit-anchor-publisher.ts", ["auditChainAnchor", "tenant", "systemSetting"]],
]);

// Regex to match prisma model access: prisma.modelName.method(...) or tx.modelName.method(...)
// Captures the model name (e.g., "tenant" from "prisma.tenant.findUnique" or "tx.session.create").
// tx is the transaction client inside prisma.$transaction(async (tx) => { ... }) — when nested
// inside withBypassRls, tx inherits the bypass context via the Proxy.

// Regex to find withBypassRls call sites (not imports).
const BYPASS_CALL_RE = /withBypassRls\s*\(/;

// Regex to verify BYPASS_PURPOSE constant is used (not a string literal).
const BYPASS_PURPOSE_RE = /BYPASS_PURPOSE\.\w+/;

// C2 (per plan): production callsites of with(Bypass|Tenant)Rls MUST use
// the (tx) => tx.x form, NOT () => prisma.x. The bare-prisma form works only
// via the Prisma proxy's AsyncLocalStorage injection; it brittle-fails in
// tests that inject a raw PrismaClient or use a DI wrapper.
// Pattern matches the closing-paren-then-fat-arrow shape: `, () =>`.
const TX_LESS_CALLBACK_RE =
  /with(?:Bypass|Tenant)Rls\([\s\S]*?,\s*(?:async\s+)?\(\)\s*=>/m;

// F3 anti-drift: the ONLY sanctioned `(tx) => ...` callbacks that leave `tx`
// unused (suppressed with `eslint-disable-next-line ...no-unused-vars`) are the
// two thin wrappers in tenant-context.ts that delegate to a caller-supplied
// `fn(tenantId)` public contract (SC1 deferral — threading tx would change that
// contract). Any NEW such disable elsewhere is a silent reintroduction of the
// Proxy/ALS-dependent form the guard exists to prevent — it must instead use the
// real (tx) => tx.x form, or be added here after review. Keyed by file only
// (the two lines within tenant-context.ts are the accepted pair).
const F3_UNUSED_TX_DISABLE_ALLOWLIST = new Set([
  "src/lib/tenant-context.ts",
]);
// An eslint-disable-next-line for no-unused-vars that guards a with*Rls (tx) =>
// callback (i.e. suppresses an unused `tx` param on an RLS callback).
const RLS_UNUSED_TX_DISABLE_RE =
  /eslint-disable-next-line[^\n]*no-unused-vars[\s\S]{0,120}?with(?:Bypass|Tenant|UserTenant|TeamTenant)Rls\([\s\S]*?,\s*(?:async\s+)?\(\s*tx\s*\)\s*=>/m;

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

/**
 * Call sites and model references, read from the parse tree.
 *
 * This gate's scan has now been wrong three times, each time for the same
 * reason one level down: a fixed 10-line radius stopped covering callbacks as
 * they grew; a regex deciding "is this a comment?" skipped a real call whose
 * line held a string containing `//`; and a hand-rolled character automaton
 * misread a `/` inside a regex character class as opening a comment, blanking
 * the rest of the file, and blinded the model scan to interpolated code that
 * the raw-text scan had seen. Each fix was a better guess about the grammar.
 *
 * The grammar has an implementation already, and this repo already uses it for
 * exactly this job — `scripts/checks/lib/ast-project.mjs`, adopted by five
 * sibling gates. So: no more guessing. A CallExpression is a call because the
 * parser says so, its extent is `getStart()`..`getEnd()` with nothing to
 * balance, and `tx.model.` inside a template interpolation is code because it
 * is code. Comments, strings and regex literals are excluded structurally
 * rather than by pattern, which is the only way this class closes.
 */
function bypassCallsIn(sf) {
  const calls = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const name =
      expr.getKind() === SyntaxKind.PropertyAccessExpression
        ? expr.getName()
        : expr.getText();
    if (name === "withBypassRls") calls.push(call);
  }
  return calls;
}

/**
 * Prisma model names accessed as `tx.<model>.…` / `prisma.<model>.…` anywhere
 * inside `node`, with the 1-based line of each reference. `$`-prefixed client
 * meta-properties ($transaction, $executeRaw, …) are not models.
 */
function modelRefsIn(node) {
  const refs = [];
  for (const access of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const recv = access.getExpression();
    if (recv.getKind() !== SyntaxKind.Identifier) continue;
    const recvName = recv.getText();
    if (recvName !== "tx" && recvName !== "prisma") continue;
    const model = access.getName();
    if (model.startsWith("$")) continue;
    refs.push({ model, line: access.getStartLineNumber() });
  }
  return refs;
}

const astProject = createAstProject();
const unparseableFiles = [];
const fileViolations = [];
const modelViolations = [];
const purposeViolations = [];
const txLessViolations = [];

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

  // Check 3: every withBypassRls call site, from the parse tree. The AST gives
  // the call's exact extent, so there is no window to get wrong, and it gives
  // real code only, so comments, strings and regex literals are out of scope
  // structurally rather than by pattern.
  const allowedSet = allowedModels.includes("*") ? null : new Set(allowedModels);
  const sf = astProject.createSourceFile(file, content, { overwrite: true });

  // Fail loudly when the parse clearly lost the code. A syntax error can drop
  // the very CallExpression this gate exists to find, and a dropped call is
  // scanned by nothing — "examined nothing" must not be spelled like "found
  // nothing". Structural test, no diagnostics API: if the raw text calls the
  // helper but the tree holds no `withBypassRls` identifier at all, the parse
  // failed. A mention confined to a comment or a string still leaves the import
  // identifier in the tree, so that case does not trip this.
  if (BYPASS_CALL_RE.test(content)) {
    const named = sf
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .some((id) => id.getText() === "withBypassRls");
    if (!named) unparseableFiles.push({ file });
  }

  for (const call of bypassCallsIn(sf)) {
    const callLine = call.getStartLineNumber();

    // Check 3a: tx-less callback (C2). Read the call's own arguments rather
    // than a line window: a callback declared with no parameter, or one whose
    // `tx` is suppressed as unused, is a property of the AST node.
    const lines = content.split("\n");
    const window = lines
      .slice(callLine - 1, Math.min(callLine - 1 + SCAN_RADIUS, lines.length))
      .join("\n");
    if (TX_LESS_CALLBACK_RE.test(window)) {
      txLessViolations.push({ file, line: callLine });
    }

    // Check 3b: model allowlist (skip for wildcard files)
    if (!allowedSet) continue;
    for (const { model, line } of modelRefsIn(call)) {
      if (!allowedSet.has(model)) {
        modelViolations.push({ file, line, model });
      }
    }
  }
}

// Scan ALL production files (not just allowlisted ones) for withTenantRls
// tx-less callbacks — withTenantRls has no per-file allowlist but the
// signature discipline still applies.
for (const file of getSourceFiles()) {
  if (file.includes(".test.") || file.includes("__tests__")) continue;
  const content = readFileSync(file, "utf8");
  if (!/withTenantRls\s*\(/.test(content)) continue;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/withTenantRls\s*\(/.test(lines[i])) continue;
    const window = lines.slice(i, Math.min(i + SCAN_RADIUS, lines.length)).join("\n");
    if (TX_LESS_CALLBACK_RE.test(window)) {
      txLessViolations.push({ file, line: i + 1 });
    }
  }
}

// F3 anti-drift scan: flag any file (outside the allowlist) that suppresses an
// unused `tx` on a with*Rls callback with eslint-disable-next-line no-unused-vars.
const f3DisableViolations = [];
for (const file of getSourceFiles()) {
  if (file.includes(".test.") || file.includes("__tests__")) continue;
  const relFromRepo = file.replace(/\\/g, "/");
  if ([...F3_UNUSED_TX_DISABLE_ALLOWLIST].some((a) => relFromRepo.endsWith(a))) continue;
  const content = readFileSync(file, "utf8");
  if (RLS_UNUSED_TX_DISABLE_RE.test(content)) {
    f3DisableViolations.push(relFromRepo);
  }
}

let failed = false;

if (f3DisableViolations.length > 0) {
  failed = true;
  console.error(
    "eslint-disable(no-unused-vars) on an unused `tx` in a with*Rls callback,",
  );
  console.error(
    "outside the F3 allowlist. Use the (tx) => tx.x form (the guard's prescribed",
  );
  console.error(
    "shape), or — only if the callback delegates to a client-less fn(tenantId)",
  );
  console.error(
    "public contract — add the file to F3_UNUSED_TX_DISABLE_ALLOWLIST after review.",
  );
  console.error("");
  for (const v of f3DisableViolations) console.error(`  ${v}`);
  console.error("");
}

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

if (txLessViolations.length > 0) {
  failed = true;
  if (fileViolations.length > 0 || modelViolations.length > 0 || purposeViolations.length > 0) {
    console.error("");
  }
  console.error(
    "with(Bypass|Tenant)Rls callback uses tx-less form `() => ...`.",
  );
  console.error(
    "Use `(tx) => tx.x.method(...)` instead. The bare-prisma form depends on",
  );
  console.error(
    "the Prisma proxy's AsyncLocalStorage injection and breaks under DI / raw client.",
  );
  console.error("");
  for (const { file, line } of txLessViolations) {
    console.error(`  ${file}:${line}`);
  }
}

// An undeterminable call extent means this gate examined a window it cannot
// justify. "Examined nothing" must not be spelled like "found nothing", so the
// site is named and the gate fails rather than falling back silently.
if (unparseableFiles.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "file names withBypassRls but could not be parsed — its calls were NOT scanned:",
  );
  console.error("");
  for (const { file } of unparseableFiles) {
    console.error(`  ${file}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-bypass-rls: OK");
