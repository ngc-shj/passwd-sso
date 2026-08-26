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
 *   - A client returned by a call is not followed: `const db = wrap(tx)`.
 *   - The client's propagation into a callee is followed only where the tree
 *     proves the mapping. Where it cannot, the call is SKIPPED, not reported —
 *     which is this gate's remaining fail-open class, and it is wider than
 *     "the callee is imported":
 *       · an imported callee (38 call sites today; resolving it needs a Program)
 *       · `this` — `query.call(tx)` where the body uses `this.model`. Binding it
 *         would mean adding `this` to a client set that is keyed by NAME with no
 *         per-function scope, so every `this.x` in every analysed function would
 *         read as a model access. The flat client set is the real limit here.
 *       · a spread before the client (`query(...rest, tx)`) — the argument's
 *         real position depends on `rest.length`, so the syntactic index binds
 *         the wrong parameter.
 *       · a receiver whose object this file cannot prove — `const helpers =
 *         actual`, or a `let` reassigned after its initializer. The binding is
 *         chosen first and then checked, so an unprovable one yields null
 *         rather than falling back to an outer declaration and analysing the
 *         wrong object.
 *     Some of these resolve a callee and then map it wrongly — `this` and the
 *     spread, where the function is known and the binding is not. Others are
 *     never resolved at all: an imported callee, and an unprovable receiver,
 *     which yields null by design. So a fail-closed rule keyed on either half
 *     alone leaves the other open. Closing the class means reporting any client
 *     propagation whose callee, argument position, `this` and spread mapping
 *     cannot ALL be proven.
 *
 *     Everything else decidable from the tree IS followed — see
 *     clientBindingsIn: the helper's own first argument, aliases and their
 *     chains, plain assignments, destructuring, parameter defaults, a choice
 *     between clients, same-file callees taking the client at any argument
 *     position, and nested `$transaction` callbacks at any depth including
 *     mutually recursive ones.
 *
 * Treat this list as the current best enumeration, not a closed one: eleven
 * successive external reviews each found a member missing from it, which is the
 * same class-derivation failure as the code defects above, committed in the
 * prose written to compensate for them. These are tracked as D16/D18–D28 in
 * the branch's deviation log. The rule this file aims at is "no predicate
 * decides a code question by surface form"; the list above is where it does not
 * hold yet, and it is written here rather than in a commit message because the
 * next editor reads this.
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
  // Health probe: whole-deployment outbox backlog depth. Raw SQL, no model
  // accessor. Runs outside any request tenant context, and the depth it reports
  // is deliberately not tenant-scoped.
  ["src/lib/health.ts", []],
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
// On cost: the binding index and the flow index are both built lazily and once
// per file, which is what keeps this affordable — collecting them eagerly per
// file measured ~25% slower, and per CALL another ~13%.
//
// Compare RUNS OF TWO BUILDS INTERLEAVED, never an absolute number against one
// written here earlier. This gate has measured 0.68 s and 1.10 s on the same
// machine on the same day under different load, and a round was nearly spent
// "fixing" a regression that was background noise — after an earlier round had
// shipped a false "unchanged" in the other direction. An absolute figure in
// this comment would rot the same way twice over.
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
      // in clientBindingsIn and declaresUnusedTx.
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
function resolveLocalFunction(name, at, bindingsFor, seen = new Set()) {
  const visible = (bindingsFor().get(name) ?? []).filter((decl) => {
    const scope = scopeOf(decl);
    return scope && scope.getStart() <= at.getStart() && at.getEnd() <= scope.getEnd();
  });
  if (visible.length === 0) return null;

  // JavaScript picks the INNERMOST binding, so the gate does too: the visible
  // declaration whose scope is smallest. Requiring exactly one meant a local
  // `query` shadowing a module-level `query` resolved to neither, and the call
  // was skipped in silence.
  let decl = visible[0];
  let best = scopeOf(decl).getEnd() - scopeOf(decl).getStart();
  for (const candidate of visible.slice(1)) {
    const scope = scopeOf(candidate);
    const span = scope.getEnd() - scope.getStart();
    if (span < best) {
      best = span;
      decl = candidate;
    }
  }

  const id = `${decl.getStart()}:${decl.getEnd()}`;
  if (seen.has(id)) return null;
  seen.add(id);

  // A declaration without a body (an ambient or overload signature) says the
  // implementation is elsewhere, so this file cannot answer.
  if (decl.getKind() === SyntaxKind.FunctionDeclaration) {
    return decl.getBody() ? decl : null;
  }

  // Only a `const` initializer answers "which function runs here". A
  // parameter's initializer is its DEFAULT — one of the values a caller may
  // supply, not the one supplied at any call that passes an argument. A
  // `let`/`var` binding can hold a different function by the time it runs.
  if (decl.getKind() !== SyntaxKind.VariableDeclaration) return null;
  if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
  const init = unwrapExpression(decl.getInitializer());
  if (init && FN_KINDS.has(init.getKind())) return init;
  // `const aliasedQuery = query` names a function without being one. Follow it
  // from the ALIAS's own position, not the call's — that is where the name it
  // mentions is resolved — and stop on a declaration already visited, which
  // ends a cycle without a depth limit a longer chain could step over.
  if (init?.getKind() === SyntaxKind.Identifier) {
    return resolveLocalFunction(init.getText(), init, bindingsFor, seen);
  }
  return null;
}

