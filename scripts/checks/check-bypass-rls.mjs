#!/usr/bin/env node
/**
 * CI guard: ensure withBypassRls is only called from approved files (Check 1),
 * that every call names a grant from src/lib/tenant-rls-grants.ts (Check 2),
 * and that each call reaches only the Prisma models its grant lists (Check 3).
 * Three further rules keep the bypass settings behind that registry: the
 * writer, pool and function rules (below).
 *
 * Any new usage of withBypassRls must be explicitly added to ALLOWED_USAGE
 * after security review. This prevents accidental RLS bypass in new code.
 *
 * Check 3 is a per-call grant comparison: the models a call's callback can
 * reach (directly, or through a forwarder whose BypassGrant parameter the
 * call's production callers fill) against the models of the BYPASS_GRANT
 * member it names, read off the registry's AST (`NAME: defineGrant(
 * BYPASS_PURPOSE.X, [models])`). A reached model the grant does not list
 * fails; a grant no call or self-setting site names fails as stale, and so
 * does a model a grant lists that no call naming it reaches (grants are
 * shared, so it is judged across all of them).
 *
 * This is a partial, development-time preventive control, not a tenant
 * boundary. Code this analysis does not follow (the shapes recorded in #911
 * and #910, and future ones) can reach a model its grant does not list. The
 * database is the adjudicator: a bypassed statement that examines a row of an
 * RLS table outside `app.bypass_tables` is reported now (report mode, a
 * WARNING the pool factory's listener logs) and will be refused once SC5
 * flips `public.rls_bypass_enforced()`. This gate catches the honest mistake
 * before that report does.
 *
 * Writer rule: raw-SQL string and template arguments ($executeRaw/$queryRaw
 * and their Unsafe forms, Prisma.sql/Prisma.raw, a pg `query` call), with
 * literal concatenation and const bindings constant-folded, are lexed as SQL.
 * Outside src/lib/tenant-rls.ts and the grants module, a statement-leading
 * SET/RESET, ALTER … SET, a DO block, EXECUTE, or any `set_config` identifier
 * (plain, quoted, `pg_catalog.`-qualified, U&-escaped) fails the run: the
 * bypass is turned on through setBypassGucs only. SQL built at run time from
 * values this gate cannot fold is outside its reach.
 *
 * Pool rule: `new pg.Pool`, `new Pool`, `new pg.Client`, `new Client` and `new
 * PrismaPg` (by spelling or by a binding from "pg"/the adapter package) appear
 * only in src/lib/db/pool-factory.ts, whose pools carry the notice listener;
 * read by AST over every code file under src/ and scripts/, tests included.
 * POOL_RULE_ALLOWLIST names the superuser and no-bypass exceptions.
 *
 * Function rule: no literal in a code file under src/ or scripts/, and no text
 * file under src/, scripts/ or .github/, holds a `CREATE [OR REPLACE]
 * FUNCTION|PROCEDURE` token sequence — a routine body or a function-level
 * SET clause writes settings where the writer rule cannot see. Routines are
 * created in prisma/migrations; FUNCTION_RULE_ALLOWLIST names the exceptions.
 *
 * Call sites and callbacks are read from the parse tree; raw text decides only
 * which files are worth parsing — see HELPER_MENTION_RE.
 *
 * Reach (Check 3) is decided by REACH and TYPES through the
 * type-checked Program and lib/function-resolver.mjs (shared with
 * check-rls-nesting): everything that can run inside a bypass callback is
 * reached — calls, `new` (field initializers, constructor, base classes),
 * tagged templates, own accessors, functions handed on as values, a wrapper's
 * callers' callbacks — and in every reached function each access whose
 * receiver is a Prisma client BY TYPE (its member is declared by the
 * generated PrismaClient, or the value has a model delegate's shape) is a
 * model reached under this bypass, and so is every query RUN on a delegate,
 * charged by the delegate's `<Model>Delegate` type where it runs. How the
 * client got there — a parameter, an object property, an alias, the ambient
 * `prisma` Proxy, a destructuring, a cast to `any` — no longer matters,
 * because no name is tracked. Anything reached that the resolver cannot name
 * fails the run (unfollowedHandOffs); a computed key on a client fails it too
 * (unresolvedModels). The resolver's answers rest on the forms
 * lib/soundness.mjs refuses (G1-G7, the deny-by-default scan set), which this
 * gate checks itself as well as check-rls-nesting; those rules keep the
 * analysis tractable, not complete. A client or delegate
 * given a type that no longer says it is one (`unknown`, an own interface, a
 * Pick that drops the query methods) is refused anywhere in production; a
 * narrowing to the client's four raw-query methods alone is raw SQL's to judge,
 * and a grant one of whose calls reaches raw SQL is not judged stale (the
 * tables, procedures and triggers that SQL reaches are not read here).
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
 *   - Check 2 (BYPASS_GRANT) is call-scoped and resolved through the
 *     Program: each `withBypassRls` call passes a member of the real
 *     BYPASS_GRANT (a shadowing local object does not pass; a renamed import
 *     resolves), or forwards a parameter whose TYPE is BypassGrant, in which
 *     case every production caller of that forwarder names the grant and is
 *     charged with what the forwarded call reaches. An inline defineGrant, a
 *     conditional, a spread or a cast does not resolve and fails. A file in
 *     ALLOWED_PURPOSES may name only grants whose purpose is listed there,
 *     directly or through a forwarder.
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
 *   - The scan root is deny-by-default: every own file in the Program that
 *     NON_PRODUCTION / NON_PRODUCTION_SCRIPTS (lib/function-resolver.mjs) does
 *     not declare, plus every module they load (lib/soundness.mjs
 *     productionScope). The manual-test scripts call these helpers and are
 *     examined by nothing; listed tooling whose imports reach the RLS helpers
 *     or the client is refused. A file the tsconfig excludes (extension/, cli/)
 *     is outside the Program and read by neither gate.
 *   - INDIRECT_CALLBACK_ALLOWLIST is keyed by file, so a NEW unresolvable call
 *     site inside an already-listed file is excused without review.
 *   - Check 3's coverage limits are the shared reachability's (see
 *     check-rls-nesting's header for the list), plus: a delegate whose type
 *     stays `any` all the way to its query is not charged (the query is a call
 *     on an `any` value, which fails the run only when it is a function value
 *     the resolver must name; a typed client erased to `any` is refused at the
 *     erasure), and a library object built around the ambient
 *     client outside the reached code (`const repo = makeRepo(prisma)` at
 *     module level) is not seen. A client handed INTO a library call inside
 *     reached code — bare, in an object or array, returned by a closure, or
 *     to a callee that may be library code — fails the run.
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
  unwrapExpression,
} from "./lib/scope-bindings.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createFunctionResolver, createReachability, isBindingWrite, isProductionPath, literalKey, prismaModelNames, unwrap } from "./lib/function-resolver.mjs";
import { flowsOf, functionFlowViolations, productionScope } from "./lib/soundness.mjs";
import { nameOf, tokenizeSql, TOKEN } from "./lib/sql-scan.mjs";
import {
  FILTERING,
  ORDERING,
  SchemaReadError,
  WRITING,
  loadPrismaSchema,
  objectLiterals,
  walkCallArgs,
} from "./lib/prisma-relation-reach.mjs";
import { join, extname, dirname, relative, resolve, sep } from "node:path";

// The files that may call withBypassRls (Check 1). Which models a call may
// reach is no longer listed here: it is the call's own grant
// (src/lib/tenant-rls-grants.ts), compared by Check 3.
const ALLOWED_USAGE = new Set([
  "src/lib/tenant-rls.ts", // definition
  // `user`: `resolveExistingUsersForTenant`, the ownership read SCIM POST and
  // directory sync consult before attaching an existing user. It must see users
  // filed under other tenants — to REFUSE them — and it lives here, beside
  // `resolveOwningTenantIdFromClient`, because it applies the same owning-tenant
  // rule. Read-only; returns ids and a classification, no identity.
  "src/lib/tenant-context.ts",
  // The standalone realignment for producers that activate a membership inside a
  // TENANT context (SCIM, directory sync): that context cannot write a users row
  // the owning column files under another tenant. Re-reads the membership it
  // follows — only while still ACTIVE in the tenant named — then moves the column
  // through `realignOwningTenantColumn` and records both sides.
  // Realignment: the membership read, then realignToMembershipInTxWith's
  // owning-column move (user), stranded-row counts and the in-tx audit enqueue.
  "src/lib/tenant/tenant-realignment.ts",
  "src/lib/auth/session/auth-adapter.ts",
  // The Web-session cap (both sign-in creators route here): the tenant's
  // maxConcurrentSessions, then evict + create sessions under the per-user lock.
  "src/lib/auth/session/session-concurrency.ts",
  // Session callbacks and the sign-in realignment: tenant, user and membership
  // reads, the account/vault wipe on a tenant move ($transaction), the claim
  // registry (tenant-management), the stranded-row counts and the audit
  // enqueue — each call's own grant.
  "src/auth.ts",
  "src/lib/audit/audit.ts",
  "src/lib/audit/audit-outbox.ts",
  "src/lib/audit/audit-user-lookup.ts",
  "src/lib/auth/tokens/scim-token.ts",
  "src/lib/auth/tokens/extension-token.ts",
  // C5: shared DPoP validate helper for IOS_APP + BROWSER_EXTENSION rows.
  // Updates lastUsedAt / lastUsedIp / lastUsedUserAgent on the resolved row.
  "src/lib/auth/dpop/validate-token-dpop.ts",
  // C12: user-initiated key reset revokes the calling user's cnfJkt-bound
  // ExtensionToken rows (after body-cnfJkt-must-match-proof check).
  "src/app/api/extension/key/reset/route.ts",
  "src/lib/auth/access/maintenance-auth.ts",
  "src/app/api/extension/bridge-code/route.ts",
  "src/app/api/extension/token/exchange/route.ts",
  // A04-4: execute is the only phase that revokes shares system-wide; the
  // master key is global, so old-version shares across ALL tenants must be
  // revoked regardless of which tenant approved the rotation (NF4).
  // The legacy single-actor endpoint at /api/admin/rotate-master-key/route.ts
  // returned 410 Gone post-A04-4 and no longer touches PasswordShare — its
  // prior allowlist entry has been removed.
  "src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts",
  "src/app/api/maintenance/purge-history/route.ts",
  "src/app/api/teams/route.ts",
  "src/app/api/teams/pending-key-distributions/route.ts",
  // Team key distribution: guest members require cross-tenant public-key lookup
  "src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts",
  // Team invitations: existing-user lookup must see guest users across tenants
  "src/app/api/teams/[teamId]/invitations/route.ts",
  // Team key rotation prep: guest members require cross-tenant public-key lookup
  "src/app/api/teams/[teamId]/rotate-key/data/route.ts",
  "src/app/api/teams/invitations/accept/route.ts",
  "src/lib/auth/policy/account-lockout.ts",
  "src/lib/auth/policy/lockout-admin-notify.ts",
  "src/lib/auth/policy/new-device-detection.ts",
  // C8: shared fail-closed re-derivation of passkey-enforcement state for the
  // token-issuance gates (derivePasskeyState). Reads a user-global passkey
  // count + the tenant policy row under bypass — the cookieless token paths and
  // the session callback have no RLS context. Mirrors src/auth.ts's read.
  "src/lib/auth/policy/passkey-enforcement.ts",
  // Shared step-up helper: reads Session.createdAt from the session-token cookie.
  "src/lib/auth/session/step-up.ts",
  // Route-level chooser: selects passkey freshness vs generic recent-session by session provider.
  // C5 member 1: canRecoverSessionWithPasskey re-checks the bound credential row by id.
  "src/lib/auth/session/recent-current-auth-method.ts",
  "src/lib/notification.ts",
  "src/lib/webhook-dispatcher.ts",
  "src/lib/auth/access/tenant-auth.ts",
  // Admin console: cross-tenant team membership query for scope selector
  "src/lib/auth/access/team-auth.ts",
  // Vault wipe: deletes across the vault's tables in one $transaction, the
  // attachment blobs' rows, the emergency-access grants it ends, the audit
  // enqueue.
  "src/lib/vault/vault-reset.ts",
  "src/app/api/vault/admin-reset/route.ts",
  "src/lib/auth/tokens/api-key.ts",
  "src/lib/auth/webauthn/webauthn-authorize.ts",
  // `tenant` reads the policy row directly by id. These files used to reach the
  // same row by traversing `user.tenant`, which follows the stale `User.tenantId`
  // column; the adjudicator resolves the active membership first, so the tenant
  // is now loaded by that id. Same row, same bypass scope, named model.
  "src/app/api/auth/passkey/verify/route.ts",
  "src/app/api/auth/passkey/options/email/route.ts",
  // The cross-tenant reactivation guard: resolves the SCIM id and reads the
  // user's ACTIVE membership set, both of which are invisible inside the tenant
  // context this route mutates in. Read-only, and the tenant it compares against
  // is the authenticated SCIM token's, not caller-supplied.
  "src/app/api/scim/v2/Users/[id]/route.ts",
  // The user LIST reads under a bypass: its filter runs through the users
  // relation, which a tenant context narrows to users whose owning column names
  // this tenant, silently dropping departed members from the page and the count.
  // Every query carries the token's tenantId, ANDed so no filter can widen it.
  // Read-only. (The CREATE verb's ownership read moved into tenant-context.ts's
  // `resolveExistingUsersForTenant`, so this file no longer reads `user`.)
  "src/app/api/scim/v2/Users/route.ts",
  // C3: also reads the session row to resolve the bound credential.
  "src/app/api/auth/passkey/reauth/options/route.ts",
  "src/app/api/auth/passkey/reauth/verify/route.ts",
  "src/lib/auth/session/user-session-invalidation.ts",
  // C18 (OWASP A04-1): per-user / per-tenant resource quotas need to count
  // total usage that may span beyond the current request's tenant context.
  // RLS would clip the count to the calling tenant's view, producing
  // under-counts on shared resources. SYSTEM_MAINTENANCE bypass purpose.
  "src/lib/quota/resource-quotas.ts",
  "src/app/api/tenant/policy/route.ts",
  // Operator CLI (SSO tenant-claim registry, lockout recovery, owning-column
  // realignment). Runs out of band with MIGRATION_DATABASE_URL and must read and
  // repair rows across every tenant, which is the bypass itself. Its purpose is
  // pinned to SYSTEM_MAINTENANCE by ALLOWED_PURPOSES below.
  "scripts/tenant-domain.ts",
  // One-shot operator migrations, run with MIGRATION_DATABASE_URL. The account
  // token rewrite is raw SQL only (governed by check-raw-sql-usage); the webhook
  // secret rewrite reads and updates both webhook tables.
  "scripts/migrate-account-tokens-to-encrypted.ts",
  "scripts/migrate-webhook-secrets-v1-to-v2.ts",
  "src/lib/auth/policy/access-restriction.ts",
  "src/lib/team/team-policy.ts",
  // Team member display: cross-tenant user + home-tenant name hydration for guest members
  "src/lib/team/team-member-display.ts",
  // Session timeout resolver: cross-team policy read for session lifetime enforcement
  "src/lib/auth/session/session-timeout.ts",
  // Extension token refresh: tenant policy read keyed by the validated token
  // row's tenantId; family presence MAX + replay lookup of the presented token
  // (by tokenHash) span revoked rows of the same family.
  "src/app/api/extension/token/refresh/route.ts",
  // iOS auth: token row updates (lastUsedIp/UA, replay-detection family revoke)
  // happen across tenant boundary because the bearer token's tenantId is
  // resolved from the row, not the request session.
  // Tenant idle/absolute policy read keyed by the refresh row's tenantId.
  "src/lib/auth/tokens/mobile-token.ts",
  // iOS authorize: bridge-code creation atomically counts active bridge codes
  // per user across tenants (parity with extension/bridge-code/route.ts).
  "src/app/api/mobile/authorize/route.ts",
  // iOS token exchange: bridge-code single-use consumption requires bypass
  // because the row predates the issued session (parity with extension exchange).
  // Tenant idle/absolute policy read keyed by the consumed bridge code's tenantId.
  "src/app/api/mobile/token/route.ts",
  // iOS token refresh: cross-tenant token row read for family-absolute check.
  // C13: deactivated-user rejection requires tenantMember lookup.
  "src/app/api/mobile/token/refresh/route.ts",
  // Team policy route: pre-write tenant cap check (cross-tenant read of tenant row)
  "src/app/api/teams/[teamId]/policy/route.ts",
  "src/app/api/maintenance/purge-audit-logs/route.ts",
  "src/app/api/maintenance/audit-outbox-metrics/route.ts",
  // Health probe: whole-deployment outbox backlog depth. Raw SQL, no model
  // accessor. Runs outside any request tenant context, and the depth it reports
  // is deliberately not tenant-scoped.
  "src/lib/health.ts",
  "src/app/api/maintenance/audit-outbox-purge-failed/route.ts",
  "src/app/api/maintenance/audit-chain-verify/route.ts",
  "src/app/api/user/passkey-status/route.ts",
  "src/app/api/share-links/route.ts", // logAuditInTx for SHARE_CREATE
  "src/app/api/share-links/[id]/route.ts", // logAuditInTx for SHARE_REVOKE
  "src/app/api/share-links/verify-access/route.ts",
  "src/app/api/share-links/[id]/content/route.ts",
  "src/app/s/[token]/page.tsx",
  "src/app/s/[token]/download/route.ts",
  // Emergency access: cross-tenant grantee look-ups require RLS bypass
  "src/app/api/emergency-access/route.ts",
  "src/app/api/emergency-access/accept/route.ts",
  "src/app/api/emergency-access/reject/route.ts",
  "src/app/api/emergency-access/[id]/accept/route.ts",
  "src/app/api/emergency-access/[id]/approve/route.ts",
  "src/app/api/emergency-access/[id]/decline/route.ts",
  "src/app/api/emergency-access/[id]/request/route.ts",
  "src/app/api/emergency-access/[id]/revoke/route.ts",
  "src/app/api/emergency-access/[id]/vault/route.ts",
  "src/app/api/emergency-access/[id]/vault/entries/route.ts",
  // Machine Identity: SA token validation + MCP Gateway operate cross-tenant by design
  "src/lib/auth/tokens/service-account-token.ts",
  // Operator-token validator: cross-tenant lookup is required because the
  // bearer-token caller has no tenant context until the token row resolves it
  "src/lib/auth/tokens/operator-token.ts",
  "src/lib/mcp/oauth-server.ts",
  "src/app/api/mcp/authorize/route.ts",
  "src/app/api/mcp/register/route.ts",
  "src/app/api/mcp/authorize/consent/route.ts",
  "src/app/[locale]/mcp/authorize/page.tsx",
  // Per-request `form-action` for the consent page, computed in the proxy
  // (`src/lib/proxy/page-route.ts`) — a layer that runs before any tenant
  // context is established, so no RLS session variable exists to satisfy. Same
  // lookup the consent page above performs, by the unique `clientId`, selecting
  // `redirectUris` only: values the registrant supplied and which the consent
  // page already shows them. Read-only, no identity, and every failure path
  // returns no extra CSP sources.
  "src/lib/security/consent-form-action.ts",
  // JIT access requests: SA self-service path uses bypass for SA lookup; approve reads tenant policy
  "src/app/api/tenant/access-requests/route.ts",
  "src/app/api/tenant/access-requests/[id]/approve/route.ts",
  // Delegated Decryption: cross-tenant session lookup + delegation CRUD
  "src/lib/auth/access/delegation.ts",
  "src/app/api/vault/delegation/route.ts",
  "src/app/api/vault/delegation/check/route.ts",
  // Unlock presence: lastPresenceAt write on the presenting token's own row,
  // keyed by the id checkAuth resolved from the validated bearer.
  "src/app/api/vault/unlock/verify/route.ts",
  // SSH agent per-signature authorize: cross-tenant SSH_KEY lookup scoped by userId in WHERE
  "src/app/api/vault/ssh/sign-authorize/route.ts",
  // MCP Connections: user's own token listing + revocation (userId + tenantId in WHERE)
  // The last three were always used by the bulk-revoke callback (refresh-token
  // families, delegation sessions, one summary audit row) but sat past the old
  // fixed 10-line scan window, so the entry only listed what the window could
  // see. The sibling [id]/route.ts entry below has carried the same four for as
  // long as it has existed; this is the same operation, one level up.
  "src/app/api/user/mcp-tokens/route.ts",
  "src/app/api/user/mcp-tokens/[id]/route.ts",
  // Auth provider check: userId-scoped Account query for passkey sign-in capability
  "src/app/api/user/auth-provider/route.ts",
  // Audit anchor publisher: cross-tenant manifest generation reads all tenants + chain state
  "src/workers/audit-anchor-publisher.ts",
  // Audit-chain verify worker (C3): the tenant enumeration (now that `tenants`
  // carries the same RLS policy as every other table) runs under the named
  // SYSTEM_MAINTENANCE_TENANT_LOOKUP grant, once per tick, before the
  // per-tenant withTenantRls walk.
  "scripts/audit-chain-verify-worker.ts",
]);

// The RLS helpers. `withBypassRls` is the one the file allowlist and the grants
// govern; the others share the callback-shape discipline (C2 / F3) only.
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

// Per-file restriction on WHICH purpose a bypass may run under. A file listed
// here may name only grants whose purpose (the defineGrant's BYPASS_PURPOSE
// member, read off the grant's AST) is listed, directly or through a
// forwarder; a file not listed may name any grant. The operator scripts run out
// of band with MIGRATION_DATABASE_URL: a grant declared for a request path
// (auth_flow, token_lifecycle, …) is not theirs to take, even when its models
// would cover what they reach.
const ALLOWED_PURPOSES = new Map([
  ["scripts/tenant-domain.ts", ["SYSTEM_MAINTENANCE"]],
  ["scripts/migrate-account-tokens-to-encrypted.ts", ["SYSTEM_MAINTENANCE"]],
  ["scripts/migrate-webhook-secrets-v1-to-v2.ts", ["SYSTEM_MAINTENANCE"]],
]);

// The grant registry and the helpers around it. A grant is named by a
// withBypassRls call (judged here, Check 3) or by a self-setting site — a call
// that hands the grant to setBypassGucs, directly or through a module-private
// wrapper such as the retention worker's inSweepTx — whose raw SQL this gate
// does not follow (the database reports what such a site reaches outside its
// grant).
const GRANTS_FILE = "src/lib/tenant-rls-grants.ts";
const HELPER_FILE = "src/lib/tenant-rls.ts";
const PURPOSE_FILE = "src/lib/tenant-rls-purpose.ts";
// The retention worker builds its per-entry grants from the registry's table
// column (grantForEntry → grantForTables): resolved by construction, recorded
// as self-setting sites, not judged here.
const DYNAMIC_GRANT_DIR = "src/workers/retention-gc-worker/";
const DYNAMIC_GRANT_BUILDERS = new Set(["grantForTables", "grantForEntry"]);
// The two modules whose raw SQL may write session settings (the writer rule).
const WRITER_EXEMPT_FILES = new Set([HELPER_FILE, GRANTS_FILE]);

/**
 * Production TypeScript under src/ and scripts/ (isProductionPath: tests, the
 * CI tooling and scripts/manual-tests excluded). `src/` must exist — readdirSync
 * throws otherwise, which is the refusal a wrong cwd needs; `scripts/` is
 * optional (fixture trees lack it).
 */
