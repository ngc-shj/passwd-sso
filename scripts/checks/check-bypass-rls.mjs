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
 * (audit-tenant-adjudicator round 13) Call discovery was the same defect again: a
 * call counted only when its callee was spelled `helper(…)` or `ns.helper(…)`, so
 * `(withBypassRls)(…)`, `withBypassRls!(…)`, `.call`, a local alias, the helper
 * passed to another function and eleven other spellings reached no check at all —
 * a file on no allowlist passed. Rather than list spellings, every reference to a
 * helper that is not a direct call or a type position is now reported
 * (indirectHelperReferencesIn); the tree had none outside tests. A module loaded
 * at run time (`await import("@/lib/tenant-rls")`, `require`) binds the helpers
 * like an import: a destructured binding is followed as one, the module object as
 * a namespace, and any other use of the load is reported (runtimeHelperModulesIn).
 * A run-time load is recognised here only through a LITERAL specifier
 * (`import "..."`/`require("...")`, not `import rls = require(…)`), and only
 * identifier-keyed destructuring is followed — this is `runtimeHelperModulesIn`,
 * the syntactic half of run-time loads. C3 (below, the Program section) adds
 * the other half: a load whose specifier is NOT a literal — a variable, a
 * template, a call through an untyped `require`-like value — is judged by the
 * specifier's checked TYPE instead, which is strictly wider than a syntactic
 * literal (F-R2-5) and closes what this paragraph used to list as uncovered.
 * A run-time destructure that binds a name already bound to a different helper
 * makes that name ambiguous, and it is reported wherever it is used, a direct
 * call included; two STATIC imports under one name are not checked, since
 * TypeScript rejects them (TS2300), as it rejects `import … = require` under
 * this repo's module setting (TS1202). `import wb = rls.withBypassRls` is a
 * reference like any other (rounds 14 and 15).
 *
 *   - Check 2 (BYPASS_PURPOSE) is FILE-scoped, not call-scoped: one
 *     `BYPASS_PURPOSE.X` anywhere satisfies it for every call in the file, and
 *     its receiver test is name equality, so an aliased import is a false
 *     positive. Pre-existing granularity, unchanged by the AST move.
 *   - A re-export or an `export *` barrel, renamed or not; a load whose
 *     specifier is not a literal; a quoted or computed destructuring key; and
 *     a helper-named member read off an object this file cannot prove to be
 *     the module — the audit-tenant-adjudicator round 14 (S-R14-2) list this
 *     paragraph used to carry — are CLOSED by C3's Program section below (a
 *     real ts-morph Project with dependency resolution, items 1-6 in the
 *     C3 header there): the reference cross-check follows a re-export or
 *     `export * as ns` by resolving the underlying symbol rather than
 *     matching text; a bare `export *` barrel is refused outright because
 *     that re-export produces no reference for the cross-check to follow; a
 *     non-literal load is judged by the specifier's checked TYPE; a quoted or
 *     computed destructuring key resolves through the pattern's type; and a
 *     helper-named member read off a value whose type carries a helper is
 *     refused unless it is a literal-named/keyed receiver (Rule A), or, for
 *     an `any`/`unknown` receiver, unless the key is a string-literal union
 *     (Rule B). What C3 does NOT close, named there rather than repeated
 *     here: `export *` itself (the statement's own line — no reference
 *     exists for item 3 to find, which is why 5b is a separate rule), a
 *     quoted/computed destructuring key on a receiver whose type cannot be
 *     read, a specifier typed plain `string` with no literal reduction, and
 *     one residual UNVERIFIED case — an ambient `.d.ts` declaration that
 *     types a value as the helper module.
 *   - The scan root is `src/` only. `scripts/tenant-domain.ts` and
 *     `scripts/manual-tests/*.ts` call these helpers and are examined by nothing.
 *   - INDIRECT_CALLBACK_ALLOWLIST is keyed by file, so a NEW unresolvable call
 *     site inside an already-listed file is excused without review.
 *   - A client returned by a call is not followed: `const db = wrap(tx)`.
 *   - The client's propagation into a callee is followed only where the tree
 *     proves the mapping. Where it cannot, the call is SKIPPED, not reported —
 *     which is this gate's remaining fail-open class, and it is wider than
 *     "the callee is imported":
 *       · an imported callee — resolving it needs a Program. The count is
 *         MEASURED and printed on every run rather than stated here: the
 *         number this line used to carry was frozen prose about a moving
 *         subject, and it is the same count the over-breadth check below
 *         uses to decide which files it must not judge.
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
import { SyntaxKind, ts } from "ts-morph";
import { createAstProject, createProgramProject, ProgramBuildError } from "./lib/ast-project.mjs";
import {
  FN_KINDS,
  bindingIndex,
  resolveLocalFunction,
  resolveLocalObjectLiteral,
  unwrapExpression,
} from "./lib/scope-bindings.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname, dirname, relative, resolve, sep } from "node:path";