/**
 * The function a call actually invokes, when this file can say: an inline
 * function expression (an IIFE), or a name resolved through the visible
 * bindings — following `const aliasedQuery = query` to the function it names.
 * An imported callee returns null; that is the module boundary named in the
 * header, not something the tree could have answered.
 */
function calleeFunctionOf(call, bindingsFor) {
  const callee = unwrapExpression(call.getExpression());
  if (!callee) return null;
  if (FN_KINDS.has(callee.getKind())) return { fn: callee, argOffset: 0 };
  if (callee.getKind() === SyntaxKind.Identifier) {
    const fn = resolveLocalFunction(callee.getText(), call, bindingsFor);
    return fn ? { fn, argOffset: 0 } : null;
  }
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;

  const member = callee.getNameNode().getText();
  const receiver = unwrapExpression(callee.getExpression());

  // `query.call(thisArg, a, b)` invokes the receiver with its arguments shifted
  // by one — resolving the function without that offset binds the wrong
  // parameter, which is a wrong answer rather than a missing one. `.apply`
  // passes an array, so positions cannot be mapped at all and it stays
  // unresolved.
  if (member === "call") {
    if (receiver?.getKind() !== SyntaxKind.Identifier) return null;
    const fn = resolveLocalFunction(receiver.getText(), call, bindingsFor);
    return fn ? { fn, argOffset: 1 } : null;
  }

  // `helpers.query(...)` where `helpers` is a local object literal: the method
  // is a function this file declares, so the tree can answer.
  if (receiver?.getKind() !== SyntaxKind.Identifier) return null;
  const owner = resolveLocalObjectLiteral(receiver.getText(), call, bindingsFor);
  if (!owner) return null;
  for (const prop of owner.getProperties()) {
    const kind = prop.getKind();
    if (kind !== SyntaxKind.MethodDeclaration && kind !== SyntaxKind.PropertyAssignment) {
      continue;
    }
    if (staticMemberName(prop.getNameNode()) !== member) continue;
    if (kind === SyntaxKind.MethodDeclaration) return { fn: prop, argOffset: 0 };
    const value = unwrapExpression(prop.getInitializer());
    if (value && FN_KINDS.has(value.getKind())) return { fn: value, argOffset: 0 };
    if (value?.getKind() === SyntaxKind.Identifier) {
      const fn = resolveLocalFunction(value.getText(), value, bindingsFor);
      return fn ? { fn, argOffset: 0 } : null;
    }
  }
  return null;
}

