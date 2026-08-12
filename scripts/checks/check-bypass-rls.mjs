#!/usr/bin/env node
/**
 * CI guard: ensure withBypassRls is only called from approved files,
 * and only accesses approved Prisma models within each file.
 *
 * Any new usage of withBypassRls must be explicitly added to ALLOWED_USAGE
 * after security review. This prevents accidental RLS bypass in new code.
 *
 * Call sites, callbacks, client identifiers and `<client>.<model>` references are
 * all read from the parse tree (ts-morph, no Program). Raw text decides only
 * which files are worth parsing — see HELPER_MENTION_RE.
 *
 * Five rounds of review found defects here, every one the same defect: a
 * predicate that judged code by its spelling. A fixed 10-line radius stopped
 * covering callbacks as they grew; a regex deciding "is this a comment?" skipped
 * a real call whose line held a string containing `//`; a hand-rolled character
 * automaton misread `/` inside a regex character class as opening a comment and
 * blanked the rest of the file; the AST rewrite that fixed the model scan left
 * four sibling predicates on raw text or name equality; and the rewrite that
 * fixed THOSE resolved a callback name against the whole file, so an unrelated
 * same-named binding elsewhere silently resolved a name that did not refer to
 * it. Round 4's header claimed the class was closed. It was not, and claiming it
 * was is why round 5 had to find the rest — so this header no longer makes that
 * claim, and states instead what is known not to be covered:
 *
 *   - Check 2 (BYPASS_PURPOSE) is FILE-scoped, not call-scoped: one
 *     `BYPASS_PURPOSE.X` anywhere satisfies it for every call in the file, and
 *     its receiver test is name equality, so an aliased import is a false
 *     positive. Pre-existing granularity, unchanged by the AST move.
 *   - The prefilter cannot see a call reached through a RENAMING re-export
 *     (`export { withBypassRls as wb } from "@/lib/tenant-rls"`), because the
 *     caller's text names neither the helper nor the module. No such re-export
 *     exists today (`rg 'export .*from.*tenant-rls' src/` is empty).
 *   - The scan root is `src/` only. `scripts/tenant-domain.ts` and
 *     `scripts/manual-tests/*.ts` call these helpers and are examined by nothing.
 *   - INDIRECT_CALLBACK_ALLOWLIST is keyed by file, so a NEW unresolvable call
 *     site inside an already-listed file is excused without review.
 *
 * All four are tracked as D16 in the branch's deviation log. The rule this file
 * aims at is "no predicate decides a code question by surface form"; the list
 * above is where it does not hold yet, and it is written here rather than in a
 * commit message because the next editor reads this.
 */
import { SyntaxKind } from "ts-morph";
import { createAstProject } from "./lib/ast-project.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

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

// The RLS helpers. `withBypassRls` is the one the per-file model allowlist
// governs; the others share the callback-shape discipline (C2 / F3) only.
const HELPER_NAMES = new Set([
  "withBypassRls",
  "withTenantRls",
  "withUserTenantRls",
  "withTeamTenantRls",
]);
// The two whose callback receives a Prisma transaction client, and so are the
// ones the `(tx) => tx.x` discipline applies to. withUserTenantRls /
// withTeamTenantRls hand their callback a tenant id, not a client.
const TX_CLIENT_HELPERS = new Set(["withBypassRls", "withTenantRls"]);