// Per-file allowlist: file path → allowed Prisma model names.
// "*" means any model is allowed (use sparingly, only for definitions or
// complex transactional code that touches many models by design).
const ALLOWED_USAGE = new Map([
  ["src/lib/tenant-rls.ts", ["*"]], // definition
  // `user`: `resolveExistingUsersForTenant`, the ownership read SCIM POST and
  // directory sync consult before attaching an existing user. It must see users
  // filed under other tenants — to REFUSE them — and it lives here, beside
  // `resolveOwningTenantIdFromClient`, because it applies the same owning-tenant
  // rule. Read-only; returns ids and a classification, no identity.
  ["src/lib/tenant-context.ts", ["tenantMember", "team", "user"]],
  // The standalone realignment for producers that activate a membership inside a
  // TENANT context (SCIM, directory sync): that context cannot write a users row
  // the owning column files under another tenant. Re-reads the membership it
  // follows — only while still ACTIVE in the tenant named — then moves the column
  // through `realignOwningTenantColumn` and records both sides.
  ["src/lib/tenant/tenant-realignment.ts", ["tenantMember"]],
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
  // `tenant` reads the policy row directly by id. These files used to reach the
  // same row by traversing `user.tenant`, which follows the stale `User.tenantId`
  // column; the adjudicator resolves the active membership first, so the tenant
  // is now loaded by that id. Same row, same bypass scope, named model.
  ["src/app/api/auth/passkey/verify/route.ts", ["user", "session", "tenant"]],
  ["src/app/api/auth/passkey/options/email/route.ts", ["user", "webAuthnCredential", "tenant"]],
  // The cross-tenant reactivation guard: resolves the SCIM id and reads the
  // user's ACTIVE membership set, both of which are invisible inside the tenant
  // context this route mutates in. Read-only, and the tenant it compares against
  // is the authenticated SCIM token's, not caller-supplied.
  ["src/app/api/scim/v2/Users/[id]/route.ts", ["tenantMember", "scimExternalMapping"]],
  // The user LIST reads under a bypass: its filter runs through the users
  // relation, which a tenant context narrows to users whose owning column names
  // this tenant, silently dropping departed members from the page and the count.
  // Every query carries the token's tenantId, ANDed so no filter can widen it.
  // Read-only. (The CREATE verb's ownership read moved into tenant-context.ts's
  // `resolveExistingUsersForTenant`, so this file no longer reads `user`.)
  ["src/app/api/scim/v2/Users/route.ts", ["tenantMember", "scimExternalMapping"]],
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
  ["src/app/api/tenant/policy/route.ts", ["tenant", "teamPolicy"]],
  ["src/lib/auth/policy/access-restriction.ts", ["tenant"]],
  ["src/lib/team/team-policy.ts", ["tenant"]],
  // Team member display: cross-tenant user + home-tenant name hydration for guest members
  ["src/lib/team/team-member-display.ts", ["user", "tenantMember"]],
  // Session timeout resolver: cross-team policy read for session lifetime enforcement
  ["src/lib/auth/session/session-timeout.ts", ["user", "tenant"]],
  // Extension token refresh: cross-tenant token lookup + family-absolute check
  ["src/app/api/extension/token/refresh/route.ts", ["tenant"]],
  // iOS auth: token row updates (lastUsedIp/UA, replay-detection family revoke)
  // happen across tenant boundary because the bearer token's tenantId is
  // resolved from the row, not the request session.
  ["src/lib/auth/tokens/mobile-token.ts", ["extensionToken"]],
  // iOS authorize: bridge-code creation atomically counts active bridge codes
  // per user across tenants (parity with extension/bridge-code/route.ts).
  ["src/app/api/mobile/authorize/route.ts", ["mobileBridgeCode"]],
  // iOS token exchange: bridge-code single-use consumption requires bypass
  // because the row predates the issued session (parity with extension exchange).
  ["src/app/api/mobile/token/route.ts", ["mobileBridgeCode"]],
  // iOS token refresh: cross-tenant token row read for family-absolute check.
  // C13: deactivated-user rejection requires tenantMember lookup.
  ["src/app/api/mobile/token/refresh/route.ts", ["extensionToken", "tenantMember"]],
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
  ["src/app/api/user/passkey-status/route.ts", ["webAuthnCredential", "user", "tenant"]],
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
const TENANT_RLS_MODULE_RE = /(^|\/)tenant-rls(\.[cm]?[jt]sx?)?$/;

/**
 * Every run-time load of the helpers' module — `import("…tenant-rls")` or
 * `require("…tenant-rls")` — with the binding it lands in: an object pattern, an
 * identifier (the module object, used like a namespace import), or null when the
 * loaded module is used any other way (round 13).
 */
function runtimeHelperModulesIn(sf) {
  const loads = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isLoad =
      expr.getKind() === SyntaxKind.ImportKeyword ||
      (expr.getKind() === SyntaxKind.Identifier && expr.getText() === "require");
    if (!isLoad) continue;
    const spec = literalMemberName(call.getArguments()[0]);
    if (spec === null || !TENANT_RLS_MODULE_RE.test(spec)) continue;
    let holder = call.getParent();
    while (holder && (holder.getKind() === SyntaxKind.AwaitExpression || holder.getKind() === SyntaxKind.ParenthesizedExpression)) {
      holder = holder.getParent();
    }
    const binding = holder?.getKind() === SyntaxKind.VariableDeclaration ? holder.getNameNode() : null;
    loads.push({ call, binding });
  }
  return loads;
}

/** Marks a local name bound to more than one RLS helper in the file (round 14, S-R14-1). */
const AMBIGUOUS_HELPER = "<ambiguous>";

function localHelperNames(sf) {
  const byLocalName = new Map([...HELPER_NAMES].map((n) => [n, n]));
  for (const imp of sf.getImportDeclarations()) {
    // Match the module, not a text tail: `@/lib/tenant-rls.js` and a relative
    // `../../lib/tenant-rls` are the same module as `@/lib/tenant-rls`, and an
    // aliased import from a spelling this misses escapes the file allowlist.
    if (!TENANT_RLS_MODULE_RE.test(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) {
      const canonical = named.getName();
      if (!HELPER_NAMES.has(canonical)) continue;
      byLocalName.set(named.getAliasNode()?.getText() ?? canonical, canonical);
    }
  }
  // A destructured run-time load binds the helpers as a named import does, so a
  // call through `const { withBypassRls: wb } = await import(…)` is still a call.
  for (const { binding } of runtimeHelperModulesIn(sf)) {
    if (binding?.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
    for (const element of binding.getElements()) {
      if (element.getDotDotDotToken() || element.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
      const canonical = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
      if (!HELPER_NAMES.has(canonical)) continue;
      // The map is file-wide. A binding that names a different helper under a name
      // already bound — `{ withTenantRls: withBypassRls }` in another function —
      // reclassified every call spelled with that name, and a real bypass call
      // reached none of the checks. The name is ambiguous instead (round 14, S-R14-1).
      const local = element.getNameNode().getText();
      const previous = byLocalName.get(local);
      byLocalName.set(local, previous === undefined || previous === canonical ? canonical : AMBIGUOUS_HELPER);
    }
  }
  return byLocalName;
}

const sameNode = (a, b) => !!a && !!b && a.getStart() === b.getStart() && a.getEnd() === b.getEnd();

/** Nodes whose name child is a name, not a reference to a binding of that name. */
const NAMED_DECLARATION_KINDS = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.EnumMember,
  SyntaxKind.BindingElement,
]);

const isDirectCallee = (node) => {
  const parent = node.getParent();
  return parent?.getKind() === SyntaxKind.CallExpression && sameNode(parent.getExpression(), node);
};

/**
 * Every reference to an RLS helper that is neither a direct call nor a type
 * position (round 13). helperCallsIn sees only `helper(…)`, `helper?.(…)` and
 * `ns.helper(…)`; anything else — a wrapped or aliased callee, `.call`/`.apply`/
 * `.bind`, an element access, the helper or its namespace handed on as a value —
 * reaches none of the checks, so it is reported here instead of being followed.
 */
function indirectHelperReferencesIn(sf) {
  const byLocalName = localHelperNames(sf);
  const namespaces = new Set();
  for (const imp of sf.getImportDeclarations()) {
    if (!TENANT_RLS_MODULE_RE.test(imp.getModuleSpecifierValue())) continue;
    const ns = imp.getNamespaceImport();
    if (ns) namespaces.add(ns.getText());
  }
  const refs = [];
  for (const { call, binding } of runtimeHelperModulesIn(sf)) {
    if (!binding) refs.push(call);
    else if (binding.getKind() === SyntaxKind.Identifier) namespaces.add(binding.getText());
    else if (binding.getKind() === SyntaxKind.ObjectBindingPattern) {
      for (const element of binding.getElements()) {
        if (element.getDotDotDotToken() || element.getNameNode().getKind() !== SyntaxKind.Identifier) refs.push(element);
      }
    } else refs.push(binding);
  }
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    const parent = id.getParent();
    const kind = parent?.getKind();
    if (kind === SyntaxKind.ImportSpecifier || kind === SyntaxKind.NamespaceImport || kind === SyntaxKind.ExportSpecifier) continue;
    if (kind === SyntaxKind.TypeQuery) continue;
    if (kind === SyntaxKind.QualifiedName) {
      // A type position, except in `import wb = rls.withBypassRls`, which binds a
      // value alias the calls below then go through (round 14, F-R14-1).
      if (
        parent.getFirstAncestorByKind(SyntaxKind.ImportEqualsDeclaration) &&
        sameNode(parent.getRight(), id) &&
        HELPER_NAMES.has(name)
      ) {
        refs.push(parent);
      }
      continue;
    }
    if (NAMED_DECLARATION_KINDS.has(kind) && sameNode(parent.getNameNode?.(), id)) continue;
    if (kind === SyntaxKind.BindingElement && sameNode(parent.getPropertyNameNode?.(), id)) continue;
    if (kind === SyntaxKind.PropertyAccessExpression && sameNode(parent.getNameNode(), id)) continue;

    if (namespaces.has(name)) {
      const isObject =
        (kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.ElementAccessExpression) &&
        sameNode(parent.getExpression(), id);
      if (!isObject) {
        refs.push(id);
        continue;
      }
      const member =
        kind === SyntaxKind.PropertyAccessExpression ? parent.getName() : literalMemberName(parent.getArgumentExpression());
      if (member === null) refs.push(parent);
      else if (HELPER_NAMES.has(member) && !(kind === SyntaxKind.PropertyAccessExpression && isDirectCallee(parent))) refs.push(parent);
      continue;
    }

    if (!byLocalName.has(name)) continue;
    if (byLocalName.get(name) !== AMBIGUOUS_HELPER && isDirectCallee(id)) continue;
    refs.push(id);
  }
  return refs;
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
    if (helper && helper !== AMBIGUOUS_HELPER) calls.push({ call, helper });
  }
  return calls;
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
  // Call sites that hand the client to a callee outside this file. The header's
  // fail-open class, counted rather than asserted in prose.
  const handedOff = [];
  if (!fn) return { clients, modelRefs, clientUnresolved, unresolved, callbackNodes, handedOff };

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
        if (!resolved) {
          // The client crosses a module boundary this tree cannot open. Recorded
          // rather than merely skipped: the models it reaches over there are
          // reached under THIS bypass, so any question of the form "which models
          // does this file touch" has no answer here.
          handedOff.push(inner.getStartLineNumber());
          continue;
        }
        for (const index of positions) enrol(resolved.fn, index - resolved.argOffset);
      }
    }
  }

  return { clients, modelRefs, clientUnresolved, unresolved, callbackNodes, handedOff };
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