function getSourceFiles() {
  const files = [];
  for (const root of ["src", ...(existsSync("scripts") ? ["scripts"] : [])]) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name);
      if (ext !== ".ts" && ext !== ".tsx") continue;
      const file = join(entry.parentPath ?? entry.path, entry.name);
      if (isProductionPath(file.split(sep).join("/"))) files.push(file);
    }
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
 * The callback at the helper's DECLARED callback position (withBypassRls's 2nd
 * argument, withTenantRls's 3rd, …), never "the first function-looking
 * argument": a function placed elsewhere is not what the helper runs.
 */
function callbackOf(call, bindingsFor, helper) {
  const index = CALLBACK_INDEX.get(helper);
  if (index === undefined) return null;
  const args = call.getArguments();
  if (args.slice(0, index + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement)) return null;
  const arg = unwrapExpression(args[index]);
  if (!arg) return null;
  if (FN_KINDS.has(arg.getKind())) return arg;
  if (arg.getKind() === SyntaxKind.Identifier) return resolveLocalFunction(arg.getText(), call, bindingsFor);
  return null;
}

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
 * Prisma model names accessed as `<client>.<model>.…` anywhere inside `node`,
 * with the 1-based line of each reference. `$`-prefixed client meta-properties
 * ($transaction, $executeRaw, …) are not models.
 */
/**
 * Following the client across a module boundary.
 *
 * clientBindingsIn stops where a client is handed to a callee this file does
 * not declare. Those callees are resolved through the Program (the same
 * dependency-resolved project C3 builds) and analysed with the same
 * clientBindingsIn, from the parameter the client lands in, recursively. What
 * they reach is reached under the CALLER's bypass, so it is judged against the
 * caller's ALLOWED_USAGE entry.
 *
 * A hand-off the Program cannot map to a function body with a known parameter
 * — a callee typed only by a `.d.ts`, `.call`/`.apply`, a spread before the
 * client, a rest parameter — is returned as unfollowed, and the caller reports
 * it rather than exempting the file.
 */