// A prefilter, not a verdict: it only decides whether a file is worth parsing.
// It covers a direct import, an aliased import and a namespace import, each of
// which names the symbol or the module in the caller's own text. It does NOT
// cover a renaming re-export — see the header's list of known gaps.
//
// Deliberately a superset of the old `withBypassRls\s*\(`: that one required the
// paren, so `import { withBypassRls as wb }` … `wb(...)` skipped the file
// entirely and escaped even the file allowlist. The widening costs 238 parsed
// files instead of 88 — re-derive both rather than trusting these numbers:
//   node -e 'const{readdirSync,readFileSync}=require("fs"),{join,extname}=require("path");
//     let n=0,o=0;for(const e of readdirSync("src",{recursive:true,withFileTypes:true})){
//     if(!e.isFile()||![".ts",".tsx"].includes(extname(e.name)))continue;
//     const f=join(e.parentPath??e.path,e.name);if(f.includes(".test.")||f.includes("__tests__"))continue;
//     const c=readFileSync(f,"utf8");
//     if(/with(?:Bypass|Tenant|UserTenant|TeamTenant)Rls|tenant-rls/.test(c))n++;
//     if(/withBypassRls\s*\(/.test(c))o++;}console.log(n,o)'
// Whole gate measured at ~0.68 s, unchanged from before the widening — but only
// because bindingIndex is built lazily. Building it per parsed file cost ~25%
// (0.68 -> 0.85 s) for an index 3 of 238 files ever consult.
const HELPER_MENTION_RE = /with(?:Bypass|Tenant|UserTenant|TeamTenant)Rls|tenant-rls/;

const FN_KINDS = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

// F3 anti-drift: the ONLY sanctioned with*Rls callbacks that declare `tx` and
// never use it are the two thin wrappers in tenant-context.ts that delegate to
// a caller-supplied `fn(tenantId)` public contract (SC1 deferral — threading tx
// would change that contract). Any NEW one elsewhere is a silent reintroduction
// of the Proxy/ALS-dependent form the guard exists to prevent — it must instead
// use the real (tx) => tx.x form, or be added here after review. Keyed by file
// only (the two callbacks within tenant-context.ts are the accepted pair).
const F3_UNUSED_TX_ALLOWLIST = new Set([
  "src/lib/tenant-context.ts",
]);