// ─── C3: Program-backed reference cross-check ──────────────────────────────
//
// Everything above this point is the syntactic pass: it recognises a helper by
// how a name is SPELLED — an import specifier's text, an identifier equal to
// one of HELPER_NAMES. Round 14's header already named the class this misses:
// reaching a file other than straight from the tenant-rls module — through a
// re-export or an `export *` barrel, a load whose specifier is not a literal,
// a quoted or computed destructuring key, or a helper-named member read off an
// object this file cannot prove to be the module — needs a Program, "which no
// gate in this tree carries" (round 14). This section is that Program: a real
// dependency-resolved ts-morph Project (lib/ast-project.mjs's
// createProgramProject), built from this scan root's tsconfig.json, used for
// exactly two things the syntactic pass cannot do — find every REAL reference
// to a helper declaration regardless of spelling (the language service's
// findReferencesAsNodes, which follows renamed/`export *` re-exports because
// it resolves the same underlying symbol, not matching text), and ask the
// type checker what an expression's TYPE actually is.
//
// Control class: fail-closed verification gate. Where neither the reference
// finder nor the checker can decide — a specifier typed `string`, an
// unresolvable destructuring key, a helper-carrying value used outside a
// literal member read, an `any` receiver with a non-literal key — the case is
// REFUSED (reported), not followed.
const HELPER_DECLARATIONS = [
  { file: "src/lib/tenant-rls.ts", name: "withBypassRls" },
  { file: "src/lib/tenant-rls.ts", name: "withTenantRls" },
  { file: "src/lib/tenant-context.ts", name: "withUserTenantRls" },
  { file: "src/lib/tenant-context.ts", name: "withTeamTenantRls" },
];