/**
 * The Program's node for `call`, which may come from the syntax-only project.
 * That project is in-memory and keys a file by its cwd-relative path under `/`,
 * so the path is re-rooted at the cwd for the Program's lookup.
 */
function programCallOf(call) {
  const path = call.getSourceFile().getFilePath();
  const psf =
    program.getSourceFile(path) ?? program.getSourceFile(join(process.cwd(), path.replace(/^\//, "")));
  if (!psf) return null;
  for (let node = psf.getDescendantAtPos(call.getStart()); node; node = node.getParent()) {
    if (
      node.getKind() === call.getKind() &&
      node.getStart() === call.getStart() &&
      node.getEnd() === call.getEnd()
    ) {
      return node;
    }
  }
  return null;
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
  { file: HELPER_FILE, name: "withBypassRls" },
  { file: HELPER_FILE, name: "withTenantRls" },
  { file: "src/lib/tenant-context.ts", name: "withUserTenantRls" },
  { file: "src/lib/tenant-context.ts", name: "withTeamTenantRls" },
];

/** `file` everywhere else in this gate is cwd-relative, POSIX-separated. */
function toRelPosix(absPath) {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

/**
 * The scan root this whole file uses: the deny-by-default production scope
 * (lib/soundness.mjs productionScope), set once the Program is built.
 */
let scope = null;
function isInScopeFile(rel) {
  return scope.files.has(join(process.cwd(), rel));
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
scope = productionScope(program);
// What is scanned is the production scope, the same set check-rls-nesting
// reads: every own Program file not declared non-production, plus what they
// load. (The directory walk above only proves there is something to examine;
// a file the tsconfig excludes is not in the Program and is read by neither gate.)
sourceFiles.length = 0;
for (const abs of scope.files) sourceFiles.push(toRelPosix(abs));
const helperDecls = resolveHelperDeclarations(program);
const bypassDecl = program
  .getSourceFile(join(process.cwd(), HELPER_FILE))
  ?.getFunctions()
  .find((fn) => fn.getName() === "withBypassRls" && fn.getBody());
// The Prisma client's model accessors, read off withBypassRls's own client
// parameter type.
const MODEL_NAMES = prismaModelNames(bypassDecl?.getParameters()[0]?.getType());
// The schema's relations, for the models a query's argument reaches through
// them (lib/prisma-relation-reach.mjs, shared with check-required-user-relation).
const SCHEMA = (() => {
  try {
    return loadPrismaSchema(join(process.cwd(), "prisma/schema.prisma"));
  } catch (error) {
    if (error instanceof SchemaReadError) programBuildFailed(error.message);
    throw error;
  }
})();
const relationChecker = program.getTypeChecker().compilerObject;
const camelModel = (pascal) => pascal[0].toLowerCase() + pascal.slice(1);
const relationBindings = new Map();

/**
 * `{ reached: [{ model, path }], unreadable }` for a delegate query node
 * (`<delegate>.findMany` as a callee): every model its argument reaches through
 * a relation — select/include/_count, where, orderBy, nested writes — and
 * whether any part of the argument could not be read. A query method read off
 * the delegate other than as a direct callee (destructured, bound) has its
 * argument elsewhere, so it is unreadable.
 */
function relationReachOf(node, models) {
  const out = { reached: [], unreadable: false };
  const k = node.getKind();
  const method =
    k === SyntaxKind.PropertyAccessExpression ? node.getName() : k === SyntaxKind.ElementAccessExpression ? literalKey(node.getArgumentExpression()) : null;
  if (!method || !(FILTERING.has(method) || WRITING.has(method) || ORDERING.has(method))) return out;
  const call = node.getParent();
  if (call?.getKind() !== SyntaxKind.CallExpression || call.getExpression() !== node) {
    out.unreadable = true;
    return out;
  }
  const arg = call.getArguments()[0];
  if (!arg) return out;
  const sf = node.getSourceFile();
  if (!relationBindings.has(sf)) relationBindings.set(sf, bindingIndex(sf));
  // The node is the Program's own, so the Program's checker types it: a spread
  // or a non-literal where/data the walk reads by its type (issue #926).
  const ctx = { bindingsFor: () => relationBindings.get(sf), checker: relationChecker };
  const literals = arg.getKind() === SyntaxKind.SpreadElement ? null : objectLiterals(arg, ctx);
  if (!literals) {
    out.unreadable = true;
    return out;
  }
  const visitor = {
    relation({ trail, field }) {
      out.reached.push({ model: camelModel(field.type), path: trail.join(".") });
      return true;
    },
    unreadable() {
      out.unreadable = true;
    },
  };
  for (const model of models) {
    const pascal = SCHEMA.handles.get(model);
    if (!pascal) continue;
    for (const literal of literals) walkCallArgs(literal, pascal, method, { models: SCHEMA.models, visitor, ctx, full: true });
  }
  return out;
}
const resolver = createFunctionResolver({ program, scope });
// The helpers' implementation nodes, as the resolver returns them: reach stops
// at one of these: a nested context is check-rls-nesting's to reject.
const helperImplementations = new Set();
for (const { file, name } of HELPER_DECLARATIONS) {
  for (const fn of program.getSourceFile(join(process.cwd(), file))?.getFunctions() ?? []) {
    if (fn.getName() === name) helperImplementations.add(fn.getImplementation?.() ?? fn);
  }
}

// ─── Purposes and grants (Check 2) ──────────────────────────────────────────
const bypassPurposeDecl = program
  .getSourceFile(join(process.cwd(), PURPOSE_FILE))
  ?.getVariableDeclaration("BYPASS_PURPOSE");
if (!bypassPurposeDecl) programBuildFailed(`BYPASS_PURPOSE is not declared in ${PURPOSE_FILE}`);

/**
 * The declarations `expr` (a value read as `X.member`) names, alias-resolved:
 * a renamed import binds the module's own declaration, and
 * `const { BYPASS_GRANT } = await import(…)` binds the loaded value's member.
 */
function declarationsOfReceiver(expr) {
  let symbol = expr?.getSymbol();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
  return (symbol?.getDeclarations() ?? []).flatMap((d) => {
    if (d.getKind() !== SyntaxKind.BindingElement) return [d];
    const holder = d.getParent()?.getParent();
    const key = d.getPropertyNameNode()?.getText() ?? d.getName();
    const source = holder?.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer() : null;
    return source?.getType().getProperty(key)?.getDeclarations() ?? [];
  });
}

/** `X.member` or `X["member"]`, parentheses only around it: `{ receiver, member }`, or null. */
function memberRead(arg) {
  let e = arg;
  while (e?.getKind() === SyntaxKind.ParenthesizedExpression) e = e.getExpression();
  const receiverOf = (access) => {
    let r = access.getExpression();
    while (r?.getKind() === SyntaxKind.ParenthesizedExpression) r = r.getExpression();
    return r;
  };
  if (e?.getKind() === SyntaxKind.PropertyAccessExpression) return { receiver: receiverOf(e), member: e.getName() };
  if (e?.getKind() === SyntaxKind.ElementAccessExpression) {
    const member = literalMemberName(e.getArgumentExpression());
    if (member !== null) return { receiver: receiverOf(e), member };
  }
  return null;
}

/** `BYPASS_PURPOSE.X` off the real declaration: the member name, or null. */
function purposeMemberOf(arg) {
  const read = memberRead(arg);
  return read && declarationsOfReceiver(read.receiver).includes(bypassPurposeDecl) ? read.member : null;
}

const grantsSf = program.getSourceFile(join(process.cwd(), GRANTS_FILE));
if (!grantsSf) programBuildFailed(`grant registry not found in the Program: ${GRANTS_FILE}`);
const bypassGrantDecl = grantsSf.getVariableDeclaration("BYPASS_GRANT");
const defineGrantDecl = grantsSf.getFunction("defineGrant");
const bypassGrantTypeDecl = grantsSf.getTypeAlias("BypassGrant");
const setBypassGucsDecl = grantsSf.getFunction("setBypassGucs");
for (const [name, decl] of [["BYPASS_GRANT", bypassGrantDecl], ["defineGrant", defineGrantDecl], ["BypassGrant", bypassGrantTypeDecl], ["setBypassGucs", setBypassGucsDecl]]) {
  if (!decl) programBuildFailed(`${name} is not declared in ${GRANTS_FILE}`);
}

/**
 * The registry, read off its AST: every BYPASS_GRANT member must be
 * `NAME: defineGrant(BYPASS_PURPOSE.X, ["model", …])` with literal, known,
 * distinct models — anything else is a grant this gate cannot read, refused
 * rather than skipped.
 */
const GRANTS = new Map();
const grantDefinitionViolations = [];
{
  let init = bypassGrantDecl.getInitializer();
  for (;;) {
    init = unwrapExpression(init);
    const isFreeze =
      init?.getKind() === SyntaxKind.CallExpression && init.getExpression().getText() === "Object.freeze" && init.getArguments().length === 1;
    if (!isFreeze) break;
    init = init.getArguments()[0];
  }
  if (init?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    programBuildFailed(`BYPASS_GRANT in ${GRANTS_FILE} is not an object literal (optionally Object.freeze'd)`);
  }
  for (const prop of init.getProperties()) {
    const line = prop.getStartLineNumber();
    const bad = (detail) => grantDefinitionViolations.push({ file: GRANTS_FILE, line, detail });
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
      bad(`${prop.getText().slice(0, 60)}: not a \`NAME: defineGrant(…)\` member`);
      continue;
    }
    const nameNode = prop.getNameNode();
    const name = nameNode.getKind() === SyntaxKind.Identifier ? nameNode.getText() : literalMemberName(nameNode);
    if (name === null) {
      bad(`${nameNode.getText()}: a computed member name`);
      continue;
    }
    const call = prop.getInitializer();
    const callee = call?.getKind() === SyntaxKind.CallExpression ? call.getExpression() : null;
    const calleeDecls = callee?.getKind() === SyntaxKind.Identifier ? declarationsOfReceiver(callee) : [];
    if (!calleeDecls.includes(defineGrantDecl)) {
      bad(`${name}: not built by defineGrant(…)`);
      continue;
    }
    const [purposeArg, modelsArg, ...rest] = call.getArguments();
    const purpose = purposeArg ? purposeMemberOf(purposeArg) : null;
    if (!purpose || rest.length > 0) {
      bad(`${name}: the purpose is not a BYPASS_PURPOSE.* member`);
      continue;
    }
    const list = modelsArg && unwrapExpression(modelsArg);
    const models = list?.getKind() === SyntaxKind.ArrayLiteralExpression ? list.getElements().map(literalMemberName) : null;
    if (!models || models.some((m) => m === null)) {
      bad(`${name}: the models are not an array of string literals`);
      continue;
    }
    const unknown = models.filter((m) => !MODEL_NAMES.has(m));
    if (unknown.length > 0) bad(`${name}: unknown model(s) ${unknown.join(", ")}`);
    const duplicated = models.filter((m, i) => models.indexOf(m) !== i);
    if (duplicated.length > 0) bad(`${name}: model(s) listed twice: ${duplicated.join(", ")}`);
    if (GRANTS.has(name)) bad(`${name}: declared twice`);
    GRANTS.set(name, { purpose, models: new Set(models), line });
  }
}

/** `BypassGrant` (or `BypassGrant | null`, …): the registry's grant type. */
function isGrantType(type) {
  // By type identity: the checker interns the alias's instantiation, so any
  // spelling of the type (an aliased import, `BypassGrant | null`) is the same
  // type once nullability is removed.
  return type.getNonNullableType().compilerType === bypassGrantTypeDecl.getType().compilerType;
}

/** The function a call's callee names (alias-resolved), or null. */
function calledFunction(call) {
  const callee = unwrap(call.getExpression());
  const node = callee?.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getNameNode() : callee;
  let symbol = node?.getSymbol?.();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
  const decl = symbol?.getDeclarations()?.[0];
  if (!decl) return null;
  if (FN_KINDS.has(decl.getKind()) || decl.getKind() === SyntaxKind.FunctionDeclaration || decl.getKind() === SyntaxKind.MethodDeclaration) return decl;
  if (decl.getKind() === SyntaxKind.VariableDeclaration) {
    const init = unwrap(decl.getInitializer());
    return init && FN_KINDS.has(init.getKind()) ? init : null;
  }
  return null;
}

/**
 * What a grant argument resolves to:
 *   { grant }              `BYPASS_GRANT.NAME` off the real registry (a renamed
 *                          import or a literal key resolves too);
 *   { forwardedParam }     a parameter typed BypassGrant, charged at its callers;
 *   { reassignedParam }    such a parameter, reassigned before it is passed on;
 *   { dynamic }            grantForTables(…)/grantForEntry(…) in the retention worker;
 *   null                   anything else — an inline defineGrant, a conditional,
 *                          a cast, a variable — which no review can read off the call.
 * No type-level wrapper is looked through: `x as BypassGrant` asserts a grant,
 * it does not name one.
 */
function grantOfExpression(arg) {
  let e = arg;
  while (e?.getKind() === SyntaxKind.ParenthesizedExpression) e = e.getExpression();
  if (!e) return null;
  const read = memberRead(e);
  if (read) {
    if (!declarationsOfReceiver(read.receiver).includes(bypassGrantDecl)) return null;
    return GRANTS.has(read.member) ? { grant: read.member } : null;
  }
  if (e.getKind() === SyntaxKind.Identifier) {
    const decl = e.getSymbol()?.getDeclarations()[0];
    if (decl?.getKind() === SyntaxKind.Parameter && isGrantType(decl.getType())) {
      // Reassigned inside the forwarder, it no longer carries what its callers passed.
      const written = decl.getNameNode().findReferences().some((g) =>
        g.getReferences().some((r) => isBindingWrite(r) && r.getNode() !== decl.getNameNode()),
      );
      return written ? { reassignedParam: decl } : { forwardedParam: decl };
    }
    return null;
  }
  if (e.getKind() === SyntaxKind.CallExpression && toRelPosix(e.getSourceFile().getFilePath()).startsWith(DYNAMIC_GRANT_DIR)) {
    const fn = calledFunction(e);
    const name = fn?.getName?.() ?? fn?.getParent()?.getName?.();
    if (fn && DYNAMIC_GRANT_BUILDERS.has(name)) return { dynamic: true };
  }
  return null;
}

/** `purpose` (a BYPASS_PURPOSE member name) against the pin of `file` and of every file a forwarder chain passed through. */
function checkGrantPurpose(file, line, grantName, chainPins = []) {
  const { purpose } = GRANTS.get(grantName);
  for (const pinned of new Set([file, ...chainPins])) {
    const allowed = ALLOWED_PURPOSES.get(pinned);
    if (allowed && !allowed.includes(purpose)) {
      const where = pinned === file ? "" : ` (forwarded into ${pinned})`;
      grantViolations.push({ file, line, detail: `BYPASS_GRANT.${grantName} runs under BYPASS_PURPOSE.${purpose}, not in ALLOWED_PURPOSES (${allowed.join(", ")})${where}` });
    }
  }
}

/** Functions that pass their own grant parameter on to withBypassRls, to be charged at their callers. */
const forwarderQueue = [];
/** grant name → models reached by the calls that name it. */
const reachedByGrant = new Map();
/** Grants named by a call this gate could not follow to the end: their "never reached" means "not seen". */
const undecidableGrants = new Set();
/**
 * grant name → a raw-SQL statement one of its calls reaches. Raw SQL reaches
 * tables this gate does not read (a SECURITY DEFINER procedure's audit_logs,
 * an invoker trigger's), so a model such a grant lists and no Prisma access
 * reaches may be reached there: not judged stale.
 */
const rawSqlGrants = new Map();
/** grant name → a query one of its calls runs whose argument the relation walk cannot read. */
const unreadableArgGrants = new Map();
/** `file:line` of each withBypassRls call that runs such a query (printed on success: reach unknown both ways). */
const unreadableArgCalls = [];
/** Grants named by a withBypassRls call or a forwarder's caller. */
const judgedGrants = new Set();
const grantViolations = [];
/** `file:line` of each call whose grant the retention worker builds per entry (grantForEntry/grantForTables). */
const dynamicGrantSites = [];

/**
 * Charge `reached` (model → where it was reached) to `grantName`, as named at
 * `file:line`: every model must be one the grant lists.
 */
function chargeGrant(grantName, reached, { file, line, undecidable, rawSqlAt = null, unreadableArgAt = null, through = null }) {
  judgedGrants.add(grantName);
  if (undecidable) undecidableGrants.add(grantName);
  if (rawSqlAt) rawSqlGrants.set(grantName, rawSqlAt);
  if (unreadableArgAt) unreadableArgGrants.set(grantName, unreadableArgAt);
  if (!reachedByGrant.has(grantName)) reachedByGrant.set(grantName, new Set());
  const { models } = GRANTS.get(grantName);
  for (const [model, sites] of reached) {
    reachedByGrant.get(grantName).add(model);
    if (models.has(model)) continue;
    // Charged at a forwarder's caller: the caller's line, and where the model
    // was reached inside the forwarder.
    for (const at of sites) {
      modelViolations.push(
        through
          ? { file, line, model, grant: grantName, via: at.site, through, relation: at.relation }
          : { file, line: at.line, model, grant: grantName, via: at.via, through, relation: at.relation },
      );
    }
  }
}

// ─── Check 3: reach and types ───────────────────────────────────────────────
const reachability = createReachability(resolver);
const siteOf = (node) => `${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;

const bypassImpl = [...helperImplementations].find((fn) => fn.getName() === "withBypassRls");
// Each helper's callback position, read off its declaration.
const CALLBACK_INDEX = new Map(
  [...helperImplementations].map((fn) => [fn.getName(), fn.getParameters().findIndex((p) => p.getType().getCallSignatures().length > 0)]),
);
for (const [name, index] of CALLBACK_INDEX) if (index < 0) programBuildFailed(`${name} declares no callback parameter`);
const BYPASS_CALLBACK_INDEX = CALLBACK_INDEX.get("withBypassRls");
// withBypassRls's grant position: the parameter typed BypassGrant.
const GRANT_INDEX = bypassImpl.getParameters().findIndex((p) => isGrantType(p.getType()));
if (GRANT_INDEX < 0) programBuildFailed("withBypassRls declares no BypassGrant parameter");


const isPrismaClientMember = (decls) =>
  decls.some((d) => {
    const owner = d.getParent();
    const k = owner?.getKind();
    return (k === SyntaxKind.ClassDeclaration || k === SyntaxKind.InterfaceDeclaration) && owner.getName?.() === "PrismaClient";
  });
const isClientType = (type) => type.getProperties().some((p) => isPrismaClientMember(p.getDeclarations()));
const isExternalDecl = (d) => d.getSourceFile().isDeclarationFile() || d.getSourceFile().getFilePath().includes("/node_modules/");
// A Prisma model delegate by its own shape: the client library declares its
// query methods. Recognises a model read off any client-derived type — a rest
// element, Pick/Omit, an index signature — where the member has no declaration.
const isDelegateType = (type) =>
  ["findMany", "count"].every((n) => (type.getProperty(n)?.getDeclarations() ?? []).some(isExternalDecl));
const keyText = (nameNode) =>
  nameNode.getKind() === SyntaxKind.StringLiteral || nameNode.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ? nameNode.getLiteralText()
    : nameNode.getText();

/** The model `name` read off a value of `type`, or null. An `any` value counts when the name is a model. */
function modelNamed(type, name) {
  if (name.startsWith("$")) return null;
  const prop = type.getProperty(name);
  if (prop && isPrismaClientMember(prop.getDeclarations())) return name;
  const memberType = prop?.getTypeAtLocation?.(bypassDecl) ?? type.getStringIndexType();
  if (MODEL_NAMES.has(name) && memberType && isDelegateType(memberType)) return name;
  return null;
}

/**
 * The models a delegate TYPE belongs to: the generated client names each one
 * `<Model>Delegate`, and a union (`cond ? tx.user : tx.session`) is each of
 * its members. Null when the type is not a delegate, `{ dynamic }` when one
 * part is a delegate whose model cannot be named.
 */
function modelsOfDelegateType(type) {
  const t = type.getNonNullableType();
  const parts = t.isUnion() ? t.getUnionTypes() : [t];
  if (!parts.some(isDelegateType)) return null;
  const models = [];
  for (const part of parts) {
    if (!isDelegateType(part)) continue;
    const m = ((part.getAliasSymbol() ?? part.getSymbol())?.getName() ?? "").match(/^(\w+)Delegate$/);
    const model = m ? m[1][0].toLowerCase() + m[1].slice(1) : null;
    if (!model || !MODEL_NAMES.has(model)) return { dynamic: true };
    models.push(model);
  }
  return { models };
}

/**
 * Whether a narrowed client type keeps only the client's raw-query API
 * (`{ $executeRaw }`, a `$queryRawUnsafe` probe): every member is one of the
 * four raw-query methods the generated client declares. No model is reachable
 * through them; raw SQL is check-raw-sql-usage's to judge. The client's other
 * `$` members are not: `$transaction` hands its callback a client, `$extends`
 * returns one.
 */
const CLIENT_TYPE = bypassDecl?.getParameters()[0]?.getType();
const RAW_QUERY_METHODS = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]);
function isRawQueryOnly(type) {
  const props = type.getNonNullableType().getProperties();
  return props.length > 0 && props.every((p) => {
    const name = p.getName();
    return RAW_QUERY_METHODS.has(name) && isPrismaClientMember(CLIENT_TYPE?.getProperty(name)?.getDeclarations() ?? []);
  });
}

/** `client.$executeRaw…`/`$queryRaw…`, called or tagged, on a Prisma client by its member's declaration. */
function isRawQueryCall(node) {
  const k = node.getKind();
  const callee = k === SyntaxKind.CallExpression ? unwrap(node.getExpression()) : k === SyntaxKind.TaggedTemplateExpression ? unwrap(node.getTag()) : null;
  if (callee?.getKind() !== SyntaxKind.PropertyAccessExpression || !RAW_QUERY_METHODS.has(callee.getName())) return false;
  return isPrismaClientMember(callee.getNameNode().getSymbol()?.getDeclarations() ?? []);
}

/** Whether a type is, or each part of it is, a delegate the charge can name by its members' declarations. */
function modelOfDelegateType(type) {
  const t = type.getNonNullableType();
  const parts = t.isUnion() ? t.getUnionTypes() : [t];
  return parts.length > 0 && parts.every((u) => u.getProperties().length > 0 && u.getProperties().every((p) => modelsOfDelegateMember(p.getDeclarations())));
}

/** The models a delegate member's DECLARATIONS belong to: each owner is `<Model>Delegate` in the generated client. */
function modelsOfDelegateMember(decls) {
  // A union's member has one declaration per delegate: every one must name a model.
  const models = decls.map((d) => {
    if (!isExternalDecl(d)) return null;
    const owner = d.getParent();
    const m = owner?.getKind() === SyntaxKind.InterfaceDeclaration ? owner.getName().match(/^(\w+)Delegate$/) : null;
    const model = m ? m[1][0].toLowerCase() + m[1].slice(1) : null;
    return model && MODEL_NAMES.has(model) ? model : null;
  });
  return models.length > 0 && models.every(Boolean) ? [...new Set(models)] : null;
}

/**
 * The models a member read off a delegate reaches — `users.deleteMany(…)`,
 * `users.deleteMany.bind(users)`, `users["deleteMany"]`, `const { deleteMany }
 * = users` — charged where the member LEAVES the delegate: by the delegate's
 * `<Model>Delegate` type (each member of a union), or by the interface that
 * declares the member (a `Pick<…Delegate, "deleteMany">`). A delegate read in
 * one module and handed back to another is charged to the module that uses
 * it, so a via grant cannot be used for a write it never makes.
 */
function delegateOperationOf(node) {
  const k = node.getKind();
  let receiverType = null;
  let memberDecls = [];
  if (k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.ElementAccessExpression) {
    receiverType = node.getExpression().getType();
    memberDecls = (k === SyntaxKind.PropertyAccessExpression ? node.getNameNode().getSymbol() : node.getSymbol?.())?.getDeclarations() ?? [];
  } else if (k === SyntaxKind.BindingElement) {
    const holder = node.getParent()?.getParent();
    const source = holder?.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer() : null;
    if (!source) return null;
    receiverType = source.getType();
    const key = node.getPropertyNameNode()?.getText() ?? node.getName();
    memberDecls = receiverType.getProperty(key)?.getDeclarations() ?? [];
  } else {
    return null;
  }
  const byDecl = modelsOfDelegateMember(memberDecls);
  if (byDecl) return { models: byDecl };
  const found = modelsOfDelegateType(receiverType);
  if (!found) return null;
  return found.dynamic ? { dynamic: true, text: node.getText().slice(0, 80) } : { models: found.models };
}

/**
 * `{ model }` when `node` reads a model delegate off a Prisma client —
 * `tx.user`, `tx["user"]`, `const { user } = tx`, `({ user } = tx)` — or
 * `{ dynamic }` for a computed key on a client, whose model cannot be named.
 */
function modelAccessOf(node) {
  switch (node.getKind()) {
    case SyntaxKind.PropertyAccessExpression: {
      const decls = node.getNameNode().getSymbol()?.getDeclarations() ?? [];
      const name = node.getName();
      if (name.startsWith("$")) return null;
      if (isPrismaClientMember(decls)) return { model: name };
      return MODEL_NAMES.has(name) && isDelegateType(node.getType()) ? { model: name } : null;
    }
    case SyntaxKind.ElementAccessExpression: {
      const t = node.getExpression().getType();
      const key = literalKey(node.getArgumentExpression());
      if (key !== null) {
        const model = modelNamed(t, key);
        return model ? { model } : null;
      }
      return isClientType(t) ? { dynamic: true, text: node.getText() } : null;
    }
    case SyntaxKind.BindingElement: {
      const pattern = node.getParent();
      if (pattern?.getKind() !== SyntaxKind.ObjectBindingPattern || node.getDotDotDotToken()) return null;
      const holder = pattern.getParent();
      const t =
        holder?.getKind() === SyntaxKind.VariableDeclaration
          ? holder.getInitializer()?.getType()
          : holder?.getKind() === SyntaxKind.Parameter
            ? holder.getType()
            : null;
      if (!t) return null;
      const keyNode = node.getPropertyNameNode();
      if (keyNode?.getKind() === SyntaxKind.ComputedPropertyName) {
        const key = literalKey(keyNode.getExpression());
        if (key === null) return isClientType(t) ? { dynamic: true, text: node.getText() } : null;
        const model = modelNamed(t, key);
        return model ? { model } : null;
      }
      const model = modelNamed(t, keyNode ? keyText(keyNode) : node.getName());
      return model ? { model } : null;
    }
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.PropertyAssignment: {
      // `({ user } = tx)`: an object literal on the left of an assignment.
      const literal = node.getParent();
      const assignment = literal?.getParent();
      if (assignment?.getKind() !== SyntaxKind.BinaryExpression || assignment.getLeft() !== literal) return null;
      const t = assignment.getRight().getType();
      const nameNode = node.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
        const key = literalKey(nameNode.getExpression());
        if (key === null) return isClientType(t) ? { dynamic: true, text: node.getText() } : null;
        const model = modelNamed(t, key);
        return model ? { model } : null;
      }
      const model = modelNamed(t, keyText(nameNode));
      return model ? { model } : null;
    }
    default:
      return null;
  }
}

/**
 * A Prisma client or model delegate handed to a library call: the library may
 * run any query on it, which no allowlist can see. The client's own API
 * (`tx.$transaction(...)`, `tx.user.findMany(...)`) is not a hand-off.
 */
function clientHandedToLibrary(node) {
  if (node.getKind() !== SyntaxKind.CallExpression && node.getKind() !== SyntaxKind.NewExpression) return null;
  const callee = unwrap(node.getExpression());
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression || callee?.getKind() === SyntaxKind.ElementAccessExpression) {
    const receiverType = callee.getExpression().getType();
    if (isClientType(receiverType) || isDelegateType(receiverType)) return null;
  }
  // Any library part of the callee — a mixed own/library union included.
  const r = resolver.resolveCall(node);
  if (!r.external) return null;
  for (const arg of node.getArguments?.() ?? []) {
    if (carriesClient(arg.getType())) return `client handed to library code (${callee?.getText().slice(0, 60)})`;
  }
  return null;
}

/**
 * Whether a value of `type` is, or carries, a Prisma client or delegate: as
 * itself, a union member, an array or tuple element, an own object's member,
 * or what a function returns (`() => tx`). Library-declared object types are
 * not opened (their members are the library's own); depth is bounded.
 */
function carriesClient(type, depth = 0, seen = new Set()) {
  const t = type; // an optional client is a union, walked below
  if (depth > 3 || seen.has(t.compilerType)) return false;
  seen.add(t.compilerType);
  if (isClientType(t) || isDelegateType(t)) return true;
  if (t.isUnion()) return t.getUnionTypes().some((u) => carriesClient(u, depth, seen));
  if (t.isIntersection()) return t.getIntersectionTypes().some((u) => carriesClient(u, depth, seen));
  const element = t.getArrayElementType?.();
  if (element) return carriesClient(element, depth + 1, seen);
  if (t.isTuple?.()) return t.getTupleElements().some((u) => carriesClient(u, depth + 1, seen));
  if (t.getCallSignatures().some((sig) => carriesClient(sig.getReturnType(), depth + 1, seen))) return true;
  const props = t.getProperties();
  const declaredOwn = props.some((p) => p.getDeclarations().some((d) => !isExternalDecl(d)));
  if (!declaredOwn) return false;
  return props.some((p) => {
    const at = p.getValueDeclaration() ?? p.getDeclarations()[0];
    return at ? carriesClient(p.getTypeAtLocation(at), depth + 1, seen) : false;
  });
}

/**
 * The callbacks a withBypassRls call runs, in the Program. Check 3 runs only
 * for a call whose callback `callbackOf` already located (a function literal or
 * a const alias of one), so a spread, a missing callback and a forwarded
 * parameter never get here: C2 reports them, and a file on
 * INDIRECT_CALLBACK_ALLOWLIST may not hold an ALLOWED_USAGE entry (checked
 * below), so no bypass callback is excused from Check 3 that way.
 */
function bypassRootsOf(pcall) {
  const arg = unwrap(pcall.getArguments()[BYPASS_CALLBACK_INDEX]);
  if (FN_KINDS.has(arg.getKind())) return { roots: [arg], problem: null };
  const r = resolver.resolveValue(arg);
  return { roots: r.fns, problem: r.unresolved ? `callback: ${r.unresolved}` : null };
}

const bypassReachHooks = {
  stop: (unit) => helperImplementations.has(unit),
  onParam: (param, _edge, _unit, root) => {
    const owner = param.getParent();
    if (owner === root) return "skip"; // the callback's own client
    // A parameter of a function enclosing the callback (a wrapper's callback
    // parameter): what its callers pass runs under this bypass.
    if (root.getAncestors().includes(owner)) return "follow";
    return undefined;
  },
};

let bypassCallbacks = 0;
let reachedUnits = 0;

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
const undecidableFiles = new Set();
/**
 * Files that make at least one real `withBypassRls` call, or hold a helper reference
 * this gate reports as unfollowable (round 13). The whole-entry check reads it: such a
 * file already fails, and telling its reviewer to delete the entry would be wrong.
 */
const bypassCallFiles = new Set();
const txLessViolations = [];
const indirectCallbacks = [];
const indirectHelperReferences = [];
const unresolvedModels = [];
const unfollowedHandOffs = [];
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

  const allowed = ALLOWED_USAGE.has(file);

  // Check 1: a file that really calls withBypassRls must be on the allowlist.
  // Keyed on a call in the tree, not on the text naming one, so prose and
  // string literals that mention the helper no longer read as usage.
  if (bypassCalls.length > 0 && !allowed) {
    fileViolations.push(file);
  }

  // Check 2: every withBypassRls call names its grant with a member of the
  // real BYPASS_GRANT (resolved through the Program, so a local object that
  // shadows the name does not pass), or forwards its own parameter typed
  // BypassGrant — whose production callers are then charged with what the
  // forwarded call reaches (see the forwarder pass after this loop). The
  // definition file (tenant-rls.ts) is exempt — it defines, not consumes.
  /** call start → the call's resolved grant argument */
  const grantOfCall = new Map();
  if (file !== HELPER_FILE) {
    for (const { call } of bypassCalls) {
      const pcall = programCallOf(call);
      const line = call.getStartLineNumber();
      // At the declared position only: a BYPASS_GRANT.X anywhere else is not
      // what the helper receives.
      const args = pcall?.getArguments() ?? [];
      const spread = args.slice(0, GRANT_INDEX + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement);
      const grant = !spread && args[GRANT_INDEX] ? grantOfExpression(args[GRANT_INDEX]) : null;
      grantOfCall.set(call.getStart(), grant);
      if (grant?.reassignedParam) {
        grantViolations.push({ file, line, detail: `grant parameter ${grant.reassignedParam.getName()} is reassigned before it reaches withBypassRls` });
      } else if (grant?.dynamic) {
        dynamicGrantSites.push(`${file}:${line}`);
      } else if (!grant) {
        const text = spread ? "a spread argument" : (args[GRANT_INDEX]?.getText() ?? "missing").replace(/\s+/g, " ").slice(0, 60);
        grantViolations.push({ file, line, detail: `the grant is not a BYPASS_GRANT.* member: ${text}` });
      } else if (grant.grant) {
        checkGrantPurpose(file, line, grant.grant);
      }
    }
  }

  // Built on first use, not per file: only a call that passes its callback by
  // NAME needs it, which is 3 of the 238 parsed files. Building it eagerly cost
  // three whole-file descendant walks per file — ~25% of the gate's runtime for
  // an answer almost nobody asked for.
  let bindings = null;
  const bindingsFor = () => (bindings ??= bindingIndex(sf));

  for (const { call, helper } of calls) {
    const line = call.getStartLineNumber();
    const fn = callbackOf(call, bindingsFor, helper);

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

    // Check 3: per-call grant, for withBypassRls in an allowlisted consumer —
    // judged on REACH and TYPES, not on names. Everything that can run inside
    // the callback is reached through the shared resolver; in each reached
    // function, every access whose receiver is a Prisma client (by type) is a
    // model reached under this bypass, however the client got there, and it
    // must be one the call's grant lists.
    if (helper !== "withBypassRls" || !allowed || file === HELPER_FILE) continue;
    const grant = grantOfCall.get(call.getStart());
    const pcall = programCallOf(call);
    const located = pcall ? bypassRootsOf(pcall) : { roots: [], problem: "call not found in the Program" };
    let undecidable = false;
    /** The first raw-SQL statement reached: what it reaches is not read here. */
    let rawSqlAt = null;
    /** The first query whose argument the relation walk cannot read. */
    let unreadableArgAt = null;
    if (located.problem) {
      unfollowedHandOffs.push({ file, at: `${file}:${line}`, reason: located.problem });
      undecidableFiles.add(file);
      undecidable = true;
    }
    const seen = new Set();
    /** model → every { line, via, site } it is reached at under this call */
    const reached = new Map();
    for (const root of located.roots) {
      bypassCallbacks += 1;
      const { info, unresolved } = reachability.reach(root, bypassReachHooks);
      for (const u of unresolved) {
        unfollowedHandOffs.push({ file, at: siteOf(u.node), reason: u.reason });
        undecidableFiles.add(file);
        undecidable = true;
      }
      for (const unit of info.keys()) {
        if (helperImplementations.has(unit)) continue;
        reachedUnits += 1;
        const direct = unit === root && toRelPosix(unit.getSourceFile().getFilePath()) === file;
        for (const node of reachability.ownedNodes(unit)) {
          const handOff = clientHandedToLibrary(node);
          if (handOff) {
            unfollowedHandOffs.push({ file, at: siteOf(node), reason: handOff });
            undecidableFiles.add(file);
            undecidable = true;
          }
          // The RLS modules' own raw SQL (advisoryXactLock, readBypassState,
          // setLockTimeout) sets or reads settings and locks, never a table.
          if (!rawSqlAt && isRawQueryCall(node) && !WRITER_EXEMPT_FILES.has(toRelPosix(node.getSourceFile().getFilePath()))) {
            rawSqlAt = siteOf(node);
          }
          const at = siteOf(node);
          const operation = delegateOperationOf(node);
          for (const access of [modelAccessOf(node), operation]) {
            if (!access) continue;
            if (access.dynamic) {
              unresolvedModels.push({ file, line: node.getStartLineNumber(), text: `${access.text}  (in ${at})` });
              undecidableFiles.add(file);
              undecidable = true;
              continue;
            }
            for (const model of access.models ?? [access.model]) {
              const key = `${model}@${at}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!reached.has(model)) reached.set(model, []);
              reached.get(model).push(direct ? { line: node.getStartLineNumber(), site: at } : { line, via: at, site: at });
            }
          }
          // The models the query's argument reaches through relations.
          if (operation?.models) {
            const rel = relationReachOf(node, operation.models);
            if (rel.unreadable && !unreadableArgAt) unreadableArgAt = at;
            for (const { model, path } of rel.reached) {
              const key = `${model}@${at}@${path}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!reached.has(model)) reached.set(model, []);
              reached.get(model).push(
                direct ? { line: node.getStartLineNumber(), site: at, relation: path } : { line, via: at, site: at, relation: path },
              );
            }
          }
        }
      }
    }
    if (unreadableArgAt) unreadableArgCalls.push(`${file}:${line}`);
    if (grant?.grant) chargeGrant(grant.grant, reached, { file, line, undecidable, rawSqlAt, unreadableArgAt });
    else if (grant?.forwardedParam) forwarderQueue.push({ param: grant.forwardedParam, pins: [file], reached, undecidable, rawSqlAt, unreadableArgAt });
  }
}

// A forwarder's production callers name the grant (or forward their own), and
// are charged with everything the forwarded call reaches.
{
  const seenParams = new Set();
  while (forwarderQueue.length > 0) {
    const { param, pins, reached, undecidable, rawSqlAt, unreadableArgAt } = forwarderQueue.shift();
    const seenKey = `${param.getStart()}:${param.getSourceFile().getFilePath()}|${[...pins].sort().join(",")}|${[...reached.keys()].sort().join(",")}`;
    if (seenParams.has(seenKey)) continue;
    seenParams.add(seenKey);
    const fn = param.getParent();
    const index = fn.getParameters().indexOf(param);
    const nameNode = fn.getNameNode?.() ?? fn.getParent()?.getNameNode?.();
    const fnFile = toRelPosix(fn.getSourceFile().getFilePath());
    if (!nameNode) {
      grantViolations.push({ file: fnFile, line: fn.getStartLineNumber(), detail: "an anonymous function forwards a bypass grant; its callers cannot be found" });
      continue;
    }
    const fnName = nameNode.getText();
    for (const ref of nameNode.findReferencesAsNodes()) {
      const refFile = toRelPosix(ref.getSourceFile().getFilePath());
      if (ref === nameNode || !isInScopeFile(refFile)) continue;
      const holder = ref.getParent();
      const hk = holder?.getKind();
      if (hk === SyntaxKind.ImportSpecifier || hk === SyntaxKind.ExportSpecifier || hk === SyntaxKind.ImportClause) continue;
      if (ref.getFirstAncestorByKind(SyntaxKind.TypeQuery)) continue; // `typeof fn` in a type

      const callee = hk === SyntaxKind.PropertyAccessExpression && holder.getNameNode() === ref ? holder : ref;
      const call = callee.getParent();
      const line = ref.getStartLineNumber();
      if (call?.getKind() !== SyntaxKind.CallExpression || call.getExpression() !== callee) {
        grantViolations.push({ file: refFile, line, detail: `${fnName} forwards a bypass grant and is used other than by a direct call` });
        continue;
      }
      const args = call.getArguments();
      if (args.slice(0, index + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement)) {
        grantViolations.push({ file: refFile, line, detail: `spread argument where ${fnName} takes its grant` });
        continue;
      }
      const grant = args[index] ? grantOfExpression(args[index]) : null;
      if (grant?.reassignedParam) {
        grantViolations.push({ file: refFile, line, detail: `grant parameter ${grant.reassignedParam.getName()} is reassigned before it reaches ${fnName}` });
      } else if (grant?.forwardedParam) {
        forwarderQueue.push({ param: grant.forwardedParam, pins: [...new Set([...pins, refFile])], reached, undecidable, rawSqlAt, unreadableArgAt });
      } else if (grant?.grant) {
        checkGrantPurpose(refFile, line, grant.grant, pins);
        chargeGrant(grant.grant, reached, { file: refFile, line, undecidable, rawSqlAt, unreadableArgAt, through: `${fnName} (${fnFile})` });
      } else {
        grantViolations.push({ file: refFile, line, detail: `${fnName} called without a BYPASS_GRANT.* argument` });
      }
    }
  }
}

/**
 * Self-setting sites: a call that hands a grant to setBypassGucs, directly or
 * through an own function whose BypassGrant parameter reaches setBypassGucs's
 * grant position (the retention worker's inSweepTx). Derived from the Program
 * to a fixpoint — the helpers' own implementations excluded, since
 * withBypassRls's grant reaching setBypassGucs is the call Check 3 judges. Each
 * site's grant must resolve like a withBypassRls call's; what its raw SQL
 * reaches is not followed here (the database reports it).
 */
/** function declaration node → the index of its parameter that reaches setBypassGucs */
const selfSetters = new Map([[setBypassGucsDecl, setBypassGucsDecl.getParameters().findIndex((p) => isGrantType(p.getType()))]]);
const selfSettingSites = [];
/** Grants named where their reach is not judged: a self-setting site, or a manual test's withBypassRls call. */
const unjudgedGrants = new Set();
{
  const setterFiles = [...scope.files].concat(
    // A hand-run manual test sets the bypass for its own fixture rows; its
    // grant is named there and nowhere else.
    program.getSourceFiles().map((f) => f.getFilePath()).filter((f) => toRelPosix(f).startsWith("scripts/manual-tests/")),
  );
  const callsByFile = new Map();
  for (const path of setterFiles) {
    const sf = program.getSourceFile(path);
    if (sf) callsByFile.set(path, sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  }
  // Fixpoint: a function whose grant parameter is handed to a self-setter is one.
  for (let changed = true; changed; ) {
    changed = false;
    for (const calls of callsByFile.values()) {
      for (const call of calls) {
        const target = calledFunction(call);
        const index = target ? selfSetters.get(target) : undefined;
        if (index === undefined || index < 0) continue;
        const grant = call.getArguments()[index] ? grantOfExpression(call.getArguments()[index]) : null;
        const owner = grant?.forwardedParam?.getParent();
        if (!owner || selfSetters.has(owner) || helperImplementations.has(owner)) continue;
        selfSetters.set(owner, owner.getParameters().indexOf(grant.forwardedParam));
        changed = true;
      }
    }
  }
  for (const calls of callsByFile.values()) {
    for (const call of calls) {
      const target = calledFunction(call);
      // A hand-run manual test's withBypassRls call is outside the production
      // scope Check 3 judges; the grant it names is used, not judged.
      if (target === bypassImpl && toRelPosix(call.getSourceFile().getFilePath()).startsWith("scripts/manual-tests/")) {
        const grant = call.getArguments()[GRANT_INDEX] ? grantOfExpression(call.getArguments()[GRANT_INDEX]) : null;
        if (grant?.grant) unjudgedGrants.add(grant.grant);
        continue;
      }
      const index = target ? selfSetters.get(target) : undefined;
      if (index === undefined || index < 0) continue;
      const file = toRelPosix(call.getSourceFile().getFilePath());
      const line = call.getStartLineNumber();
      const arg = call.getArguments()[index];
      const grant = arg && !call.getArguments().slice(0, index + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement) ? grantOfExpression(arg) : null;
      if (grant?.grant) {
        selfSettingSites.push({ file, line, grant: grant.grant });
        unjudgedGrants.add(grant.grant);
      } else if (grant?.dynamic) {
        dynamicGrantSites.push(`${file}:${line}`);
      } else if (grant?.forwardedParam && (selfSetters.has(grant.forwardedParam.getParent()) || helperImplementations.has(grant.forwardedParam.getParent()))) {
        // A self-setter (or withBypassRls itself) passing its own parameter on: judged at its callers.
      } else {
        grantViolations.push({ file, line, detail: `${target.getName?.() ?? "a self-setting function"} is handed a grant that is not a BYPASS_GRANT.* member: ${(arg?.getText() ?? "missing").replace(/\s+/g, " ").slice(0, 60)}` });
      }
    }
  }
}

/**
 * The reverse direction: a grant no call names, or a model a grant lists that
 * no call naming it reaches. The permission outlives its reason, and the next
 * reader takes the grant for its call sites' documented scope. Grants are
 * shared, so a model is stale only when NO call naming the grant reaches it.
 *
 * Not judged for staleness of models, each for a stated reason:
 *   - a grant a self-setting site names: its raw SQL is not followed here;
 *   - a grant named by a call whose analysis was defeated anywhere (an
 *     unresolved client or model access): "never reached" means "not seen";
 *   - a grant one of whose calls runs a query whose argument the relation walk
 *     cannot read (unreadableArgGrants): what it reaches through relations is
 *     not known;
 *   - a grant one of whose calls reaches raw SQL (rawSqlGrants), or whose calls
 *     reach no model at all: raw SQL names tables, procedures and triggers this
 *     gate does not read (check-raw-sql-usage governs it).
 */
const unnamedGrants = [...GRANTS.keys()].filter((name) => !judgedGrants.has(name) && !unjudgedGrants.has(name));
const staleAllowances = [];
for (const name of judgedGrants) {
  if (unjudgedGrants.has(name) || undecidableGrants.has(name) || rawSqlGrants.has(name) || unreadableArgGrants.has(name)) continue;
  const reached = reachedByGrant.get(name) ?? new Set();
  if (reached.size === 0) continue;
  for (const model of GRANTS.get(name).models) {
    if (!reached.has(model)) staleAllowances.push({ grant: name, model });
  }
}

/**
 * The whole-entry form of the file allowlist: an ALLOWED_USAGE entry whose
 * file makes no `withBypassRls` call at all. Check 1 fires only in the other
 * direction, a call with no entry, so this direction was checked by nothing.
 *
 * NOT judged here, each for a stated reason:
 *   - the helpers' own definition;
 *   - a file this run could not parse, which is reported on its own above;
 *   - a file that turns the bypass on through setBypassGucs (a self-setting
 *     site, read from the Program above): a real bypass this gate does not
 *     follow, so the entry documents a scope rather than one gone stale;
 *   - a file absent from the tree being scanned. The self-test runs this gate on
 *     one-file fixture trees, so absence is asserted by a real-repo cell there.
 */
const selfSettingFiles = new Set(selfSettingSites.map(({ file }) => file));
const unparseableFileSet = new Set(unparseableFiles.map(({ file }) => file));
const staleEntries = [];
for (const file of ALLOWED_USAGE) {
  if (file === HELPER_FILE || bypassCallFiles.has(file) || unparseableFileSet.has(file)) continue;
  if (!existsSync(file)) continue;
  if (selfSettingFiles.has(file)) continue;
  staleEntries.push(file);
}

// ─── Writer, pool and function rules ────────────────────────────────────────
//
// Check 3 judges what a bypass reaches; these three judge who can turn one on.
// The database adjudicates a bypassed statement against `app.bypass_tables`,
// so a path that writes the bypass GUCs itself, a pool that skips the factory's
// notice listener, or a function created outside the migrations would each
// step around that report. Each rule is a writer check against honest code:
// SQL built at run time from values this gate cannot fold is outside its reach.

/** Prisma raw-query members, Prisma.sql/raw, and a pg `query` call. */
const RAW_SQL_TAGS = new Set(["$executeRaw", "$queryRaw"]);
const RAW_SQL_CALLS = new Set(["$executeRaw", "$queryRaw", "$executeRawUnsafe", "$queryRawUnsafe", "query"]);
const PRISMA_SQL_BUILDERS = new Set(["sql", "raw"]);

/** The member a callee or tag names: `x.name`, `x["name"]`, or a bare `name`; with the receiver. */
function calleeMember(expr) {
  let e = expr;
  while (e?.getKind() === SyntaxKind.ParenthesizedExpression || e?.getKind() === SyntaxKind.NonNullExpression) e = e.getExpression();
  if (e?.getKind() === SyntaxKind.PropertyAccessExpression) return { name: e.getName(), receiver: e.getExpression() };
  if (e?.getKind() === SyntaxKind.ElementAccessExpression) {
    const name = literalMemberName(e.getArgumentExpression());
    return name === null ? null : { name, receiver: e.getExpression() };
  }
  if (e?.getKind() === SyntaxKind.Identifier) return { name: e.getText(), receiver: null };
  return null;
}

const isPrismaReceiver = (receiver) => receiver?.getKind() === SyntaxKind.Identifier && receiver.getText() === "Prisma";

/**
 * Constant-fold `expr` into SQL text segments: literals, `+` concatenation,
 * untagged templates, parentheses and type wrappers, and an identifier bound
 * to a `const` whose initializer folds (through imports, when the Program
 * resolves them). A Prisma.sql/Prisma.raw fragment folds to its own text. What
 * does not fold is one opaque segment — the lexer's substitution token.
 */
function foldSql(expr, seen = new Set()) {
  const e = unwrap(expr);
  if (!e) return [{ opaque: "" }];
  switch (e.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return [{ text: e.getLiteralText() }];
    case SyntaxKind.TemplateExpression: {
      const out = [{ text: e.getHead().getLiteralText() }];
      for (const span of e.getTemplateSpans()) {
        out.push(...foldSql(span.getExpression(), seen), { text: span.getLiteral().getLiteralText() });
      }
      return out;
    }
    case SyntaxKind.BinaryExpression:
      if (e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
        return [...foldSql(e.getLeft(), seen), ...foldSql(e.getRight(), seen)];
      }
      break;
    case SyntaxKind.TaggedTemplateExpression: {
      const m = calleeMember(e.getTag());
      if (m?.name === "sql" && isPrismaReceiver(m.receiver)) return taggedSqlSegments(e.getTemplate(), seen);
      break;
    }
    case SyntaxKind.CallExpression: {
      const m = calleeMember(e.getExpression());
      if (m && PRISMA_SQL_BUILDERS.has(m.name) && isPrismaReceiver(m.receiver) && e.getArguments()[0]) {
        return foldSql(e.getArguments()[0], seen);
      }
      break;
    }
    case SyntaxKind.Identifier: {
      let symbol = e.getSymbol();
      if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
      const decls = symbol?.getDeclarations() ?? [];
      const decl = decls.length === 1 ? decls[0] : null;
      if (
        decl?.getKind() === SyntaxKind.VariableDeclaration &&
        decl.getVariableStatement?.()?.getDeclarationKind() === "const" &&
        decl.getInitializer() &&
        !seen.has(decl)
      ) {
        return foldSql(decl.getInitializer(), new Set([...seen, decl]));
      }
      break;
    }
    default:
      break;
  }
  return [{ opaque: e.getText().slice(0, 40) }];
}

/**
 * A tagged raw-query template: its substitutions are bind parameters (opaque),
 * except a Prisma.sql/Prisma.raw fragment, which is SQL text.
 */
function taggedSqlSegments(template, seen) {
  if (template.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) return [{ text: template.getLiteralText() }];
  const out = [{ text: template.getHead().getLiteralText() }];
  for (const span of template.getTemplateSpans()) {
    const sub = unwrap(span.getExpression());
    const m = sub?.getKind() === SyntaxKind.CallExpression ? calleeMember(sub.getExpression()) : sub?.getKind() === SyntaxKind.TaggedTemplateExpression ? calleeMember(sub.getTag()) : null;
    const isFragment = m && PRISMA_SQL_BUILDERS.has(m.name) && isPrismaReceiver(m.receiver);
    out.push(...(isFragment ? foldSql(sub, seen) : [{ opaque: sub?.getText().slice(0, 40) ?? "" }]));
    out.push({ text: span.getLiteral().getLiteralText() });
  }
  return out;
}

/** Segments → the lexer's `{ parts, substitutions }` input. */
function sqlInputOf(segments) {
  const parts = [""];
  const substitutions = [];
  for (const seg of segments) {
    if (seg.opaque !== undefined) {
      substitutions.push(seg.opaque);
      parts.push("");
    } else parts[parts.length - 1] += seg.text;
  }
  return { parts, substitutions };
}

/** Every raw-SQL argument in `sf`: `{ node, segments }`. */
function rawSqlArgumentsIn(sf) {
  const out = [];
  for (const tagged of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    const m = calleeMember(tagged.getTag());
    if (!m) continue;
    if (RAW_SQL_TAGS.has(m.name) || (m.name === "sql" && isPrismaReceiver(m.receiver))) {
      out.push({ node: tagged, segments: taggedSqlSegments(tagged.getTemplate(), new Set()) });
    }
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const m = calleeMember(call.getExpression());
    if (!m) continue;
    const isRaw = RAW_SQL_CALLS.has(m.name) && (m.name !== "query" || m.receiver !== null);
    const isBuilder = PRISMA_SQL_BUILDERS.has(m.name) && isPrismaReceiver(m.receiver);
    if (!isRaw && !isBuilder) continue;
    let arg = call.getArguments()[0];
    if (!arg) continue;
    // pg's `query({ text, values })` form.
    const obj = unwrap(arg);
    if (obj?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const text = obj.getProperty("text");
      if (text?.getKind() !== SyntaxKind.PropertyAssignment) continue;
      arg = text.getInitializer();
    }
    out.push({ node: call, segments: foldSql(arg) });
  }
  return out;
}

/** `U&"…"` with its `\XXXX` / `\+XXXXXX` escapes (or a UESCAPE character) decoded. */
function decodeUnicodeIdent(value, escape = "\\") {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== escape) {
      out += value[i];
      continue;
    }
    if (value[i + 1] === escape) {
      out += escape;
      i += 1;
    } else if (value[i + 1] === "+" && /^[0-9A-Fa-f]{6}$/.test(value.slice(i + 2, i + 8))) {
      out += String.fromCodePoint(parseInt(value.slice(i + 2, i + 8), 16));
      i += 7;
    } else if (/^[0-9A-Fa-f]{4}$/.test(value.slice(i + 1, i + 5))) {
      out += String.fromCodePoint(parseInt(value.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += value[i];
  }
  return out;
}

/**
 * The writer findings for one SQL text: a statement-leading SET or RESET, an
 * ALTER … SET/RESET, a DO block, EXECUTE (outside a GRANT/REVOKE privilege
 * list), and any `set_config` identifier — plain, quoted, schema-qualified,
 * or U&-escaped, whatever follows it.
 */
function writerFindingsOf(input) {
  const tokens = tokenizeSql(input);
  const findings = [];
  const statements = [[]];
  for (const t of tokens) {
    if (t.type === TOKEN.SEMI && t.depth === 0) statements.push([]);
    else statements[statements.length - 1].push(t);
  }
  for (const stmt of statements) {
    const lead = stmt[0];
    const leadWord = lead?.type === TOKEN.WORD ? lead.upper : null;
    if (leadWord === "SET" || leadWord === "RESET") findings.push(`statement-leading ${leadWord}`);
    if (leadWord === "DO") findings.push("DO block");
    if (leadWord === "ALTER" && stmt.some((t) => t.type === TOKEN.WORD && (t.upper === "SET" || t.upper === "RESET"))) {
      findings.push("ALTER … SET/RESET");
    }
    if (leadWord !== "GRANT" && leadWord !== "REVOKE" && stmt.some((t) => t.type === TOKEN.WORD && t.upper === "EXECUTE")) {
      findings.push("EXECUTE");
    }
    for (let i = 0; i < stmt.length; i++) {
      const t = stmt[i];
      let name = null;
      if (t.type === TOKEN.WORD) name = t.text;
      else if (t.type === TOKEN.QIDENT) {
        name = t.value;
        const amp = stmt[i - 1];
        const u = stmt[i - 2];
        if (amp?.type === TOKEN.OP && amp.text === "&" && u?.type === TOKEN.WORD && u.upper === "U") {
          const esc = stmt[i + 1]?.type === TOKEN.WORD && stmt[i + 1].upper === "UESCAPE" && stmt[i + 2]?.type === TOKEN.STRING
            ? stmt[i + 2].text.slice(1, -1)
            : "\\";
          name = decodeUnicodeIdent(t.value, esc);
        }
      }
      if (name !== null && name.toLowerCase() === "set_config") findings.push("set_config");
    }
  }
  return [...new Set(findings)];
}

const writerViolations = [];
for (const path of scope.files) {
  const file = toRelPosix(path);
  if (WRITER_EXEMPT_FILES.has(file)) continue;
  const psf = program.getSourceFile(path);
  if (!psf) continue;
  for (const { node, segments } of rawSqlArgumentsIn(psf)) {
    const findings = writerFindingsOf(sqlInputOf(segments));
    if (findings.length > 0) writerViolations.push({ file, line: node.getStartLineNumber(), detail: findings.join(", ") });
  }
}

// Every own code file under these roots, tests included: a pool a test builds
// is a pool the factory's listener does not see.
const CODE_ROOTS = ["src", "scripts"];
const CODE_EXT = /\.([cm]?[jt]sx?)$/;
// Files the function rule reads as text (SQL, shell, workflow YAML).
const FUNCTION_TEXT_ROOTS = ["src", "scripts", ".github"];

function walkFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).split(sep).join("/"));
}

const POOL_FACTORY = "src/lib/db/pool-factory.ts";
// Constructions outside the factory, each a superuser or no-bypass site with no
// bypass to report (R5-M2). An entry that matches no construction fails the run.
const POOL_RULE_ALLOWLIST = new Map([
  ["scripts/bootstrap-rds-roles.mjs", "operator DB-role tooling: connects as the superuser to create roles, runs no application code"],
  ["scripts/audit-db-grants.mjs", "operator DB-role tooling: reads the catalog as the superuser, runs no application code"],
  ["src/__tests__/db-integration/setup.ts", "the suite's preflight probe: reads pg_stat_activity and role privileges before any pool exists"],
  ["src/__tests__/db-integration/bootstrap-rds-roles.integration.test.ts", "superuser clients that drive the role bootstrap under test"],
  ["src/__tests__/db-integration/audit-db-grants.integration.test.ts", "the superuser client that drives the grant audit under test"],
  ["src/__tests__/db-integration/rls-bypass-grants.integration.test.ts", "the old-code cell: a pool deliberately WITHOUT the factory's listener, proving report mode admits old code (E2)"],
]);
// A regex, as check-raw-sql-usage matches it: a string literal naming a Prisma
// package outside an import is that gate's SPECIFIER_LITERAL.
const PG_MODULE_RE = /^(?:pg|@prisma\/adapter-pg)$/;
const PG_CONSTRUCTORS = new Set(["Pool", "Client", "PrismaPg"]);

/**
 * The pool rule's subjects in one file: `new` of a pg Pool/Client or a
 * PrismaPg adapter, by spelling (`new Pool`, `new X.Pool`, `new X.Client`,
 * `new PrismaPg`) or by binding (any name imported or required from "pg" /
 * "@prisma/adapter-pg"), plus any value use of such a constructor that is not
 * a `new` (an alias, a subclass) — where it is constructed is then not here.
 * Read with the compiler's own parser and walker: this pass covers every own
 * code file, tests included, and ts-morph's node wrappers cost more than the
 * Program-backed checks above.
 */
function poolConstructionsIn(sf) {
  const moduleBindings = new Set(); // `pg` (default/namespace/require'd module object)
  const ctorBindings = new Set(); // named imports / destructured requires
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const specOf = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const found = [];
  const bindings = (node) => {
    if (ts.isImportDeclaration(node) && PG_MODULE_RE.test(specOf(node.moduleSpecifier) ?? "") && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      if (clause?.name) moduleBindings.add(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) moduleBindings.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) ctorBindings.add(el.name.text);
    }
    if (ts.isCallExpression(node) && PG_MODULE_RE.test(specOf(node.arguments[0]) ?? "")) {
      const isLoad = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      let holder = node.parent;
      while (holder && (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder))) holder = holder.parent;
      if (isLoad && holder && ts.isVariableDeclaration(holder)) {
        if (ts.isIdentifier(holder.name)) moduleBindings.add(holder.name.text);
        else if (ts.isObjectBindingPattern(holder.name)) {
          for (const el of holder.name.elements) if (ts.isIdentifier(el.name)) ctorBindings.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, bindings);
  };
  bindings(sf);
  const isNewCallee = (node) => {
    let n = node;
    while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
    return !!n.parent && ts.isNewExpression(n.parent) && n.parent.expression === n;
  };
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      let callee = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      const hit =
        (ts.isIdentifier(callee) && (PG_CONSTRUCTORS.has(callee.text) || ctorBindings.has(callee.text))) ||
        (ts.isPropertyAccessExpression(callee) &&
          (PG_CONSTRUCTORS.has(callee.name.text) ||
            (ts.isIdentifier(callee.expression) && moduleBindings.has(callee.expression.text))));
      if (hit) found.push({ line: lineOf(node), text: `new ${callee.getText(sf)}` });
    } else if (
      ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && moduleBindings.has(node.expression.text) &&
      PG_CONSTRUCTORS.has(node.name.text) && !isNewCallee(node)
    ) {
      found.push({ line: lineOf(node), text: `${node.getText(sf)} used other than by \`new\`` });
    } else if (ts.isIdentifier(node) && ctorBindings.has(node.text) && !isNewCallee(node)) {
      const p = node.parent;
      const isDeclarationOrType =
        ts.isImportSpecifier(p) || ts.isBindingElement(p) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) ||
        ts.isTypeQueryNode(p) || (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ImplementsKeyword);
      if (!isDeclarationOrType) found.push({ line: lineOf(node), text: `${node.text} used other than by \`new\`` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A compiler-API literal or `+` concatenation, constant-folded like foldSql (no symbol resolution). */
function foldTsSql(node, sf) {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node)) {
    return foldTsSql(node.expression, sf);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ text: node.text ?? node.rawText ?? "" }];
  if (ts.isTemplateExpression(node)) {
    const out = [{ text: node.head.text ?? node.head.rawText ?? "" }];
    for (const span of node.templateSpans) {
      out.push(...foldTsSql(span.expression, sf), { text: span.literal.text ?? span.literal.rawText ?? "" });
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...foldTsSql(node.left, sf), ...foldTsSql(node.right, sf)];
  }
  return [{ opaque: node.getText(sf).slice(0, 40) }];
}