// Call sites that hand the helper a callback the gate cannot resolve to a
// function in the same file — here, a wrapper passing its own `fn` parameter
// straight through. Nothing about that callback's shape or its model access is
// visible from this file, so the gate reports it rather than scanning an empty
// node and calling that a pass. Both entries are the same `withVaultTenantRls`
// wrapper shape, whose `fn: () => Promise<T>` contract is itself the tx-less
// form C2 forbids one level up — a pre-existing issue this gate now names
// instead of missing, tracked for the vault routes rather than fixed here.
const INDIRECT_CALLBACK_ALLOWLIST = new Set([
  "src/app/api/vault/status/route.ts",
  "src/app/api/vault/unlock/data/route.ts",
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

/**
 * The local names each helper is reachable under in this file. A named import
 * may be aliased (`withBypassRls as wb`) and a namespace import reaches it as
 * `rls.withBypassRls`, so the call-site test cannot be name equality against
 * the canonical spelling — that is how a call escapes not just the model scan
 * but the file allowlist itself. The canonical names are seeded too, for the
 * defining module and for any helper imported from elsewhere.
 */
function localHelperNames(sf) {
  const byLocalName = new Map([...HELPER_NAMES].map((n) => [n, n]));
  for (const imp of sf.getImportDeclarations()) {
    // Match the module, not a text tail: `@/lib/tenant-rls.js` and a relative
    // `../../lib/tenant-rls` are the same module as `@/lib/tenant-rls`, and an
    // aliased import from a spelling this misses escapes the file allowlist.
    if (!/(^|\/)tenant-rls(\.[cm]?[jt]sx?)?$/.test(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      const canonical = named.getName();
      if (!HELPER_NAMES.has(canonical)) continue;
      byLocalName.set(named.getAliasNode()?.getText() ?? canonical, canonical);
    }
  }
  return byLocalName;
}

/** Every helper call in the file, paired with the canonical helper it resolves to. */
function helperCallsIn(sf) {
  const byLocalName = localHelperNames(sf);
  const calls = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    // `rls.withBypassRls(...)` — the property name is the helper regardless of
    // which object it is reached through, and over-matching here only means an
    // extra call gets scanned, which is the safe direction.
    const helper =
      expr.getKind() === SyntaxKind.PropertyAccessExpression
        ? (HELPER_NAMES.has(expr.getName()) ? expr.getName() : undefined)
        : byLocalName.get(expr.getText());
    if (helper) calls.push({ call, helper });
  }
  return calls;
}

// Node kinds that open a scope, for deciding whether a declaration is visible
// from a call site.
const SCOPE_KINDS = new Set([
  SyntaxKind.SourceFile,
  SyntaxKind.Block,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ModuleDeclaration,
]);

/** The nearest ancestor of `node` that introduces a scope. */
function scopeOf(node) {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (SCOPE_KINDS.has(p.getKind())) return p;
  }
  return null;
}

/**
 * Every declaration in the file that binds a name, indexed by that name.
 * Built once per source file: `callbackOf` consults it per argument, and
 * rebuilding it per lookup would walk the whole tree ~950 times per run.
 *
 * All binding kinds are indexed, not only the function-valued ones. Counting
 * only functions is what let an unrelated `const job = async (tx) => …` in a
 * sibling function satisfy a `job` that actually refers to the enclosing
 * function's own parameter — the gate then scanned a body the call never runs
 * and reported OK, in place of the "could not be resolved" report.
 */
function bindingIndex(sf) {
  const index = new Map();
  const add = (name, decl) => {
    const bucket = index.get(name);
    if (bucket) bucket.push(decl);
    else index.set(name, [decl]);
  };
  const kinds = [
    SyntaxKind.VariableDeclaration,
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.Parameter,
  ];
  for (const kind of kinds) {
    for (const decl of sf.getDescendantsOfKind(kind)) {
      // A destructuring declaration binds each element's name, not the pattern.
      // `getName()` returns the pattern text ("{ job }"), which no identifier can
      // equal — so indexing by it would leave `job` looking unbound, and an
      // unrelated `job` elsewhere would then resolve as the unique candidate.
      // That is the same getName()-on-a-pattern mistake this file already fixed
      // in clientNamesIn and declaresUnusedTx.
      const nameNode = decl.getNameNode?.();
      if (nameNode && nameNode.getKind() !== SyntaxKind.Identifier) {
        for (const el of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          add(el.getName(), decl);
        }
        continue;
      }
      const name = decl.getName?.();
      if (name) add(name, decl);
    }
  }
  return index;
}

/**
 * The callback the helper will invoke. Its position differs per helper
 * (`withBypassRls(prisma, fn, purpose)` vs `withTenantRls(prisma, tenantId, fn)`),
 * so it is found by kind rather than by index.
 *
 * A callback passed by name resolves only when exactly one declaration of that
 * name is visible from the call — visible meaning its own scope encloses the
 * call site, which is what makes the answer about the name at THIS call rather
 * than about the file's vocabulary. Ambiguity, invisibility, or a binding that
 * is not a function all return null, and the caller reports the site: this gate
 * has been wrong four times by guessing, so it no longer guesses.
 */
function callbackOf(call, bindingsFor) {
  const args = call.getArguments();
  const inline = args.find((a) => FN_KINDS.has(a.getKind()));
  if (inline) return inline;

  for (const arg of args) {
    if (arg.getKind() !== SyntaxKind.Identifier) continue;
    const visible = (bindingsFor().get(arg.getText()) ?? []).filter((decl) => {
      const scope = scopeOf(decl);
      return scope && scope.getStart() <= call.getStart() && call.getEnd() <= scope.getEnd();
    });
    if (visible.length !== 1) continue;
    const decl = visible[0];

    // A declaration without a body (an ambient or overload signature) says the
    // implementation is elsewhere, so this file cannot answer.
    if (decl.getKind() === SyntaxKind.FunctionDeclaration) {
      if (decl.getBody()) return decl;
      continue;
    }

    // Only a `const` initializer answers "which function runs at this call".
    // A parameter's initializer is its DEFAULT — one of the values a caller may
    // supply, and not the one supplied at any call site that passes an argument.
    // A `let`/`var` binding can hold a different function at the call than at
    // its declaration. Both are the "scanned a body the call never runs" shape,
    // and the gate refuses rather than guessing at either.
    if (decl.getKind() !== SyntaxKind.VariableDeclaration) continue;
    if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") continue;
    const init = decl.getInitializer();
    if (init && FN_KINDS.has(init.getKind())) return init;
  }
  return null;
}

/**
 * The identifiers that carry the bypassed client inside `fn`. Its own first
 * parameter, whatever it is named — the convention is `tx`, but a gate that
 * enforces the convention by relying on it stops seeing anything the moment
 * someone writes `db`. `prisma` is included because the bare client picks up
 * the bypass context through the Proxy's AsyncLocalStorage, and a nested
 * `$transaction` callback inherits it the same way.
 */
function clientNamesIn(fn) {
  const names = new Set(["prisma"]);
  if (!fn) return names;
  const first = fn.getParameters()[0];
  // A destructured client (`async ({ tenantMember }) => …`) binds no name that
  // can be a receiver — the destructured properties ARE the model accesses, and
  // `getName()` there returns the pattern text, which no identifier can equal.
  // Those are collected by destructuredModelRefs instead.
  const firstName = first?.getNameNode();
  if (firstName?.getKind() === SyntaxKind.Identifier) {
    names.add(first.getName());
  } else if (firstName?.getKind() === SyntaxKind.ObjectBindingPattern) {
    // `async ({ auditOutbox, ...rest }) => rest.user.f()` — the rest element
    // carries the remaining client, so it IS a receiver.
    for (const el of firstName.getElements()) {
      if (el.getDotDotDotToken()) names.add(el.getName());
    }
  }
  for (const inner of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = inner.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (expr.getName() !== "$transaction") continue;
    for (const arg of inner.getArguments()) {
      if (!FN_KINDS.has(arg.getKind())) continue;
      const param = arg.getParameters()[0];
      if (param) names.add(param.getName());
    }
  }
  return names;
}

/**
 * Prisma model names accessed as `<client>.<model>.…` anywhere inside `node`,
 * with the 1-based line of each reference. `$`-prefixed client meta-properties
 * ($transaction, $executeRaw, …) are not models.
 */
function modelRefsIn(node, clientNames) {
  const refs = [];
  for (const access of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const recv = access.getExpression();
    if (recv.getKind() !== SyntaxKind.Identifier) continue;
    if (!clientNames.has(recv.getText())) continue;
    const model = access.getName();
    if (model.startsWith("$")) continue;
    refs.push({ model, line: access.getStartLineNumber() });
  }
  return refs;
}

/**
 * Model names a destructured client parameter reaches directly. `async
 * ({ tenantMember }) => tenantMember.findFirst(…)` never writes a receiver, so
 * the property-access scan cannot see it; the destructured property is itself
 * the model delegate.
 */
function destructuredModelRefs(fn) {
  const refs = [];
  const nameNode = fn?.getParameters()[0]?.getNameNode();
  if (nameNode?.getKind() !== SyntaxKind.ObjectBindingPattern) return refs;
  // Only the pattern's OWN properties are model delegates. A rest element binds
  // the remaining client, not a model — reporting it would name a model that
  // does not exist, and would leave everything reached through it unscanned
  // (clientNamesIn adds it as a receiver instead). Nested patterns destructure
  // a delegate's methods, which are not models either.
  for (const el of nameNode.getElements()) {
    if (el.getDotDotDotToken()) continue;
    const keyNode = el.getPropertyNameNode() ?? el.getNameNode();
    if (keyNode.getKind() !== SyntaxKind.Identifier) continue;
    const model = keyNode.getText();
    if (model.startsWith("$")) continue;
    refs.push({ model, line: el.getStartLineNumber() });
  }
  return refs;
}

/**
 * True when `fn` declares a client parameter and never references it (F3).
 *
 * Keyed on the parameter's own name, not on the spelling `tx`: the convention
 * is what this rule enforces, so a rule that only fires when the convention is
 * already followed enforces nothing. References in property-name position
 * (`cfg.tx`) are not uses of the binding.
 */
function declaresUnusedTx(fn) {
  const nameNode = fn.getParameters()[0]?.getNameNode();
  if (!nameNode || nameNode.getKind() !== SyntaxKind.Identifier) return false;
  const name = nameNode.getText();
  return !fn.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
    if (id === nameNode || id.getText() !== name) return false;
    const parent = id.getParent();
    const isPropertyName =
      parent.getKind() === SyntaxKind.PropertyAccessExpression &&
      parent.getNameNode() === id;
    return !isPropertyName;
  });
}