/** The object literal a local `const` name is bound to, if any. */
function resolveLocalObjectLiteral(name, at, bindingsFor) {
  // Pick the binding FIRST, then ask what it holds. Filtering candidates to
  // object literals before choosing dropped an inner `const helpers = actual`
  // from candidacy — its initializer is an identifier — so the OUTER object
  // won, which is the "analysed a different binding" defect one filter-order
  // away from the one D29 fixed. There is no fallback to an outer declaration:
  // a binding this file cannot prove holds an object literal returns null, and
  // null is the D28 class (a propagation whose mapping is unproven), not a
  // licence to analyse something else.
  const visible = (bindingsFor().get(name) ?? []).filter((decl) => {
    const scope = scopeOf(decl);
    return scope && scope.getStart() <= at.getStart() && at.getEnd() <= scope.getEnd();
  });
  if (visible.length === 0) return null;

  let best = visible[0];
  let span = scopeOf(best).getEnd() - scopeOf(best).getStart();
  for (const candidate of visible.slice(1)) {
    const scope = scopeOf(candidate);
    const width = scope.getEnd() - scope.getStart();
    if (width < span) {
      span = width;
      best = candidate;
    }
  }

  if (best.getKind() !== SyntaxKind.VariableDeclaration) return null;
  // `let`/`var` can hold a different object by the time the call runs, so only
  // a `const` initializer answers what this name holds.
  if (best.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
  const init = unwrapExpression(best.getInitializer());
  return init?.getKind() === SyntaxKind.ObjectLiteralExpression ? init : null;
}

function callbackOf(call, bindingsFor) {
  const args = call.getArguments();
  const inline = args.find((a) => FN_KINDS.has(a.getKind()));
  if (inline) return inline;

  for (const arg of args) {
    if (arg.getKind() !== SyntaxKind.Identifier) continue;
    const fn = resolveLocalFunction(arg.getText(), call, bindingsFor);
    if (fn) return fn;
  }
  return null;
}

/**
 * Everything inside `fn` that carries the bypassed client, and the model
 * accesses that fall out of destructuring one.
 *
 * A client reaches a model by more than one spelling, and the gate has to
 * follow the VALUE rather than the name it happens to wear at the access:
 *
 *   tx.model.findMany()                  the parameter itself
 *   const db = tx;  db.model.findMany()  an alias — and aliases chain
 *   const { model } = tx;                the delegate lifted out directly
 *   ({ model }) => model.findMany()      the same, done in the signature
 *   ({ ...rest }) => rest.model.f()      a rest element is still the client
 *   tx.$transaction(async (t2) => …)     a nested tx inherits the bypass
 *
 * Assignments are followed to a fixpoint, so a chain of any length resolves,
 * as are parameter defaults and a choice between clients (`cond ? tx : prisma`).
 * `let`/`var` aliases are followed too: unlike a callback binding, over-
 * approximating a CLIENT can only report more models, which is the safe
 * direction.
 *
 * A client is identified by its expression text, not by a bare name, so
 * `clients.prisma` from a namespace import is tracked like any other. What
 * cannot be reduced to a name or a member access — a client returned by a call
 * — is not followed, and where that appears as the helper's own first argument
 * the site is REPORTED rather than scanned with an incomplete client set.
 */
/**
 * A literal member name: a string, or an untagged template with no
 * substitutions. Used where the node sits in an INDEX position (`tx["model"]`),
 * because an identifier there is a variable reference, not a name — `tx[model]`
 * names whatever `model` holds, which this file cannot say.
 */
function literalMemberName(node) {
  if (!node) return null;
  switch (node.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return node.getLiteralValue();
    case SyntaxKind.ParenthesizedExpression:
      return literalMemberName(node.getExpression());
    default:
      return null;
  }
}

/**
 * The member name a node denotes in a NAME position — a destructuring property
 * key, a property assignment. An identifier there IS the name, unlike in an
 * index; a computed key reduces to its literal when it has one.
 *
 * The pair exists so every place a member name is read goes through one of
 * them: the model receiver and the `$transaction` detector use the index form,
 * destructuring uses this one. Teaching only one site about `tx["model"]` is
 * what the previous escapes were.
 */
function staticMemberName(node) {
  if (!node) return null;
  switch (node.getKind()) {
    case SyntaxKind.Identifier:
      return node.getText();
    case SyntaxKind.ComputedPropertyName:
      return literalMemberName(node.getExpression());
    default:
      return literalMemberName(node);
  }
}

/**
 * A structural key for the expression by which a value is named, or null when
 * it has no such name.
 *
 * Built from the parse tree rather than taken as source text: `getText()`
 * carries the trivia between tokens, so `clients . prisma` and `clients.prisma`
 * are the same value under two different strings — and a gate that compares
 * those strings is defeated by a space. Type-level wrappers reduce away
 * (`db as typeof db`, `(db)`, `db!`, `db satisfies X`), and a static string
 * index is the same thing as a property (`tx["model"]` is `tx.model`).
 *
 * The exact answer would be binding identity from the type checker; this gate
 * runs without a Program by design, and a trivia-free structural key is what
 * that leaves. It is used by BOTH sides — the client argument and the model
 * receiver — because the last three defects here were all the two sides
 * reducing an expression differently.
 */
/** An expression with its type-level wrappers removed. */
function unwrapExpression(expr) {
  switch (expr?.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
      return unwrapExpression(expr.getExpression());
    default:
      return expr;
  }
}

function clientKey(expr) {
  if (!expr) return null;
  switch (expr.getKind()) {
    case SyntaxKind.Identifier:
      return expr.getText();
    case SyntaxKind.ThisKeyword:
      return "this";
    case SyntaxKind.PropertyAccessExpression: {
      const base = clientKey(expr.getExpression());
      return base === null ? null : `${base}.${expr.getNameNode().getText()}`;
    }
    case SyntaxKind.ElementAccessExpression: {
      const member = literalMemberName(expr.getArgumentExpression());
      if (member === null) return null;
      const base = clientKey(expr.getExpression());
      return base === null ? null : `${base}.${member}`;
    }
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
      return clientKey(expr.getExpression());
    default:
      return null;
  }
}


/**
 * The file's variable declarations and plain assignments, collected once.
 * `clientBindingsIn` runs per call site and needs the whole file (an alias may
 * live outside the callback), so collecting them per call walked the tree once
 * per call — measurably, ~20% of the gate's runtime.
 */
function flowIndex(sf) {
  return {
    decls: sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    // A parameter's default is a value the binding may carry. For the CALLBACK
    // this gate refuses to read a default (see callbackOf: guessing which
    // function runs is fail-open). For a CLIENT the answer is the opposite —
    // `function drain(db = prisma)` means `db` may be the client, and treating
    // it as one can only report more models, which is the safe direction.
    params: sf.getDescendantsOfKind(SyntaxKind.Parameter),
    assignments: sf
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .filter((b) => b.getOperatorToken().getKind() === SyntaxKind.EqualsToken),
  };
}

function clientBindingsIn(fn, flow, clientArg, bindingsFor) {
  // `prisma` by its conventional name, plus whatever the call actually handed
  // the helper — `withBypassRls(db, …)` after `import { prisma as db }`, or
  // `withBypassRls(clients.prisma, …)` from a namespace import, passes the
  // client under something this file has never seen. The argument is the client
  // by the helper's own signature, so it needs no inference — only reducing to
  // the expression that names it.
  const clients = new Set(["prisma"]);
  const argText = clientKey(clientArg);
  if (argText) clients.add(argText);
  const modelRefs = [];
  // Destructuring keys and nested-transaction callbacks this file cannot read.
  // Both are "the client goes somewhere and the gate cannot follow", which must
  // be said rather than skipped — the same reason `tx[model]` is reported.
  const unresolved = [];
  // Every callback reached from this call site: the outer one, and each nested
  // `$transaction` callback, at any depth. Filled by the worklist below.
  const callbackNodes = [];
  // A first argument that reduces to neither a name nor a member access (a
  // client returned by a call) leaves the client set incomplete, and scanning
  // with an incomplete client set reports "no violations" for a callback it
  // could not read. The caller turns this into a named violation.
  const clientUnresolved = Boolean(clientArg) && !argText;
  if (!fn) return { clients, modelRefs, clientUnresolved, unresolved, callbackNodes };

  // A destructuring OUTSIDE the callback is not a bypassed access — it only
  // tells us what the bound names carry. Model references are collected from
  // inside the callback only; client aliases propagate from anywhere.
  // Inside ANY callback this call reaches, not just the outermost. Testing only
  // the outer one treated a destructuring in a named nested callback as
  // "outside the callback", so its delegates were never read as model access.
  const insideCallback = (node) =>
    callbackNodes.some(
      (cb) => node.getStart() >= cb.getStart() && node.getEnd() <= cb.getEnd(),
    );

  const addModel = (keyNode, line) => {
    const model = staticMemberName(keyNode);
    if (model === null) return false;
    if (model.startsWith("$")) return false;
    if (modelRefs.some((r) => r.model === model && r.line === line)) return false;
    modelRefs.push({ model, line });
    return true;
  };

  const noteUnresolved = (node) => {
    const line = node.getStartLineNumber();
    const text = node.getText();
    if (!unresolved.some((u) => u.line === line && u.text === text)) {
      unresolved.push({ line, text });
    }
  };

  const addClient = (name) => {
    if (!name || clients.has(name)) return false;
    clients.add(name);
    return true;
  };

  // Destructuring a client binds its delegates: each property is a model
  // access, and a rest element carries what is left of the client.
  const spreadPattern = (pattern, emitModels) => {
    let grew = false;
    for (const el of pattern.getElements()) {
      if (el.getDotDotDotToken()) {
        if (addClient(el.getName())) grew = true;
        continue;
      }
      if (!emitModels) continue;
      const keyNode = el.getPropertyNameNode() ?? el.getNameNode();
      if (staticMemberName(keyNode) === null) {
        noteUnresolved(el);
        continue;
      }
      if (addModel(keyNode, el.getStartLineNumber())) grew = true;
    }
    return grew;
  };

  // The assignment form of the same thing: `({ model, ...rest } = tx)`. Its
  // left side is an object LITERAL, not a binding pattern, so the elements come
  // back as property assignments rather than binding elements.
  const spreadObjectLiteral = (literal, emitModels) => {
    let grew = false;
    for (const prop of literal.getProperties()) {
      const kind = prop.getKind();
      if (kind === SyntaxKind.SpreadAssignment) {
        const key = clientKey(prop.getExpression());
        if (key && addClient(key)) grew = true;
        continue;
      }
      if (!emitModels) continue;
      if (
        kind === SyntaxKind.ShorthandPropertyAssignment ||
        kind === SyntaxKind.PropertyAssignment
      ) {
        if (staticMemberName(prop.getNameNode()) === null) {
          noteUnresolved(prop);
          continue;
        }
        if (addModel(prop.getNameNode(), prop.getStartLineNumber())) grew = true;
      }
    }
    return grew;
  };

  // A callback parameter, at any depth: the outer one, and every nested
  // `$transaction` callback, which inherits the bypass through the Proxy. Both
  // take the same treatment — an identifier is a client, a pattern destructures
  // one — because a nested transaction is a client by a different route, not a
  // different kind of thing.
  const takeParameter = (param) => {
    const nameNode = param?.getNameNode();
    if (nameNode?.getKind() === SyntaxKind.Identifier) addClient(nameNode.getText());
    else if (nameNode?.getKind() === SyntaxKind.ObjectBindingPattern) {
      spreadPattern(nameNode, true);
    }
  };

  // Walk the callbacks as a graph, not as one level with a patch bolted on.
  // A nested `$transaction` callback is itself a callback: it binds a client,
  // its body may destructure delegates out of it, and it may nest again. Each
  // of the last several defects here was that structure handled to depth one,
  // so it is a worklist — depth-N by construction — with a visited set that
  // also makes a self-referential callback terminate.
  const { decls, params, assignments } = flow;

  // Does this expression evaluate to a client? An identifier that is one, or a
  // choice between them — `cond ? tx : prisma`, `maybe ?? tx`. Deliberately NOT
  // "any expression mentioning a client": `const user = await tx.user.find()`
  // mentions `tx` and yields a row, and 131 such lines exist in this tree, so
  // treating a mention as a flow would report every ordinary query. A client
  // returned by a helper (`const db = wrap(tx)`) is undecidable without type
  // resolution, which this gate runs without by design — see the header.
  const yieldsClient = (expr) => {
    if (!expr) return false;
    const named = clientKey(expr);
    if (named !== null) return clients.has(named);
    switch (expr.getKind()) {
      case SyntaxKind.ConditionalExpression:
        return yieldsClient(expr.getWhenTrue()) || yieldsClient(expr.getWhenFalse());
      case SyntaxKind.BinaryExpression: {
        const op = expr.getOperatorToken().getKind();
        // `a ?? tx` / `a || tx` can yield either side; `a && tx` yields the
        // RIGHT side when it yields at all, so only that operand is a client.
        if (op === SyntaxKind.AmpersandAmpersandToken) return yieldsClient(expr.getRight());
        if (op !== SyntaxKind.QuestionQuestionToken && op !== SyntaxKind.BarBarToken) {
          return false;
        }
        return yieldsClient(expr.getLeft()) || yieldsClient(expr.getRight());
      }
      default:
        return false;
    }
  };

  // ── One fixpoint, not two phases ────────────────────────────────────────
  //
  // The callback/helper graph and the client flow feed each other: resolving a
  // helper binds a parameter, which makes an assignment relevant, which names a
  // client, which turns a previously-uninteresting call into one that
  // propagates. Running the graph walk first and the flow analysis afterwards
  // meant `const alias = tx; queryMember(alias)` was invisible — the alias was
  // learned after the only pass that could have used it. They are one loop now.
  //
  // Enrolment is keyed by (function, parameter index), not by function alone:
  // the same function can be a `$transaction` callback in one call and an
  // ordinary helper in another, and whichever was seen first used to settle its
  // client position for good.
  const enrolled = new Map();
  let progressed = true;
  const enrol = (node, index) => {
    if (!node) return;
    const id = `${node.getStart()}:${node.getEnd()}`;
    let positions = enrolled.get(id);
    if (!positions) {
      positions = new Set();
      enrolled.set(id, positions);
      callbackNodes.push(node);
      progressed = true;
    }
    if (index === null || index < 0 || positions.has(index)) return;
    positions.add(index);
    takeParameter(node.getParameters()[index]);
    progressed = true;
  };

  enrol(fn, 0);

  while (progressed) {
    progressed = false;

    // Flow: one pass over the file's declarations, parameter defaults and
    // assignments. `prisma` is a Proxy reading the bypass context out of
    // AsyncLocalStorage, so a module-level `const db = prisma` is a bypassed
    // client inside the callback too, and a binding is not a different value
    // for having been filled in on the next line.
    for (const decl of decls) {
      if (!yieldsClient(decl.getInitializer())) continue;
      const nameNode = decl.getNameNode();
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        if (addClient(nameNode.getText())) progressed = true;
      } else if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        if (spreadPattern(nameNode, insideCallback(decl))) progressed = true;
      }
    }
    for (const param of params) {
      if (!yieldsClient(param.getInitializer())) continue;
      const nameNode = param.getNameNode();
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        if (addClient(nameNode.getText())) progressed = true;
      } else if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        if (spreadPattern(nameNode, insideCallback(param))) progressed = true;
      }
    }
    for (const assignment of assignments) {
      if (!yieldsClient(assignment.getRight())) continue;
      const left = assignment.getLeft();
      if (left.getKind() === SyntaxKind.ObjectLiteralExpression) {
        if (spreadObjectLiteral(left, insideCallback(assignment))) progressed = true;
        continue;
      }
      const leftText = clientKey(left);
      if (leftText && addClient(leftText)) progressed = true;
    }

    // Graph: every call inside every function reached so far.
    for (const node of [...callbackNodes]) {
      for (const inner of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = inner.getExpression();
        const member =
          expr.getKind() === SyntaxKind.PropertyAccessExpression
            ? expr.getNameNode().getText()
            : expr.getKind() === SyntaxKind.ElementAccessExpression
              ? literalMemberName(expr.getArgumentExpression())
              : null;

        if (member === "$transaction") {
          // The batch form `$transaction([...])` takes no callback, so there is
          // no inner client to inherit and nothing to resolve.
          if (
            unwrapExpression(inner.getArguments()[0])?.getKind() ===
            SyntaxKind.ArrayLiteralExpression
          ) {
            continue;
          }
          const nested = callbackOf(inner, bindingsFor);
          if (!nested) {
            noteUnresolved(inner);
            continue;
          }
          // A transaction callback takes the client as its first parameter.
          enrol(nested, 0);
          continue;
        }

        // An ordinary call HANDED a client: the callee's parameter in that
        // position becomes a client inside it. The argument test is
        // yieldsClient, not a bare name, so an alias or a choice between
        // clients counts — the same predicate the flow pass uses.
        const positions = inner
          .getArguments()
          .map((arg, index) => (yieldsClient(arg) ? index : -1))
          .filter((index) => index >= 0);
        if (positions.length === 0) continue;
        const resolved = calleeFunctionOf(inner, bindingsFor);
        if (!resolved) continue;
        for (const index of positions) enrol(resolved.fn, index - resolved.argOffset);
      }
    }
  }

  return { clients, modelRefs, clientUnresolved, unresolved, callbackNodes };
}