/** `file` everywhere else in this gate is cwd-relative, POSIX-separated. */
function toRelPosix(absPath) {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

/** The scan root this whole file uses: `src/`, non-test (SC3, unchanged by C3). */
function isInScopeFile(rel) {
  return rel.startsWith("src/") && !rel.includes(".test.") && !rel.includes("__tests__");
}

function programBuildFailed(message) {
  console.error(`check-bypass-rls: PROGRAM_BUILD_FAILED: ${message}`);
  console.error(
    "The Program-backed reference cross-check (C3) cannot run without it — refusing rather than scanning with a Program that cannot answer for itself.",
  );
  process.exit(1);
}

function buildProgram() {
  const tsConfigFilePath = join(process.cwd(), "tsconfig.json");
  try {
    return createProgramProject(tsConfigFilePath);
  } catch (error) {
    if (error instanceof ProgramBuildError) programBuildFailed(error.message);
    throw error;
  }
}

/**
 * The four helper declarations, resolved THROUGH the Program rather than
 * assumed present — a fixture (or a real tree) missing one, or missing the
 * file entirely, fails named here (item 1), instead of the reference
 * cross-check below silently finding zero references and that reading as
 * "nothing to report". Overloads included: `sf.getFunctions()` returns every
 * FunctionDeclaration syntax node sharing the name, signatures and
 * implementation alike, and `withUserTenantRls` / `withTeamTenantRls` are
 * declared as two overloads plus an implementation.
 */
function resolveHelperDeclarations(program) {
  const byName = new Map();
  for (const { file, name } of HELPER_DECLARATIONS) {
    const psf = program.getSourceFile(join(process.cwd(), file));
    if (!psf) {
      programBuildFailed(`helper declaration file not found in the Program: ${file}`);
    }
    const decls = psf.getFunctions().filter((fn) => fn.getName() === name);
    const impl = decls.find((d) => d.getBody());
    if (!impl) {
      programBuildFailed(`helper declaration not found: ${name} in ${file}`);
    }
    byName.set(name, { file, impl, decls });
  }
  return byName;
}

/** A stable identity for a declaration node, for a Set keyed on DECLARATIONS (S2-F2) — not on symbol identity, which a union's synthetic property symbol does not share with any one constituent. */
function declKey(node) {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
}

/** Every declaration (overloads included) of all four helpers, as one Set of declKey values. */
function buildHelperDeclKeySet(helperDecls) {
  const keys = new Set();
  for (const [, { decls }] of helperDecls) {
    for (const d of decls) keys.add(declKey(d));
  }
  return keys;
}

/** Follows an alias symbol (a renamed import, a re-export specifier) to the symbol it names — ts-morph throws calling getAliasedSymbol on a non-alias, so a non-alias is its own answer. */
function resolveAliasedSymbol(symbol) {
  try {
    return symbol.getAliasedSymbol() ?? symbol;
  } catch {
    return symbol;
  }
}

/** Whether `symbol`, alias-resolved, is (one of) the four helper declarations. */
function symbolIsHelper(symbol, helperDeclKeys) {
  const resolved = resolveAliasedSymbol(symbol);
  return (resolved.getDeclarations() ?? []).some((d) => helperDeclKeys.has(declKey(d)));
}

/**
 * Item 6's closing line: "a helper-named member that resolves to a different
 * declaration is provably not the helper and passes." helperCallsIn's
 * `ns.helper(…)` branch matches on the property NAME alone — deliberately, so
 * a call it cannot type-check still gets scanned (the safe direction when no
 * Program exists) — but now that one does, a receiver the checker CAN resolve
 * narrows that match instead of leaving it a permanent over-approximation:
 * `x.withBypassRls()` where `x` is a local `{ withBypassRls: () => 0 }` is
 * provably not the helper, and reporting it as one (an unallowlisted file, a
 * missing BYPASS_PURPOSE, …) would be reporting a call that cannot happen.
 * Only PropertyAccessExpression calls are filtered — an Identifier callee is
 * already resolved through the canonical HELPER_NAMES seed, not a member
 * name, so there is no "different declaration" question to ask of it here.
 */
function filterCallsByReceiverDeclaration(calls, psf, helperDeclKeys) {
  if (!psf) return calls;
  const byStart = new Map();
  for (const c of psf.getDescendantsOfKind(SyntaxKind.CallExpression)) byStart.set(c.getStart(), c);
  return calls.filter(({ call }) => {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return true;
    const pcall = byStart.get(call.getStart());
    const pexpr = pcall?.getExpression();
    if (pexpr?.getKind() !== SyntaxKind.PropertyAccessExpression) return true; // could not cross-reference — stay conservative
    const prop = pexpr.getExpression().getType().getProperty(pexpr.getName());
    if (!prop) return true; // unresolvable receiver — stay conservative (unprovable, not "provably not")
    return symbolIsHelper(prop, helperDeclKeys);
  });
}

/**
 * Rule A's "carries a helper": true when any PROPERTY of `type` resolves,
 * alias-resolved, to a helper declaration. Built over declarations rather than
 * symbol identity (S2-F2) so a union type is covered for free — the synthetic
 * property symbol a union yields carries every constituent's own declarations,
 * with no single shared symbol to compare against.
 */
function typeCarriesHelper(type, helperDeclKeys) {
  for (const prop of type.getProperties()) {
    if (symbolIsHelper(prop, helperDeclKeys)) return true;
  }
  return false;
}

/**
 * Every REAL reference to a helper declaration, outside its own defining
 * file, in scope (src/, non-test) — item 3. findReferencesAsNodes resolves the
 * underlying symbol, so a renamed re-export, a named re-export under a new
 * module, and an `export * as ns` namespace all surface the downstream
 * USE as a reference here even though the syntactic pass above never
 * recognised the local name as bound to a helper at all (its import module
 * does not match TENANT_RLS_MODULE_RE). What it does NOT surface (measured):
 * the `export *`/`export * as ns` statement's own line (the re-export
 * produces no reference — 5b/item 3's own header note), and a quoted or
 * computed destructuring key, or a non-literal member name (5c / Rule A/B
 * exist because of exactly this gap).
 */
function collectExternalReferences(program, helperDecls) {
  const byFile = new Map();
  const languageService = program.getLanguageService();
  for (const [name, { file, impl }] of helperDecls) {
    const refs = languageService.findReferencesAsNodes(impl.getNameNode());
    for (const ref of refs) {
      const rel = toRelPosix(ref.getSourceFile().getFilePath());
      if (rel === file) continue; // inside its own defining file — not "outside", nothing to account for
      if (!isInScopeFile(rel)) continue; // scan root is src/, non-test (SC3, unchanged)
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push({ start: ref.getStart(), line: ref.getStartLineNumber(), helperName: name });
    }
  }
  return byFile;
}

/**
 * Every position in `sf` (the SYNTACTIC parse of this same file — offsets
 * agree with the Program's parse because both read the same bytes) that the
 * syntactic pass already accounts for: a direct call's callee, an
 * already-reported indirect reference, a recognised import/export
 * specifier or namespace binding (module matches TENANT_RLS_MODULE_RE), and a
 * type-only position (`typeof helper`) — a type position cannot run, so the
 * syntactic pass's own indirectHelperReferencesIn already treats it as
 * out-of-scope-but-not-a-violation, and item 3 must agree or every `typeof`
 * use anywhere would misreport as "a form this gate does not analyse".
 */
function accountedPositionsIn(sf, calls, indirect) {
  const positions = new Set();
  const mark = (node) => {
    if (node) positions.add(node.getStart());
  };
  for (const { call } of calls) {
    const expr = call.getExpression();
    mark(expr.getKind() === SyntaxKind.PropertyAccessExpression ? expr.getNameNode() : expr);
  }
  for (const node of indirect) mark(node);
  // Import/export/destructuring DECLARATION sites are never themselves the
  // violation — item 3's own point is that a re-export's line produces no
  // Program reference at all, so nothing here needs to suppress it either way.
  // Marked by the (pre-alias) NAME the specifier carries, NOT by which module
  // it came through: helperCallsIn/localHelperNames already resolve a bare
  // call by spelling regardless of import origin (the four canonical names are
  // pre-seeded), so gating this on TENANT_RLS_MODULE_RE — the way the OLD
  // per-file import recognition does — made every ordinary
  // `import { withUserTenantRls } from "@/lib/tenant-context"` (its module
  // does not match "tenant-rls") read as an unaccounted reference across the
  // whole real tree: two entirely different defining modules share one
  // caller-facing spelling convention, and this check must know that too.
  for (const imp of sf.getImportDeclarations()) {
    mark(imp.getNamespaceImport());
    mark(imp.getDefaultImport());
    for (const named of imp.getNamedImports()) {
      if (HELPER_NAMES.has(named.getName())) mark(named.getNameNode());
      mark(named.getAliasNode());
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const ns = exp.getNamespaceExport?.();
    if (ns) mark(ns.getNameNode());
    for (const named of exp.getNamedExports()) {
      if (HELPER_NAMES.has(named.getName())) mark(named.getNameNode());
      mark(named.getAliasNode());
    }
  }
  // A plain-identifier-keyed destructuring element (`const { withBypassRls } =
  // await import(...)`) is a real property reference the checker follows, and
  // runtimeHelperModulesIn already recognises and tracks this shape for a
  // literal, regex-matching load — accounted here the same way, by spelling.
  for (const el of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const propNode = el.getPropertyNameNode() ?? el.getNameNode();
    if (propNode.getKind() !== SyntaxKind.Identifier) continue;
    if (HELPER_NAMES.has(propNode.getText())) mark(propNode);
  }
  for (const tq of sf.getDescendantsOfKind(SyntaxKind.TypeQuery)) {
    // `typeof rls.withBypassRls` — a QUALIFIED name, not a bare identifier
    // (F-R14-1's own fixture shape). The reference sits at the RIGHT-hand
    // identifier of each level, not at the qualified name's own start.
    let exprName = tq.getExprName();
    while (exprName?.getKind() === SyntaxKind.QualifiedName) {
      mark(exprName.getRight());
      exprName = exprName.getLeft();
    }
    mark(exprName);
  }
  return positions;
}

/** Every export this module makes available, following `export *` chains — checker.getExportsOfModule already does the chasing. */
function exportsAnyHelper(psf, checker, helperDeclKeys) {
  const moduleSymbol = psf.getSymbol();
  if (!moduleSymbol) return false;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    if (symbolIsHelper(exported, helperDeclKeys)) return true;
  }
  return false;
}

/**
 * Item 5b: a bare `export * from SPEC` (no `as ns`, no named list) whose
 * target exports a helper is a violation wherever it appears outside the two
 * defining files — the re-export produces no reference (measured: item 3's
 * probe above never sees the statement's own line), so it is refused
 * regardless of whether anything downstream actually imports through it.
 * `export { x } from` and `export * as ns from` DO produce references and are
 * item 3's job, not this one — both are skipped here so neither rule reports
 * the same barrel twice under a different name.
 */
function bareStarExportViolationsIn(psf, checker, helperDeclKeys) {
  const violations = [];
  for (const exp of psf.getExportDeclarations()) {
    if (exp.getNamedExports().length > 0) continue;
    if (exp.getNamespaceExport?.()) continue;
    const target = exp.getModuleSpecifierSourceFile();
    if (!target) continue;
    if (exportsAnyHelper(target, checker, helperDeclKeys)) {
      violations.push({ line: exp.getStartLineNumber(), text: exp.getText() });
    }
  }
  return violations;
}

/**
 * A literal-string type, or a union all of whose members are — the shape
 * `ts.resolveModuleName` and the destructuring-key lookup below both need.
 * `string`, `any`, `unknown`, or a union that mixes in a non-literal member
 * all return null: not resolvable to a finite set of names.
 */
function stringLiteralsOfType(t) {
  if (t.isStringLiteral()) return [t.getLiteralValueOrThrow()];
  if (t.isUnion()) {
    const parts = t.getUnionTypes();
    if (parts.length > 0 && parts.every((p) => p.isStringLiteral())) {
      return parts.map((p) => p.getLiteralValueOrThrow());
    }
  }
  return null;
}

/**
 * Item 5c: a destructuring key that is not a plain identifier — quoted
 * (`{ "withBypassRls": x }`) or computed (`{ [key]: x }`) — resolves through
 * the PATTERN's type rather than through text, because there is no name here
 * for the syntactic pass's staticMemberName to read. A computed key's own
 * candidate name(s) come from ITS type, the same literal-or-union-of-literals
 * shape item 5 needs for a module specifier. Resolving to a real, non-helper
 * property is not this gate's concern and passes silently; resolving to a
 * helper, or failing to resolve at all (the key's type is not a provable
 * literal, or the pattern's type has no such property), is a violation —
 * simplified from "bind the local name so a later call is analysed" (the
 * plan's phrasing) to "report at the binding site immediately": propagating
 * the binding into the syntactic call-scanner would mean reconciling node
 * identity across two independently-parsed trees (the Program's and
 * astProject's) for a shape that, on the measured real tree, occurs nowhere
 * outside tests — reporting immediately is strictly MORE conservative
 * (fail-closed), never less, than deferring to a downstream call site that
 * might not exist.
 */
function destructuringKeyViolationsIn(psf, helperDeclKeys) {
  const violations = [];
  for (const el of psf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const propNode = el.getPropertyNameNode();
    if (!propNode) continue; // shorthand `{ x }` — identifier-named, already covered by staticMemberName
    const kind = propNode.getKind();
    if (kind === SyntaxKind.Identifier) continue; // `{ withBypassRls: alias }` — already covered
    if (
      kind !== SyntaxKind.StringLiteral &&
      kind !== SyntaxKind.NoSubstitutionTemplateLiteral &&
      kind !== SyntaxKind.ComputedPropertyName
    ) {
      continue;
    }
    const pattern = el.getParentOrThrow();
    if (pattern.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
    const patternType = pattern.getType();

    let candidates;
    if (kind === SyntaxKind.ComputedPropertyName) {
      candidates = stringLiteralsOfType(propNode.getExpression().getType());
    } else {
      candidates = [propNode.getLiteralText()];
    }
    if (candidates === null) {
      violations.push({ line: el.getStartLineNumber(), text: el.getText() });
      continue;
    }

    // A type answered ENTIRELY by a string index signature (a Prisma client's
    // `[model: string]: Delegate`, say) has no NAMED property for
    // getProperty to find, yet the access is fully explained by the type —
    // it is not "failing to resolve" in item 5c's sense at all, and an index
    // signature can never BE one of the four helper FunctionDeclarations, so
    // it is resolved and definitely not a helper. Checked once per pattern,
    // not per candidate: the signature is a property of the type, not of the
    // literal name being looked up.
    const indexType = patternType.getStringIndexType();
    let resolvedAny = Boolean(indexType);
    let resolvedHelper = false;
    for (const name of candidates) {
      const prop = patternType.getProperty(name);
      if (!prop) continue;
      resolvedAny = true;
      if (symbolIsHelper(prop, helperDeclKeys)) resolvedHelper = true;
    }
    if (!resolvedAny || resolvedHelper) {
      violations.push({ line: el.getStartLineNumber(), text: el.getText() });
    }
  }
  return violations;
}

/**
 * Item 6, Rule A: an expression whose type carries a helper (typeCarriesHelper)
 * may appear ONLY as the receiver of a literal-named property access or
 * literal-keyed element access — those two positions are simply never queried
 * here, which is how this stays a type query at specific SYNTACTIC POSITIONS
 * rather than one at every identifier (S2-F1): a non-literal element access,
 * a call/new argument (which subsumes Object.values/entries/Reflect.get — all
 * three are just calls with the value as an argument, needing no special
 * case), a spread (array, call, or object), a for…in subject, an object-rest
 * destructuring source, and an assignment to `globalThis`. Every file stays in
 * the scan; narrowing by import graph is forbidden (a helper-carrying value
 * reaches a file through an inferred generic or a parameter with no import
 * edge to follow — SC4's class, the one this rule exists to close).
 */
function ruleAViolationsIn(psf, helperDeclKeys) {
  const violations = [];
  const flag = (node, reason) => {
    violations.push({ line: node.getStartLineNumber(), text: node.getText().slice(0, 80), reason });
  };

  for (const access of psf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const argExpr = access.getArgumentExpression();
    if (argExpr && literalMemberName(argExpr) !== null) continue; // literal-keyed — allowed
    if (typeCarriesHelper(access.getExpression().getType(), helperDeclKeys)) {
      flag(access, "non-literal element access on a helper-carrying receiver");
    }
  }

  for (const call of [
    ...psf.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...psf.getDescendantsOfKind(SyntaxKind.NewExpression),
  ]) {
    for (const arg of call.getArguments()) {
      if (typeCarriesHelper(arg.getType(), helperDeclKeys)) {
        flag(arg, "helper-carrying value passed as an argument");
      }
    }
  }

  for (const spread of [
    ...psf.getDescendantsOfKind(SyntaxKind.SpreadElement),
    ...psf.getDescendantsOfKind(SyntaxKind.SpreadAssignment),
  ]) {
    if (typeCarriesHelper(spread.getExpression().getType(), helperDeclKeys)) {
      flag(spread, "helper-carrying value spread");
    }
  }

  for (const stmt of psf.getDescendantsOfKind(SyntaxKind.ForInStatement)) {
    if (typeCarriesHelper(stmt.getExpression().getType(), helperDeclKeys)) {
      flag(stmt, "helper-carrying value used as a for...in subject");
    }
  }

  for (const pattern of psf.getDescendantsOfKind(SyntaxKind.ObjectBindingPattern)) {
    if (!pattern.getElements().some((el) => el.getDotDotDotToken())) continue;
    const decl = pattern.getParentOrThrow();
    const init = decl.getKind() === SyntaxKind.VariableDeclaration ? decl.getInitializer() : null;
    if (init && typeCarriesHelper(init.getType(), helperDeclKeys)) {
      flag(init, "helper-carrying value destructured with an object-rest element");
    }
  }
  for (const literal of psf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const parent = literal.getParent();
    if (parent?.getKind() !== SyntaxKind.BinaryExpression || parent.getLeft() !== literal) continue;
    if (!literal.getProperties().some((p) => p.getKind() === SyntaxKind.SpreadAssignment)) continue;
    if (typeCarriesHelper(parent.getRight().getType(), helperDeclKeys)) {
      flag(parent, "helper-carrying value destructured with an object-rest element");
    }
  }

  for (const bin of psf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = bin.getLeft();
    const base =
      left.getKind() === SyntaxKind.PropertyAccessExpression || left.getKind() === SyntaxKind.ElementAccessExpression
        ? unwrapExpression(left.getExpression())
        : null;
    if (base?.getKind() !== SyntaxKind.Identifier || base.getText() !== "globalThis") continue;
    if (typeCarriesHelper(bin.getRight().getType(), helperDeclKeys)) {
      flag(bin, "helper-carrying value assigned to globalThis");
    }
  }

  return violations;
}

/**
 * Item 6, Rule B: an element access on a receiver typed `any`/`unknown` whose
 * KEY type is not a string-literal union is a violation — the receiver could
 * be anything, including the RLS module reached through an untyped load, so a
 * key this gate cannot enumerate is refused rather than assumed harmless.
 * Scoped to ElementAccessExpression nodes only (not every identifier), which
 * is what keeps this a bounded type query — measured 575 element accesses
 * under src/ on the real tree, not the whole corpus's identifier count.
 * A NUMERIC key is not a candidate: Rule B's threat model is a MEMBER NAME
 * (a helper is reached by property name, never by array index), so `x[0]` on
 * an any-typed `x` is not this rule's subject — real-tree evidence:
 * `password-import-parsers.ts`'s `uris[0]`, which the plan's own "2 hits"
 * count excludes.
 */
function ruleBViolationsIn(psf) {
  const violations = [];
  for (const access of psf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const recvType = access.getExpression().getType();
    if (!recvType.isAny() && !recvType.isUnknown()) continue;
    const argExpr = access.getArgumentExpression();
    if (!argExpr) continue;
    const keyType = argExpr.getType();
    if (keyType.isNumber() || keyType.isNumberLiteral()) continue;
    const isLiteralUnion =
      keyType.isStringLiteral() ||
      (keyType.isUnion() && keyType.getUnionTypes().length > 0 && keyType.getUnionTypes().every((t) => t.isStringLiteral()));
    if (!isLiteralUnion) {
      violations.push({ line: access.getStartLineNumber(), text: access.getText().slice(0, 80) });
    }
  }
  return violations;
}

/** True when `t`'s symbol is TypeScript's own `NodeJS.Require` / `NodeRequire` — the return type of `createRequire(...)`. */
function isRequireLikeType(t) {
  const name = t.getSymbol()?.getName();
  return name === "Require" || name === "NodeRequire";
}

function couldBeStringSpecifier(t) {
  if (t.isAny() || t.isUnknown()) return true;
  if (t.isString() || t.isStringLiteral()) return true;
  if (t.isUnion()) return t.getUnionTypes().some(couldBeStringSpecifier);
  return false;
}

/** The static head of a template specifier — the text before the first `${`. Null for anything else (a plain literal goes through literalMemberName instead). */
function templateHeadText(node) {
  if (node.getKind() !== SyntaxKind.TemplateExpression) return null;
  return node.getHead().getLiteralText();
}

/** This repo's one `@/*` path alias, read from the Program's own compilerOptions rather than hardcoded — resolveModuleName already applies it for a literal specifier; a template head needs the same mapping done by hand. */
function resolveAliasPrefix(compilerOptions, cwd) {
  for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
    if (!pattern.endsWith("/*") || !targets[0]) continue;
    return { prefix: pattern.slice(0, -1), dir: resolve(cwd, targets[0].replace(/\*$/, "")) };
  }
  return null;
}

/**
 * `resolveJsonModule` pulls `.json` files into the Program's dependency
 * graph too (messages.ts's own sibling namespace files, imported statically
 * elsewhere) — real Program source files, but not ones a template head's
 * containment check cares about: a helper is declared in a `.ts`/`.tsx`
 * FunctionDeclaration, never a JSON value, so counting a JSON hit under
 * `messages/` read `../../messages/` (messages.ts's own passing template) as
 * "inside the source set" and refused its own legitimate load.
 */
function programSourceSetContains(program, dir) {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return program.getSourceFiles().some((f) => {
    const ext = extname(f.getFilePath());
    if (ext !== ".ts" && ext !== ".tsx") return false;
    const p = f.getFilePath();
    return p === dir || p.startsWith(prefix);
  });
}

/**
 * A template specifier's resolution step (S2-F3): its TYPE is plain `string`,
 * and refusing every template outright would refuse messages.ts. The head
 * must end in `/` — a head ending mid-segment (`../../lib/tenant-${x}`) names
 * a filename PREFIX, not a directory, and treating it as one lets a
 * substitution complete to `tenant-rls.ts` while the containment check looks
 * under a directory that does not exist (S3-F2). Such a head is REFUSED, as is
 * an empty head or one with no `/` at all, and one that resolves inside the
 * Program's source set. An alias head (`@/…`) resolves through tsconfig paths
 * first and therefore lands inside the source set — refused.
 */
function templateHeadVerdict(head, containingFile, program, alias) {
  if (head === "") return "REFUSED";
  if (!head.includes("/")) return "REFUSED";
  if (!head.endsWith("/")) return "REFUSED";
  const dir =
    alias && head.startsWith(alias.prefix)
      ? join(alias.dir, head.slice(alias.prefix.length))
      : resolve(dirname(containingFile), head);
  return programSourceSetContains(program, dir) ? "REFUSED" : "PASS";
}

/**
 * Item 5: module loads judged by the specifier's TYPE, with no allowlist
 * (S-F1; NON_LITERAL_LOAD_ALLOWLIST is a forbidden pattern — an allowlist
 * keyed by file or text cannot see laundering through an exported wrapper).
 * Subjects: `import(…)`, a `require(…)` call, a call through a value typed
 * `NodeJS.Require`, and a call through an `any`-typed callee with EXACTLY ONE
 * argument — the require-shaped arity, which bounds this last branch
 * (F-R2-3). That branch also selects one-argument calls that have nothing to
 * do with module loading (F-R3-4): `value.bind(x)` off an untyped Prisma proxy
 * result, measured on the real tree, is exactly this — its argument's type
 * (a Prisma transaction client) has no overlap with `string` at all, so
 * couldBeStringSpecifier is false and the call is never even a candidate,
 * rather than being refused for an argument that could never be a specifier.
 * A candidate whose specifier resolves to a literal (or a union of them) is
 * checked by containment; a candidate typed `string`/`any`/`unknown` with no
 * literal reduction is REFUSED — the gate cannot prove where it points.
 *
 * A plain `import("…tenant-rls")` / `require("…tenant-rls")` — a literal
 * matching TENANT_RLS_MODULE_RE — is exempted here: runtimeHelperModulesIn
 * already recognises and tracks it, and re-flagging it as ALSO a violation
 * under this rule would fail every one of that mechanism's own legitimate
 * call sites (the two vault routes). The exemption applies to the plain
 * `import()`/`require()` forms only — a `NodeRequire`-typed value or an
 * `any`-callee call spelled some other way is not what
 * runtimeHelperModulesIn's `isLoad` test recognises, literal specifier or
 * not, so those still go through full resolution.
 */
function moduleLoadViolationsIn(psf, program, checker, helperDeclKeys, alias) {
  const violations = [];
  const compilerOptions = program.getCompilerOptions();
  const containingFile = psf.getFilePath();

  const literalHostsHelper = (literal) => {
    const resolved = ts.resolveModuleName(literal, containingFile, compilerOptions, ts.sys);
    const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
    if (!resolvedFileName) return false;
    const targetSf = program.getSourceFile(resolvedFileName);
    if (!targetSf) return false;
    return exportsAnyHelper(targetSf, checker, helperDeclKeys);
  };

  for (const call of psf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isImportCall = expr.getKind() === SyntaxKind.ImportKeyword;
    const isRequireIdent = expr.getKind() === SyntaxKind.Identifier && expr.getText() === "require";
    const args = call.getArguments();

    let subject = isImportCall || isRequireIdent;
    if (!subject) {
      const calleeType = expr.getType();
      subject = isRequireLikeType(calleeType) || (calleeType.isAny() && args.length === 1);
    }
    if (!subject || args.length === 0) continue;

    const argExpr = args[0];
    // `__filename` / `__dirname` are Node's own ambient globals, typed `string`
    // — structurally the CURRENT file's own path, never a specifier naming
    // something to load. Without this, `createRequire(__filename)` (the
    // key-provider files' own factory call, one line above their real
    // `req("@aws-sdk/…")` load) is an any-callee, one-argument, string-typed
    // call like any other and is REFUSED for an argument that could never
    // have been a module path — recognising a language primitive, the same
    // way Rule A recognises `globalThis` by identifier text, not judging
    // application code by its spelling.
    if (argExpr.getKind() === SyntaxKind.Identifier && (argExpr.getText() === "__filename" || argExpr.getText() === "__dirname")) {
      continue;
    }
    if (isImportCall || isRequireIdent) {
      const lit = literalMemberName(argExpr);
      if (lit !== null && TENANT_RLS_MODULE_RE.test(lit)) continue;
    }

    const headText = templateHeadText(argExpr);
    if (headText !== null) {
      if (templateHeadVerdict(headText, containingFile, program, alias) === "REFUSED") {
        violations.push({
          line: call.getStartLineNumber(),
          text: `template specifier with an unprovable or in-scope head: ${JSON.stringify(headText)}`,
        });
      }
      continue;
    }

    const argType = argExpr.getType();
    if (!couldBeStringSpecifier(argType)) continue; // not even candidate-shaped — cannot be a specifier
    const literals = stringLiteralsOfType(argType);
    if (literals === null) {
      violations.push({ line: call.getStartLineNumber(), text: "module load specifier is not a provable string literal" });
      continue;
    }
    for (const literal of literals) {
      if (literalHostsHelper(literal)) {
        violations.push({
          line: call.getStartLineNumber(),
          text: `module load resolves to a helper-exporting file: ${JSON.stringify(literal)}`,
        });
        break;
      }
    }
  }
  return violations;
}

// "Examined nothing" must not be spelled like "found nothing" at the corpus
// level either: a wrong cwd, a moved tree or a broken walk would otherwise
// print OK after scanning zero files. readdirSync throws when `src/` is absent;
// this covers the present-but-empty case it cannot. Checked BEFORE the Program
// build below: a missing tsconfig.json and a missing src/ are two different
// refusals, and a fixture that has neither must still read as "nothing was
// examined" rather than "the Program could not be built" — the corpus-level
// question this gate has always asked first.
const sourceFiles = getSourceFiles();
if (sourceFiles.length === 0) {
  console.error("check-bypass-rls: no .ts/.tsx source files found under src/.");
  console.error("Nothing was examined, so this is not a pass. Check the working directory.");
  process.exit(1);
}

const program = buildProgram();
const helperDecls = resolveHelperDeclarations(program);
const helperDeclKeys = buildHelperDeclKeySet(helperDecls);
const checker = program.getTypeChecker();
const aliasPrefix = resolveAliasPrefix(program.getCompilerOptions(), process.cwd());
const externalRefsByFile = collectExternalReferences(program, helperDecls);
const programOnlyFiles = new Set(externalRefsByFile.keys());

const crossCheckViolations = [];
const starExportViolations = [];
const destructuringKeyViolations = [];
const ruleAViolations = [];
const ruleBViolations = [];
const moduleLoadViolations = [];

// Items 5, 5b, 5c and 6 read "outside the defining files" the same way 5b's
// own text does. The two defining files are always the REAL tenant-rls.ts /
// tenant-context.ts (the fixture harness copies them verbatim rather than
// hand-writing stubs), and their own unrelated imports are routinely
// unresolvable in a fixture tree that carries only these two files — an
// unresolved import widens to `any`, and an `any`-typed one-argument call
// elsewhere in the SAME file (`UUID_RE.test(tenantId)`, nothing to do with a
// module load) would otherwise become a type-based false positive for item 5
// that has nothing to do with what these two files are being scanned FOR.
// The real tree's own run confirms nothing is lost: with every import
// resolved, these two files raise zero item 5/6 findings anyway.
const definingFiles = new Set(HELPER_DECLARATIONS.map((d) => d.file));

for (const psf of program.getSourceFiles()) {
  const file = toRelPosix(psf.getFilePath());
  if (!isInScopeFile(file) || definingFiles.has(file)) continue;
  for (const v of bareStarExportViolationsIn(psf, checker, helperDeclKeys)) starExportViolations.push({ file, ...v });
  for (const v of destructuringKeyViolationsIn(psf, helperDeclKeys)) destructuringKeyViolations.push({ file, ...v });
  for (const v of ruleAViolationsIn(psf, helperDeclKeys)) ruleAViolations.push({ file, ...v });
  for (const v of ruleBViolationsIn(psf)) ruleBViolations.push({ file, ...v });
  for (const v of moduleLoadViolationsIn(psf, program, checker, helperDeclKeys, aliasPrefix)) {
    moduleLoadViolations.push({ file, ...v });
  }
}

const astProject = createAstProject();
const unparseableFiles = [];
const fileViolations = [];
const modelViolations = [];
/**
 * file -> models actually reached under a bypass, and whether anything in
 * that file defeated the analysis. The second half is what keeps the
 * over-breadth check below from reading an undecidable file as an unused
 * permission.
 */
const usedModels = new Map();
const undecidableFiles = new Set();
let handedOffSites = 0;
/**
 * Files that make at least one real `withBypassRls` call, or hold a helper reference
 * this gate reports as unfollowable (round 13). The whole-entry check reads it: such a
 * file already fails, and telling its reviewer to delete the entry would be wrong.
 */
const bypassCallFiles = new Set();
const purposeViolations = [];
const txLessViolations = [];
const indirectCallbacks = [];
const indirectHelperReferences = [];
const unresolvedClients = [];
const unresolvedModels = [];
const f3UnusedTxViolations = [];

let parsedCount = 0;

for (const file of sourceFiles) {
  // Skip test files — they mock withBypassRls, not call it for real
  if (file.includes(".test.") || file.includes("__tests__")) continue;

  const content = readFileSync(file, "utf8");
  // Item 4: a file the Program alone found a helper reference in — a renamed
  // re-export's downstream use, say — is parsed even when its own text never
  // mentions a helper at all (HELPER_MENTION_RE would never select it).
  if (!HELPER_MENTION_RE.test(content) && !programOnlyFiles.has(file)) continue;

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

  const calls = filterCallsByReceiverDeclaration(
    helperCallsIn(sf),
    program.getSourceFile(join(process.cwd(), file)),
    helperDeclKeys,
  );
  const bypassCalls = calls.filter(({ helper }) => helper === "withBypassRls");
  if (bypassCalls.length > 0) bypassCallFiles.add(file);

  // A helper this gate cannot follow as a direct call reaches none of the checks
  // below, so the reference itself fails (round 13).
  const helperNames = localHelperNames(sf);
  const indirect = indirectHelperReferencesIn(sf);
  for (const ref of indirect) {
    const ambiguous = helperNames.get(ref.getText()) === AMBIGUOUS_HELPER;
    indirectHelperReferences.push({
      file,
      line: ref.getStartLineNumber(),
      text: ambiguous ? `${ref.getText()} (bound to more than one RLS helper in this file)` : ref.getText(),
    });
  }
  if (indirect.length > 0) bypassCallFiles.add(file);

  // Item 3: every REAL reference the Program found in this file, that the
  // syntactic pass above did not already account for (a call, an
  // already-reported indirect reference, a recognised import/export
  // binding, or a type position) — a form this gate does not analyse.
  const externalRefs = externalRefsByFile.get(file);
  if (externalRefs) {
    const accounted = accountedPositionsIn(sf, calls, indirect);
    for (const ref of externalRefs) {
      if (!accounted.has(ref.start)) {
        crossCheckViolations.push({ file, line: ref.line, helperName: ref.helperName });
      }
    }
  }

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
    const { clients, modelRefs, clientUnresolved, unresolved, callbackNodes, handedOff } =
      clientBindingsIn(fn, flowFor(), call.getArguments()[0], bindingsFor);
    if (clientUnresolved) { unresolvedClients.push({ file, line }); undecidableFiles.add(file); }
    if (handedOff.length > 0) {
      handedOffSites += handedOff.length;
      undecidableFiles.add(file);
    }
    const seen = new Set();
    // The call itself (its other arguments can hold model access) plus every
    // callback the analyser reached, wherever each is declared. Overlap is
    // harmless: reports are deduplicated by model and line.
    const scanNodes = [call, ...callbackNodes];
    const report = ({ model, line }) => {
      const key = `${model}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!usedModels.has(file)) usedModels.set(file, new Set());
      usedModels.get(file).add(model);
      if (!allowedSet.has(model)) modelViolations.push({ file, line, model });
    };
    // Delegates lifted straight off a client by destructuring, then every
    // `<client>.<model>` reached through any identifier that carries the client.
    for (const ref of modelRefs) report(ref);
    for (const u of unresolved) {
      unresolvedModels.push({ file, line: u.line, text: u.text });
      undecidableFiles.add(file);
    }
    for (const node of scanNodes) {
      const { refs, unresolved } = modelRefsIn(node, clients);
      for (const ref of refs) report(ref);
      for (const u of unresolved) {
        const key = `?:${u.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unresolvedModels.push({ file, line: u.line, text: u.text });
        undecidableFiles.add(file);
      }
    }
  }
}