const astProject = createAstProject();
const unparseableFiles = [];
const fileViolations = [];
const modelViolations = [];
const purposeViolations = [];
const txLessViolations = [];
const indirectCallbacks = [];
const f3UnusedTxViolations = [];

// "Examined nothing" must not be spelled like "found nothing" at the corpus
// level either: a wrong cwd, a moved tree or a broken walk would otherwise
// print OK after scanning zero files. readdirSync throws when `src/` is absent;
// this covers the present-but-empty case it cannot.
const sourceFiles = getSourceFiles();
if (sourceFiles.length === 0) {
  console.error("check-bypass-rls: no .ts/.tsx source files found under src/.");
  console.error("Nothing was examined, so this is not a pass. Check the working directory.");
  process.exit(1);
}

let parsedCount = 0;

for (const file of sourceFiles) {
  // Skip test files — they mock withBypassRls, not call it for real
  if (file.includes(".test.") || file.includes("__tests__")) continue;

  const content = readFileSync(file, "utf8");
  if (!HELPER_MENTION_RE.test(content)) continue;

  parsedCount++;
  const sf = astProject.createSourceFile(file, content, { overwrite: true });

  // Fail loudly when the parse lost the code. A syntax error can drop the very
  // CallExpression this gate exists to find, and a dropped call is scanned by
  // nothing — "examined nothing" must not be spelled like "found nothing". Ask
  // the parser whether it is sure, rather than inferring it from the tree's
  // contents: the previous structural test (does any `withBypassRls` identifier
  // survive?) was satisfied by the import specifier alone, so it could never
  // fire for a file that imports the helper — which is every real call site.
  // An absent diagnostics array means the question could not be asked, which
  // denies rather than passes.
  const diagnostics = sf.compilerNode.parseDiagnostics;
  if (diagnostics === undefined || diagnostics.length > 0) {
    unparseableFiles.push({ file });
    continue;
  }

  const calls = helperCallsIn(sf);
  const bypassCalls = calls.filter(({ helper }) => helper === "withBypassRls");
  const allowedModels = ALLOWED_USAGE.get(file);

  // Check 1: a file that really calls withBypassRls must be on the allowlist.
  // Keyed on a call in the tree, not on the text naming one, so prose and
  // string literals that mention the helper no longer read as usage.
  if (bypassCalls.length > 0 && !allowedModels) {
    fileViolations.push(file);
  }

  // Check 2: withBypassRls call sites must name their purpose with the
  // BYPASS_PURPOSE constant, not a string literal. The definition file
  // (tenant-rls.ts) is exempt — it defines, not consumes.
  if (bypassCalls.length > 0 && file !== "src/lib/tenant-rls.ts") {
    const usesPurpose = sf
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .some((a) => a.getExpression().getText() === "BYPASS_PURPOSE");
    if (!usesPurpose) purposeViolations.push({ file, line: 0 });
  }

  const allowedSet =
    !allowedModels || allowedModels.includes("*") ? null : new Set(allowedModels);

  // Built on first use, not per file: only a call that passes its callback by
  // NAME needs it, which is 3 of the 238 parsed files. Building it eagerly cost
  // three whole-file descendant walks per file — ~25% of the gate's runtime for
  // an answer almost nobody asked for.
  let bindings = null;
  const bindingsFor = () => (bindings ??= bindingIndex(sf));

  for (const { call, helper } of calls) {
    const line = call.getStartLineNumber();
    const fn = callbackOf(call, bindingsFor);

    if (!fn) {
      // Only the tx-client helpers carry a discipline this gate can check, so
      // only their unresolvable callbacks are worth reporting.
      if (TX_CLIENT_HELPERS.has(helper) && !INDIRECT_CALLBACK_ALLOWLIST.has(file)) {
        indirectCallbacks.push({ file, line, helper });
      }
      continue;
    }

    if (TX_CLIENT_HELPERS.has(helper)) {
      // C2: the callback must take the transaction client. The bare-prisma
      // `() =>` form works only via the Prisma proxy's AsyncLocalStorage
      // injection and brittle-fails under DI or a raw client. Read off the
      // callback's declared parameters — the shape is a property of the node,
      // not of the text near it.
      if (fn.getParameters().length === 0) {
        txLessViolations.push({ file, line });
      } else if (declaresUnusedTx(fn) && !F3_UNUSED_TX_ALLOWLIST.has(file)) {
        // F3: a declared-but-unused `tx` is the same bypass wearing the
        // prescribed shape. Checking the parameter's actual use replaces
        // looking for the eslint-disable comment that usually accompanies it —
        // the comment is the symptom, and matching it in raw text also matched
        // the same words inside a string.
        f3UnusedTxViolations.push({ file, line, param: fn.getParameters()[0].getName() });
      }
    }

    // Check 3: model allowlist, for withBypassRls in a non-wildcard file. The
    // callback is the scan node — which is the call's own subtree for an inline
    // callback, and the resolved declaration for one passed by name.
    if (helper !== "withBypassRls" || !allowedSet) continue;
    const clientNames = clientNamesIn(fn);
    const seen = new Set();
    const scanNodes =
      fn.getStart() >= call.getStart() && fn.getEnd() <= call.getEnd() ? [call] : [call, fn];
    for (const ref of destructuredModelRefs(fn)) {
      seen.add(`${ref.model}:${ref.line}`);
      if (!allowedSet.has(ref.model)) {
        modelViolations.push({ file, line: ref.line, model: ref.model });
      }
    }
    for (const node of scanNodes) {
      for (const ref of modelRefsIn(node, clientNames)) {
        const key = `${ref.model}:${ref.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!allowedSet.has(ref.model)) {
          modelViolations.push({ file, line: ref.line, model: ref.model });
        }
      }
    }
  }
}

let failed = false;

if (f3UnusedTxViolations.length > 0) {
  failed = true;
  console.error(
    "with*Rls callback declares the transaction client and never uses it,",
  );
  console.error(
    "outside the F3 allowlist. Use the (tx) => tx.x form (the guard's prescribed",
  );
  console.error(
    "shape), or — only if the callback delegates to a client-less fn(tenantId)",
  );
  console.error(
    "public contract — add the file to F3_UNUSED_TX_ALLOWLIST after review.",
  );
  console.error("");
  for (const { file, line, param } of f3UnusedTxViolations) console.error(`  ${file}:${line}  (${param})`);
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

// A callback the gate cannot resolve to a function in this file means its
// shape and its model access were examined by nothing. Named rather than
// skipped, for the same reason as the parse failures below.
if (indirectCallbacks.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "with(Bypass|Tenant)Rls callback could not be resolved to a function in the",
  );
  console.error(
    "same file, so its shape and its model access were NOT scanned. Pass the",
  );
  console.error(
    "callback inline, or add the file to INDIRECT_CALLBACK_ALLOWLIST after review:",
  );
  console.error("");
  for (const { file, line, helper } of indirectCallbacks) {
    console.error(`  ${file}:${line}  ${helper}`);
  }
}

// A file the parser reported diagnostics on was not scanned at all: the calls
// this gate exists to find can be missing from a recovered tree, and a dropped
// call is examined by nothing. "Examined nothing" must not be spelled like
// "found nothing", so the file is named and the gate fails.
if (unparseableFiles.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "file could not be parsed — its with*Rls calls were NOT scanned:",
  );
  console.error("");
  for (const { file } of unparseableFiles) {
    console.error(`  ${file}`);
  }
}

if (failed) {
  process.exit(1);
}

// Name the subject count on the success path: "OK" alone cannot distinguish a
// clean tree from a scan that examined almost nothing, and a silent collapse of
// this number is the shape a wrong cwd or a broken prefilter takes in CI logs.
// The denominator is the SCANNABLE set, not the raw walk: test files are
// skipped unconditionally, so dividing by the walk would read as a coverage
// ratio that half the corpus was never a candidate for.
const scannableCount = sourceFiles.filter(
  (f) => !f.includes(".test.") && !f.includes("__tests__"),
).length;
console.log(
  `check-bypass-rls: OK (parsed ${parsedCount} of ${scannableCount} scannable source files)`,
);