/** Every top-level literal or `+` concatenation in a code file, folded: `{ line, input }`. */
function sqlTextsIn(sf) {
  const out = [];
  const isPlus = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const visit = (node) => {
    const stringish = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || isPlus(node);
    let p = node.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) p = p.parent;
    const nested = p && (isPlus(p) || ts.isTemplateSpan(p));
    if (stringish && !nested) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, input: sqlInputOf(foldTsSql(node, sf)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const CREATE_ROUTINE = "CREATE [OR REPLACE] FUNCTION|PROCEDURE";
/** The routine names a CREATE [OR REPLACE] FUNCTION|PROCEDURE token sequence creates in `input`. */
function createdRoutinesOf(input) {
  const tokens = tokenizeSql(input);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== TOKEN.WORD || tokens[i].upper !== "CREATE") continue;
    let j = i + 1;
    if (tokens[j]?.upper === "OR" && tokens[j + 1]?.upper === "REPLACE") j += 2;
    if (tokens[j]?.type === TOKEN.WORD && (tokens[j].upper === "FUNCTION" || tokens[j].upper === "PROCEDURE")) {
      const name = tokens[j + 1];
      out.push(name ? nameOf(name) ?? name.text : "?");
    }
  }
  return out;
}

/**
 * A text file read as SQL by words alone: the lexer's quoting rules (`$$`,
 * `'`, `--`) do not hold in shell or YAML, where they would hide the very
 * text this looks for. Separators are whitespace and SQL comments; a quote or
 * backslash before the next word is skipped.
 */