/**
 * The reverse direction: a model this file is permitted to reach under a
 * bypass and never does. The permission outlives its reason, and the next
 * reader takes the entry for the file's documented scope — `notification.ts`
 * carried `user` for a read it had already moved into the adjudicator.
 *
 * Skipped for a file whose analysis was defeated anywhere (an unresolved
 * client or model access): there, "never reached" means "not seen".
 */
const staleAllowances = [];
for (const [file, models] of ALLOWED_USAGE) {
  if (models.includes("*") || undecidableFiles.has(file)) continue;
  const reached = usedModels.get(file);
  if (!reached) continue; // reached no model: a file with no bypass call is judged whole, below
  for (const model of models) {
    if (!reached.has(model)) staleAllowances.push({ file, model });
  }
}

/**
 * The whole-entry form of the same question: an ALLOWED_USAGE entry whose file
 * makes no `withBypassRls` call at all. The per-model check above skips such a
 * file — it reached no model because it opened no bypass — and its comment used
 * to call that "Check 1's business". It is not: Check 1 fires only in the other
 * direction, a call with no entry, so this direction was checked by nothing.
 *
 * NOT judged here, each for a stated reason:
 *   - `["*"]` entries, the helpers' own definition;
 *   - a file this run could not parse, which is reported on its own above;
 *   - a file that sets `app.bypass_rls` through raw SQL. That is a real bypass
 *     this gate cannot see; `check-raw-sql-usage` requires such a file to be
 *     allowlisted with a stated purpose, so the entry here documents a scope
 *     nothing in this gate enforces, rather than one that has gone stale;
 *   - a file absent from the tree being scanned. The self-test runs this gate on
 *     one-file fixture trees, so absence is asserted by a real-repo cell there.
 */