/**
 * Prisma model names accessed as `<client>.<model>.…` anywhere inside `node`,
 * with the 1-based line of each reference. `$`-prefixed client meta-properties
 * ($transaction, $executeRaw, …) are not models.
 */
function modelRefsIn(node, clientNames) {
  const refs = [];
  // Both spellings of a member access: `tx.model` and `tx["model"]`. The
  // receiver goes through clientKey, the same reduction the client argument
  // uses — a cast on one side and a bare name on the other was how the last
  // escape got through.
  const accesses = [
    ...node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ...node.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
  ];
  const unresolved = [];
  for (const access of accesses) {
    // Resolve the RECEIVER first. Dropping an unreadable index before knowing
    // whose index it is discards exactly the case that matters: `tx[model]` on
    // a bypassed client reaches some model, and which one is precisely what
    // this gate cannot say — so it must say that, not stay silent.
    const recvKey = clientKey(access.getExpression());
    if (recvKey === null || !clientNames.has(recvKey)) continue;
    const model =
      access.getKind() === SyntaxKind.PropertyAccessExpression
        ? access.getName()
        : literalMemberName(access.getArgumentExpression());
    if (model === null) {
      unresolved.push({ line: access.getStartLineNumber(), text: access.getText() });
      continue;
    }
    if (model.startsWith("$")) continue;
    refs.push({ model, line: access.getStartLineNumber() });
  }
  return { refs, unresolved };
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
const unresolvedClients = [];
const unresolvedModels = [];
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
  let flow = null;
  const flowFor = () => (flow ??= flowIndex(sf));

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
    const { clients, modelRefs, clientUnresolved, unresolved, callbackNodes } =
      clientBindingsIn(fn, flowFor(), call.getArguments()[0], bindingsFor);
    if (clientUnresolved) unresolvedClients.push({ file, line });
    const seen = new Set();
    // The call itself (its other arguments can hold model access) plus every
    // callback the analyser reached, wherever each is declared. Overlap is
    // harmless: reports are deduplicated by model and line.
    const scanNodes = [call, ...callbackNodes];
    const report = ({ model, line }) => {
      const key = `${model}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!allowedSet.has(model)) modelViolations.push({ file, line, model });
    };
    // Delegates lifted straight off a client by destructuring, then every
    // `<client>.<model>` reached through any identifier that carries the client.
    for (const ref of modelRefs) report(ref);
    for (const u of unresolved) {
      unresolvedModels.push({ file, line: u.line, text: u.text });
    }
    for (const node of scanNodes) {
      const { refs, unresolved } = modelRefsIn(node, clients);
      for (const ref of refs) report(ref);
      for (const u of unresolved) {
        const key = `?:${u.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unresolvedModels.push({ file, line: u.line, text: u.text });
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
if (unresolvedModels.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "a bypassed client is indexed by a name this gate cannot resolve, so which",
  );
  console.error(
    "model it reaches is unknown and the allowlist could not be applied to it.",
  );
  console.error(
    "Use `<client>.<model>` (or a literal index) so the model is readable:",
  );
  console.error("");
  for (const { file, line, text } of unresolvedModels) {
    console.error(`  ${file}:${line}  ${text}`);
  }
}

if (unresolvedClients.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "withBypassRls was handed a client this gate cannot name — it reduces to",
  );
  console.error(
    "neither an identifier nor a member access, so the callback's model access",
  );
  console.error(
    "was NOT scanned against a complete client set. Pass the client directly:",
  );
  console.error("");
  for (const { file, line } of unresolvedClients) console.error(`  ${file}:${line}`);
}

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