// One separator run. A block comment ends at its first `*/`
// (`(?:[^*]|\*(?!\/))*`), so no input has two ways through it: the lazy
// `[\s\S]*?` it replaces backtracked exponentially on repeated `*//*`.
const SQL_WORD_SEP = String.raw`(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|--[^\n]*\n)+`;
const CREATE_ROUTINE_TEXT_RE = new RegExp(
  String.raw`\bCREATE${SQL_WORD_SEP}(?:OR${SQL_WORD_SEP}REPLACE${SQL_WORD_SEP})?(?:FUNCTION|PROCEDURE)\b(?:\s|["'` + "`" + String.raw`\\])*([A-Za-z_][\w.$]*)?`,
  "gi",
);

// Routines created outside prisma/migrations (R5-M2). A file entry names the
// routine it may create; an entry that matches nothing fails the run.
const FUNCTION_RULE_ALLOWLIST = [
  { file: "scripts/rls-cross-tenant-negative-test.sh", routine: "rls_negative_secdef_probe", why: "Case 9: a SECURITY DEFINER probe on a throwaway database, dropped by the case itself" },
  { prefix: "scripts/__tests__/", why: "gate fixture strings: inputs for the gates that refuse these statements" },
];
const functionAllowed = (file, routine) =>
  FUNCTION_RULE_ALLOWLIST.find((e) => (e.prefix ? file.startsWith(e.prefix) : e.file === file && e.routine === routine?.toLowerCase()));