const RAW_BYPASS_GUC_RE = /set_config\(\s*'app\.bypass_rls'\s*,\s*'on'/;
const unparseableFileSet = new Set(unparseableFiles.map(({ file }) => file));
const staleEntries = [];
for (const [file, models] of ALLOWED_USAGE) {
  if (models.includes("*") || bypassCallFiles.has(file) || unparseableFileSet.has(file)) continue;
  if (!existsSync(file)) continue;
  if (RAW_BYPASS_GUC_RE.test(readFileSync(file, "utf8"))) continue;
  staleEntries.push(file);
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

if (staleEntries.length > 0) {
  failed = true;
  if (modelViolations.length > 0) console.error("");
  console.error("ALLOWED_USAGE has an entry for a file that makes no withBypassRls call.");
  console.error("Remove it: the entry reads as a bypass this file performs, and it performs none.");
  console.error("");
  for (const file of staleEntries) console.error(`  ${file}`);
}

if (staleAllowances.length > 0) {
  failed = true;
  if (modelViolations.length > 0) console.error("");
  console.error(
    "ALLOWED_USAGE permits a model the file never reaches under a bypass.",
  );
  console.error(
    "Remove it: a permission that outlives its reason reads to the next",
  );
  console.error(
    "reviewer as the scope this file is meant to have.",
  );
  console.error("");
  for (const { file, model } of staleAllowances) {
    console.error(`  ${file}  prisma.${model}`);
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

if (indirectHelperReferences.length > 0) {
  failed = true;
  console.error("");
  console.error("with*Rls helper referenced in a form this gate cannot follow as a direct call.");
  console.error(
    "The file allowlist, the purpose check and the model scan see only `helper(…)` and",
  );
  console.error("`ns.helper(…)`, so these references were NOT checked. Call the helper directly:");
  console.error("");
  for (const { file, line, text } of indirectHelperReferences) {
    console.error(`  ${file}:${line}  ${text}`);
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

// C3 item 3: a reference the Program found that no syntactic mechanism above
// already accounts for — a renamed re-export, a named re-export under an
// unrelated module, or a namespace reached through `export * as ns`, used in
// a file the text-based prefilter would never have connected to a helper.
if (crossCheckViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "with*Rls helper reached by a form this gate does not analyse (Program cross-check).",
  );
  console.error(
    "The reference is real (the language service resolved it to the helper's own",
  );
  console.error(
    "declaration) but no syntactic recognition here accounts for it — call the helper",
  );
  console.error("directly from its own module:");
  console.error("");
  for (const { file, line, helperName } of crossCheckViolations) {
    console.error(`  ${file}:${line}  ${helperName}`);
  }
}

// C3 item 5b: a bare `export *` whose target exports a helper — refused at
// the barrel itself, since the re-export produces no reference for item 3 to
// find downstream.
if (starExportViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("`export *` re-exports a module that exports a with*Rls helper.");
  console.error(
    "This produces no reference the Program cross-check can follow, so the barrel",
  );
  console.error("is refused outright. Export the helper by name, or do not re-export it:");
  console.error("");
  for (const { file, line, text } of starExportViolations) {
    console.error(`  ${file}:${line}  ${text}`);
  }
}

// C3 item 5c: a quoted or computed destructuring key over a helper-carrying
// pattern — resolved, or refused, through the pattern's type.
if (destructuringKeyViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "destructuring key is not a plain identifier and either resolves to a with*Rls",
  );
  console.error("helper or could not be resolved at all:");
  console.error("");
  for (const { file, line, text } of destructuringKeyViolations) {
    console.error(`  ${file}:${line}  ${text}`);
  }
}

// C3 item 6, Rule A: a helper-carrying value used somewhere other than a
// literal-named/keyed receiver.
if (ruleAViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "a value whose type carries a with*Rls helper is used somewhere other than a",
  );
  console.error(
    "literal-named property access or literal-keyed element access:",
  );
  console.error("");
  for (const { file, line, text, reason } of ruleAViolations) {
    console.error(`  ${file}:${line}  ${reason}: ${text}`);
  }
}

// C3 item 6, Rule B: an any/unknown-typed receiver, element-accessed by a key
// this gate cannot enumerate.
if (ruleBViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(
    "element access on an any/unknown-typed receiver whose key is not a string-literal",
  );
  console.error("union — this gate cannot prove the access does not reach a with*Rls helper:");
  console.error("");
  for (const { file, line, text } of ruleBViolations) {
    console.error(`  ${file}:${line}  ${text}`);
  }
}

// C3 item 5: a module load judged by the specifier's TYPE — no allowlist.
if (moduleLoadViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("module load specifier could not be proven safe:");
  console.error("");
  for (const { file, line, text } of moduleLoadViolations) {
    console.error(`  ${file}:${line}  ${text}`);
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
  `check-bypass-rls: OK (parsed ${parsedCount} of ${scannableCount} scannable source files; ` +
    `${handedOffSites} call site(s) hand the client to a callee outside the file, ` +
    `so those files are exempt from the over-breadth check)`,
);