const poolViolations = [];
const functionViolations = [];
const usedPoolAllowances = new Set();
const usedFunctionAllowances = new Set();
{
  const codeFiles = new Set(CODE_ROOTS.flatMap(walkFiles).filter((f) => CODE_EXT.test(f) && !/\.d\.[cm]?ts$/.test(f)));
  const noteRoutine = (file, line, routine) => {
    const entry = functionAllowed(file, routine);
    if (entry) usedFunctionAllowances.add(entry);
    else functionViolations.push({ file, line, detail: `creates ${routine ?? "a routine"} (${CREATE_ROUTINE})` });
  };
  for (const file of codeFiles) {
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
    if (file !== POOL_FACTORY) {
      for (const c of poolConstructionsIn(sf)) {
        if (POOL_RULE_ALLOWLIST.has(file)) usedPoolAllowances.add(file);
        else poolViolations.push({ file, ...c });
      }
    }
    // Function rule, code files: every literal or folded concatenation, not
    // only raw-SQL arguments — a routine body handed to a query by variable
    // is still created by this file.
    for (const { line, input } of sqlTextsIn(sf)) {
      for (const routine of createdRoutinesOf(input)) noteRoutine(file, line, routine);
    }
  }
  for (const file of new Set(FUNCTION_TEXT_ROOTS.flatMap(walkFiles))) {
    if (CODE_EXT.test(file)) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    const text = buf.toString("utf8");
    for (const m of text.matchAll(CREATE_ROUTINE_TEXT_RE)) {
      noteRoutine(file, text.slice(0, m.index).split("\n").length, m[1]?.split(".").pop());
    }
  }
}
for (const [file] of POOL_RULE_ALLOWLIST) {
  if (existsSync(file) && !usedPoolAllowances.has(file)) poolViolations.push({ file, line: 0, detail: "POOL_RULE_ALLOWLIST entry matches no construction: remove it" });
}
for (const entry of FUNCTION_RULE_ALLOWLIST) {
  if (entry.file && existsSync(entry.file) && !usedFunctionAllowances.has(entry)) {
    functionViolations.push({ file: entry.file, line: 0, detail: `FUNCTION_RULE_ALLOWLIST entry (${entry.routine}) matches nothing: remove it` });
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
  console.error("withBypassRls reaches Prisma models its grant does not list.");
  console.error(
    "Name a grant in src/lib/tenant-rls-grants.ts that lists exactly what the call reaches (add one after security review).",
  );
  console.error("");
  for (const { file, line, model, grant, via, through, relation } of modelViolations) {
    console.error(
      `  ${file}:${line}  prisma.${model}${via ? `  (reached in ${via})` : ""}${relation ? `  (relation ${relation})` : ""}  not in BYPASS_GRANT.${grant}${through ? `  (through ${through})` : ""}`,
    );
  }
}

if (staleEntries.length > 0) {
  failed = true;
  if (modelViolations.length > 0) console.error("");
  console.error("ALLOWED_USAGE has an entry for a file that makes no withBypassRls call and sets no bypass.");
  console.error("Remove it: the entry reads as a bypass this file performs, and it performs none.");
  console.error("");
  for (const file of staleEntries) console.error(`  ${file}`);
}

if (unnamedGrants.length > 0) {
  failed = true;
  console.error("");
  console.error("stale grant: a BYPASS_GRANT member no withBypassRls call or self-setting site names.");
  console.error("Remove it: a grant nothing uses reads to the next reviewer as a scope some path has.");
  console.error("");
  for (const name of unnamedGrants) console.error(`  ${GRANTS_FILE}:${GRANTS.get(name).line}  BYPASS_GRANT.${name}`);
}

if (staleAllowances.length > 0) {
  failed = true;
  console.error("");
  console.error("stale grant: a BYPASS_GRANT member lists a model no call naming it reaches.");
  console.error(
    "Remove the model: a permission that outlives its reason reads to the next",
  );
  console.error(
    "reviewer as the scope its call sites are meant to have.",
  );
  console.error("");
  for (const { grant, model } of staleAllowances) {
    console.error(`  ${GRANTS_FILE}:${GRANTS.get(grant).line}  BYPASS_GRANT.${grant}  prisma.${model}`);
  }
}

if (grantDefinitionViolations.length > 0 || grantViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("withBypassRls (or a self-setting site) is handed a grant this gate cannot read.");
  console.error(
    "Pass BYPASS_GRANT.* from @/lib/tenant-rls-grants (not an inline defineGrant, a",
  );
  console.error(
    "conditional, a cast or a variable), and for a file in ALLOWED_PURPOSES, a grant whose",
  );
  console.error("purpose is listed there. Each BYPASS_GRANT member is `NAME: defineGrant(BYPASS_PURPOSE.X, [models])`.");
  console.error("");
  for (const { file, line, detail } of [...grantDefinitionViolations, ...grantViolations]) {
    console.error(`  ${file}:${line}  ${detail}`);
  }
}

if (writerViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("raw SQL writes a session setting, or could, outside src/lib/tenant-rls.ts and");
  console.error(`${GRANTS_FILE}. Turn the bypass on with setBypassGucs(tx, BYPASS_GRANT.X), a lock`);
  console.error("timeout with setLockTimeout, and read the bypass state with readBypassState:");
  console.error("");
  for (const { file, line, detail } of writerViolations) console.error(`  ${file}:${line}  ${detail}`);
}

if (poolViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(`a pg Pool/Client or PrismaPg adapter is built outside ${POOL_FACTORY}, so the`);
  console.error("factory's notice listener never sees what its bypasses reach. Use createPool /");
  console.error("createClient / createPrismaClient, or add a superuser or no-bypass site to");
  console.error("POOL_RULE_ALLOWLIST with its reason:");
  console.error("");
  for (const { file, line, text, detail } of poolViolations) console.error(`  ${file}:${line}  ${text ?? detail}`);
}

if (functionViolations.length > 0) {
  failed = true;
  console.error("");
  console.error(`a routine is created outside prisma/migrations (${CREATE_ROUTINE}). A function`);
  console.error("body or a function-level SET clause can write the bypass settings where the writer");
  console.error("rule cannot see; create routines in a migration:");
  console.error("");
  for (const { file, line, detail } of functionViolations) console.error(`  ${file}:${line}  ${detail}`);
}

if (txLessViolations.length > 0) {
  failed = true;
  if (fileViolations.length > 0 || modelViolations.length > 0 || grantViolations.length > 0) {
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

// A client handed across a module boundary the Program could not map to one
// parameter of a function body. What it reaches there is reached under this
// bypass and judged by nothing, so it fails rather than exempting the file.
if (unfollowedHandOffs.length > 0) {
  failed = true;
  console.error("");
  console.error("a bypassed client is handed to a callee this gate cannot follow, so the");
  console.error("models reached there are unchecked. Pass the client to a function with a");
  console.error("body (not a .d.ts-typed value), positionally, into a plain parameter:");
  console.error("");
  const printed = new Set();
  for (const { file, at, reason } of unfollowedHandOffs) {
    const lineText = `  ${file}  ${at}  ${reason}`;
    if (printed.has(lineText)) continue;
    printed.add(lineText);
    console.error(lineText);
  }
}


// What Check 3's reach rests on (lib/soundness.mjs): a member holds only what
// its declaration says, and the scan set is every undeclared own file plus what it loads.
// check-rls-nesting reports the same; each gate refuses on its own.
const soundnessViolations = [...scope.violations, ...functionFlowViolations(program, scope, resolver.usedExternalShapes)];
if (soundnessViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("Check 3 cannot be trusted on this tree: production loads code the gates cannot read,");
  console.error("or puts a function where its declaration does not say (lib/soundness.mjs):");
  for (const v of soundnessViolations) console.error(`  ${v}`);
}

// A client erased to a type that no longer says it is one — `tx as unknown`,
// an own parameter typed `unknown` or `Pick<…Delegate, "deleteMany">`, an own
// interface it is assigned to — is then queried where neither a model read
// nor a delegate type names it. Refused anywhere in production.
const erasures = [];
for (const path of scope.files) {
  const sf = program.getSourceFile(path);
  if (!sf) continue;
  sf.forEachDescendant((node) => {
    for (const { source, target } of flowsOf(node, checker, carriesClient)) {
      if (!carriesClient(source.getType()) || carriesClient(target) || modelOfDelegateType(target) || isRawQueryOnly(target)) continue;
      erasures.push(`${siteOf(source)}  a client or delegate erased to ${target.getText().replace(/\s+/g, " ").slice(0, 60)}`);
    }
  });
}
if (erasures.length > 0) {
  failed = true;
  console.error("");
  console.error("A Prisma client or delegate is given a type that no longer says it is one, so the");
  console.error("queries run on it are charged to no model. Keep the client's own type:");
  for (const e of [...new Set(erasures)]) console.error(`  ${e}`);
}

// A file on INDIRECT_CALLBACK_ALLOWLIST has its unresolvable callbacks
// excused, and Check 3 reads only callbacks it can locate: the same file with
// an ALLOWED_USAGE entry would have its bypass callbacks judged by nothing.
const listOverlap = [...INDIRECT_CALLBACK_ALLOWLIST].filter((f) => ALLOWED_USAGE.has(f));
if (listOverlap.length > 0) {
  failed = true;
  console.error("");
  console.error("A file is on both INDIRECT_CALLBACK_ALLOWLIST and ALLOWED_USAGE. Its bypass callbacks");
  console.error("would reach no model check. Pass the callback inline, or remove one entry:");
  for (const f of listOverlap) console.error(`  ${f}`);
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
    `${bypassCallbacks} bypass callback(s) followed through ${reachedUnits} reached function(s); ` +
    `${unreadableArgCalls.length} call(s) run a query whose argument the relation walk cannot read: ` +
    `their relation reach is unknown in both directions — a missing relation-reached model is not ` +
    `reported, and their grants are not judged stale)`,
);
for (const site of [...unreadableArgCalls].sort()) console.log(`  unreadable relation argument: ${site}`);
