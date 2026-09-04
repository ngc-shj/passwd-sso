# Coding Deviation Log: audit-sentinel-carried-forward

Phase 2 of `audit-sentinel-carried-forward-plan.md` (revision 5, six locked
contracts C1–C6). Base `1628b97fe`; Phase 1 committed at `b4fa914f2`.

Entries are of three kinds: **carried-forward findings** (CFP1–CFP4, each
dispositioned here as Step 2-1 requires), **deviations** from the plan, and
**decisions Phase 2 was asked to take and record**.

---

## Carried-forward plan findings

### CFP1 — C3's `metadata.claim` requirement — **CLOSED by measurement, first**

The plan's instruction was to verify this before writing any other C3 test, and
that is the order taken. A rolled-back probe on the dev database seeded three
`audit_logs` rows and ran the `unmapped` query's own predicates:

- With `$3` as it ships today, the row carrying the new reason **does not come
  back at all** — the reason predicate drops it before `bucketOf` is ever
  consulted. This confirms `UNMAPPED_SELECTED_REASONS` is load-bearing rather
  than incidental.
- With the new reason registered, **two of three** rows return: the one carrying
  the new reason *without* `metadata.claim` is dropped by the middle gate
  `claim IS NOT NULL OR claim_refusal IS NOT NULL`. This is CFP1's exact stated
  failure mode, observed.

Both halves are therefore requirements of the implementation, not preferences,
and both emit sites carry `claim`. The measurement is in the plan's Derived
figures table with its command. **No deferral.**

### CFP2 — C4's `:141`/`:145` redundancy — **DECIDED: both removed, one adjudicator**

- The presence check (`!scope || !codeChallenge`) is **dead code** after the new
  gate at `:67`: any non-deny request with an empty or malformed
  `code_challenge`, or with a scope that cannot overlap `MCP_SCOPES`, is already
  refused there.
- The `code_challenge_method !== "S256"` check is removed too, and this one was
  checked rather than assumed, because the shared PKCE schema validates the
  *challenge* and says nothing about the *method*. Verified by reading
  `src/lib/mcp/oauth-server.ts:270-271`: `exchangeAuthorizationCode`
  **unconditionally** returns `invalid_request` for any
  `codeChallengeMethod !== "S256"`, at redemption. The consent route also
  defaults an absent method to `"S256"`, so no downgrade to `plain` is
  reachable. What changes is *when* a client sending a non-S256 method finds
  out: at token exchange rather than at consent. The browser-facing GET
  (`mcp/authorize/route.ts`) still refuses it early.
- Residual accepted: such a request now mints an `mcp_authorization_codes` row
  that can never be redeemed. It is behind a session, a step-up and the origin
  gate, and the row expires on its own TTL.

### CFP3 — `/api/mcp/token`'s capacity property — **CLOSED in Phase 3**

Phase 2 closed the bucket-identity half (with a null IP the limiter **is**
consulted, at `rl:mcp:token:ip:unknown`, and a legitimate exchange still
succeeds) and recorded the `limit`/`limit+1` half as deferred, on the ground
that "this route has no harness for [driving the real limiter against Redis];
building one means unpicking a module-scope mock the rest of the file depends
on."

**That justification was wrong, and Phase 3's Testing review said so.** Vitest
mocks are per file: `route.test.ts`'s module-scope mock never had to be touched.
The repo already had both halves of the pattern —
`src/__tests__/db-integration/rate-limit-fail-closed-chain.integration.test.ts`
imports `createRateLimiter` unmocked and drives `.check()` directly, and
`rate-limit-fail-closed-routes.integration.test.ts` drives two REAL route
handlers with no mock of `@/lib/security/rate-limit`. The recorded cost
overstated the work, which is exactly how a deferral outlives its reason.

**Closed by** `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts`,
which drives the real handler against the real limiter to `max` and `max + 1`.
Two decisions in it are worth stating:

- **The bound is read from configuration, not duplicated.** `MCP_TOKEN_IP_RATE_MAX`
  and `MCP_TOKEN_IP_RATE_WINDOW_MS` moved to `src/lib/constants/auth/mcp.ts`, and
  both the route and the test read them. CFP3 asked for "the number read from
  the limiter's configuration"; a second literal would let the two drift and the
  test would then pin a bound nobody applies.
- **It does NOT exhaust the `unknown` bucket.** That key is fixed, so driving it
  to its cap would race every other working copy on this shared dev Redis and
  leave the endpoint limited for them for the rest of the window. The capacity
  property runs on a per-run RFC 5737 address instead; the `unknown` bucket's
  identity stays pinned by the unit test. Neither half is sufficient alone and
  the file says so.

**Red-proved by execution, one mutation per clause**, in a detached worktree —
production source was never mutated:

| Mutation | Expected | Observed |
|---|---|---|
| the constant moved 30 → 3 | **green** — both sides read it, so the test tracks configuration | green |
| the route's bound decoupled from the constant (`+ 5`) | the bound clause reds | **both** cases red |
| the bucket key made global instead of per-IP | only the per-IP clause reds | exactly that case red, the bound case green |
| `getRedis()` forced to null, so the limiter fails closed | the ALLOW clause reds, at the first request | case 1 at `request 1 of 30 was not admitted … expected 503 to be 400`; case 2 at `the exhausted address was not refused, so the precondition for this case never held … expected 503 to be 429`. Round 3 found this row had claimed ONE shared message — see below |

The allow arm is load-bearing rather than decorative: `ipRateLimiter` is
`failClosedOnRedisError: true`, so an unreachable Redis refuses everything and
would satisfy the deny assertion on its own.

**Round 2 found that the first version of this file did not actually rule that
out** (T-F10, Critical). Its allow arm asserted `not 429`, and
`checkRateLimitOrFail` renders a fail-closed refusal as `oauthTemporarilyUnavailable()`
— **503**, not 429 — so all thirty iterations accepted it silently and only the
final boundary red, with a message naming neither the arm nor the request. The
property the file exists to prove went unasserted while the file read as though
it proved it.

The allow arm now asserts the concrete status an ADMITTED request produces:
`400 unsupported_grant_type`, the outcome of a request that reached the limiter,
was let through, and then failed at the grant-type switch.

**Round 3 then found that fix had closed the instance and not the class**
(F-R30-1). The loop got a diagnostic message; the file's other six assertions
stayed bare, so under the same fail-closed mutation the SECOND case red at
`expected 503 to be 429` — naming neither the arm nor what 503 meant, which is
precisely the defect T-F10 was written up to remove. The row above had recorded
one shared message for both cases and was overclaiming.

Every assertion in the file now carries a diagnosis, rendered by one `diagnose()`
helper so the meaning of 400/429/503 is stated once rather than seven times.
Re-running the mutation reds both cases with their own self-describing message.

### CFP4 — `isIpInCidr` normalization — **CLOSED**

The parity criterion is implemented over **both** a v4 and a v6 CIDR, for every
input in the allow and deny tables, in `src/lib/auth/policy/ip-access.test.ts`.
It reds if the normalization inside `isIpInCidr` / `isIpInParsedCidr` is dropped.
The two call sites are the whole change: `parseIpv6(ip)` → `parseIpv6(normalizedIp)`,
matching what each function's v4 branch already did.

### D6 — C1's deny arms are observable at three value sources, not five

The plan asks for the thirteen deny inputs "at each of the five value sources".
Measured: they can only be **observed** at three — (a) socket-not-trusted, (b)
`x-real-ip`, (c) the XFF walk's untrusted return. Sources (d) and (e), the two
all-trusted fallbacks, are structurally unreachable with an unparseable value:
reaching either requires every walked XFF entry to have matched a trusted CIDR,
which requires `parseIpv4`/`parseIpv6` to have succeeded on it — so an
unparseable entry is returned at (c) the moment the walk finds it untrusted, and
an unparseable socket is returned at (a).

What sources (d) and (e) *can* carry is a **non-normalized** spelling of an
otherwise-valid trusted address, which is precisely what forbidden pattern `#2`
(`return leftmost || socketIp`) targets. That is covered by the plan's own
witness and verified by execution: `TRUSTED_PROXIES=::1/128`, socket `[::1]`,
XFF `","` now returns `"::1"` rather than `"[::1]"`. The orchestrator re-ran all
thirteen deny inputs against all three reachable sources and the four allow
inputs directly against the modified module; every deny returned `null`.

No test was fabricated for the unreachable pair; the reason is recorded in the
code.

### D7 — three claims falsified while implementing C4/C6

Recorded because each would have shipped as a plausible-looking wrong thing:

1. **The two PKCE write destinations are the other way round.** Read from
   `prisma/schema.prisma`: `mobile_bridge_codes.code_challenge` is the narrower
   `VarChar(64)` and `mcp_authorization_codes.code_challenge` is `VarChar(128)`.
   The shared `max(64)` is stated against the narrower one, as the plan requires
   — but the plan's prose named them in the opposite order.
2. **Two existing test files' PKCE fixtures were already invalid.**
   `mcp/authorize/route.test.ts` and `src/__tests__/api/mcp/authorize.test.ts`
   used `code_challenge=abc` / `"abc123challenge"`, which the shared schema
   rejects. Adopting the schema would have turned nearly every case in both
   files red for a reason unrelated to what they test. Replaced with a shared
   43-character constant per file.
3. **`z.object({ f: SCHEMA })` does not call the field schema's public
   `.safeParse()`** in this repo's `zod@4.5.4`. A reference-identity test written
   as `vi.spyOn(schema, "safeParse")` would have silently passed while proving
   nothing at the object-nested ingress. Measured, and the assertion moved to
   `_zod.run`, which fires in both the direct and the nested case.

### D8 — C6's marker verified by execution, not by construction

The orchestrator re-ran `buildOutboxPayload` against an over-cap payload with
three `reason` shapes. Multi-byte (`重` ×400) and escape-heavy (`"` ×400) both
produce a **551-byte** serialized marker — the escape-aware measurement doing its
job, since the escape-heavy case retains far fewer characters for the same
serialized size — each retained value is a prefix of its original and neither
introduces a U+FFFD the input did not contain. A non-string `reason` yields
`{_truncated, _originalSize}` at 41 bytes, not `_unserializable`. `reason` was
confirmed absent from `METADATA_BLOCKLIST`, so the retention is not undone by
`sanitizeMetadata`.

---

## Deviations and decisions

### D1 — C2's guard has two arms, not one; the second denies nothing that worked

**Plan**: "checks `UUID_RE` then compares `tenantId.toLowerCase() !== SYSTEM_TENANT_ID`".

**Implemented**: exactly that, but the two failure directions are reported
separately — `RlsSentinelContextRefused` carries `refusal: "sentinel"` or
`"non_canonical_uuid"`, and the structured log line carries the same field. One
class, two repairs: fix the caller that built a non-UUID, versus a sentinel
incident. A shared value would send the reader to the wrong one.

The canonical-form arm was checked before it was written, because it looks like
a new denial and is not. `app.tenant_id` is read as
`current_setting('app.tenant_id', true)::uuid` in 112 policy expressions, so a
non-canonical value already raises 22P02 at the first policy evaluation —
measured on the dev database. The guard moves that failure to the context open,
where it names itself.

**Consequence accepted**: nine fixtures in `src/lib/tenant-rls.test.ts` passed
strings like `"tenant-abc"`, and passed only because Prisma is mocked there.
They are now canonical UUIDs. That is a correction, not an accommodation.

### D2 — a pre-existing Prisma migration-ledger repair on the dev database

`npm run db:migrate` refused to apply C2's migration, reporting
`20260902120000_set_system_tenant_audit_retention` as "modified after it was
applied" and offering to **reset the database**. Diagnosed in place rather than
reset: that migration's `_prisma_migrations` row carried the literal checksum
`manual-dev-apply`, a placeholder from an earlier session that applied it by
hand. Its effect was verified present and matching the file (`audit_log_retention_days`
= 365, `audit_chain_enabled` = false on the sentinel), so the row was repaired to
the file's real sha256 — old value recorded here as `manual-dev-apply` in case it
must be put back.

This is local dev-database state, not a repository change, and it is unrelated to
this branch except that it blocked the rollout. Production applies migrations
with `prisma migrate deploy` and real checksums, so nothing there is affected.

### D3 — the plan's C3 emit sites resolved to one, not two

The plan lists three constraint-firing paths. Two of them (`auth.ts`'s
membership upsert and its tenant-migration `user.update`) are inside
`ensureTenantMembershipForSignIn`, whose result already flows to the single
`emitAuthLoginFailure` at the signIn callback. Rather than adding a second emit
site, the catch converts the CHECK violation into a `SignInTenantResult` refusal.
The third (first-ever sign-in) has no such channel — the signIn callback returns
before the user row exists — so it keeps the adapter-local emit the existing
`TenantClaimUnusableError` arm already uses. **One new emit site, not two.**

### D4 — `bucketOf`'s injectivity guard is a parameterised function

The plan asks for "a guard refusing when any reason resolves to two distinct
buckets". Implemented as an exported `buildReasonBucketMap(refusalBucket, reasonOf)`
called at module load over the real tables, rather than an inline IIFE. The
reason is testability: the refusal is reachable from a test by passing a
colliding table, so the guard has a case that watches it fail without anything
mutating the real module. Proved separately on a throwaway copy that flipping
`claim_collision`'s declared bucket makes the real module refuse to load, and
that the unmutated module loads.

### D5 — the READMEs' new cause row does not spell the sentinel UUID

The row's remedy is a `tenant-domain add … --from <current-owner>`. Rather than
printing the sentinel's UUID in two more operator-facing files — which would
make them parity-gate sites and give the gate two more places to drift — the row
tells the operator to run the `add` the `unmapped` heading already names and
repeat with the `--from` that `add` prints back. `cmdAdd` constructs that exact
command from the row's real owner, so the operator never types the UUID.

---

### D9 — C5 uses the repo's existing un-factored dedup idiom, and no cap

No shared dedup helper was introduced. `src/lib/validations/common.ts` already
carries this exact transform twice (`bulkIdsSchema` / `bulkArchiveSchema`,
`.transform(ids => [...new Set(ids)])`), un-factored, so the seven new sites
follow the established convention rather than adding an eighth abstraction over
a one-expression transform.

**No cap anywhere**, per the plan's own deletion of it: for `z.array(z.enum(X))`
a post-dedup array cannot exceed `|X|` by pigeonhole, so a `.max(|X|)` can never
fire and its stated red proof was false by construction.

Two plan/prompt statements were corrected against the code:

- **C5 criterion 4's numbers.** The plan said "500 before, 200 after". Measured:
  the full legitimate set is 10 scopes joining to **158** characters; 200
  repetitions join to **2999**, which is what overflows `VarChar(1024)`; after
  the dedup it is **14**. In the Derived figures table.
- **Member 7 (`share.ts`) has no `.min(1)`**, only `.optional()`. The prompt said
  it did. Preserved as it is.

Both red proofs were executed rather than argued, and neither touched a
production file: (a) the ingress dedup was reconstructed as pre-fix and post-fix
Zod chains in a throwaway script — pre-fix keeps the duplicate, post-fix does
not; (b) `parseSaTokenScopes`' dedup was reverted **in a detached git worktree**
with `node_modules` symlinked, where the 200-repetition seeded case then threw
`P2000` *inside the transaction that had already flipped the request to
`APPROVED`* — the permanently-un-approvable state CF16 describes — while the
maximum-size case stayed green. The worktree was removed.

### D10 — a gate matched a comment, and the comment was reworded rather than the allowlist widened

`scripts/checks/check-raw-sql-usage.mjs` failed on `src/lib/prisma/prisma-error.ts`
with `MISSING_FROM_ALLOWLIST`. The file issues no SQL: the gate matched the raw
primitive's name **inside a docblock** explaining which Prisma error code each
write path produces, because the gate is a regex over file text.

Allowlisting it was rejected. The allowlist's own contract is "every production
file that calls a raw-SQL primitive", and the gate carries a `STALE_EXEMPT` arm
that fails when a listed file *stops* matching — so an entry that exists only
because of prose would fail the day somebody reworded the comment. The comment
now names the primitive without its `$` sigil and says why, which keeps both the
comment's meaning and the allowlist's.

### D11 — two mechanical-hook findings dispositioned, neither a defect

- **R3 (propagation)** — three sites still spell `"tenant-xyz"`, a literal C2's
  fixture rename removed elsewhere: `src/app/api/vault/status/route.test.ts:204`
  and `:230`, `src/app/api/vault/unlock/data/route.test.ts:122`. Read rather than
  assumed: both files `vi.mock("@/lib/tenant-rls")` wholesale, so the value never
  reaches the guard that now requires a canonical UUID. The rename was forced by
  the real guard; theirs is a mocked argument. Not a propagation gap.
- **R2 (hardcoded reuse)** — `"team-1"` in `team-policy.test.ts` and three UUIDs
  in `tenant-rls.test.ts` match constants named `TEAM_ID` / `OTHER_TENANT_ID` /
  `OTHER_TEAM_ID`. All four of those are **non-exported, file-local test
  constants** in unrelated suites (`src/__tests__/api/teams/audit-logs.test.ts`,
  `src/lib/crypto/webhook-aad.test.ts`). The values coincide; the concepts do
  not — one set is AAD-binding fixtures, the other is "an ordinary tenant" for the
  RLS guard. Importing across two independent suites to share a coincidence is
  what R2's value-equality-is-not-meaning-equality clause forbids. Kept separate.

### D12 — `refactor-phase-verify --force` fails locally for an environment reason

The gate reports `Branch is stale vs origin/main` naming an `expected` SHA of
`88c8a859e…`. Verified: `origin/main` **is** this branch's base `1628b97fe`
(`git rev-list --count 1628b97fe..origin/main` = 0). The `expected` value comes
from `.refactor-phase-verify-baseline`, a **git-ignored local file** dated months
ago. The script's own docblock names this exact false positive as the reason
`scripts/pre-pr.sh` invokes it with `--skip-merge-queue-guards`, and states that
CI's fresh checkout is always a first run and records the baseline instead. The
stale local file was left in place — it is the operator's, not this branch's.

`verify-references.sh --base 1628b97fe --strict` over the plan and this log
reports 75 citations: 6 OK, 4 SHIFTED, and 65 unresolvable because the Phase-1
artifacts cite bare filenames (`tenant-rls.ts:47`) rather than repo-relative
paths, which the gate cannot resolve. The bare-filename style is pre-existing and
is not corrected here.

The plan and review state that **every `file:line` in them anchors `1628b97fe`**,
and they are the record of what was true when the plan was written — renumbering
them in place would destroy that. So the mapping lives here instead. Each row was
re-read in the working tree, not inferred from a diff offset.

| Cited (at `1628b97fe`) | What it names | Now |
|---|---|---|
| `tenant-rls.ts:47` | the nesting guard | `src/lib/tenant-rls.ts:128` (its condition; the sentinel refusal follows at `:136`) |
| `tenant-rls.ts:53` | the caller-supplied `set_config` | `src/lib/tenant-rls.ts:138` |
| `tenant-domain-buckets.ts:9-32` | the "why the mapping is a table" docblock | unchanged, `:9` |
| `tenant-domain-buckets.ts:55-58` | `UNMAPPED_SELECTED_REASONS` | `:55-59` (a third reason) |
| `tenant-domain-buckets.ts:68-98` | `bucketOf` | `:91` |
| `tenant-domain-buckets.ts:92-98` | `REFUSAL_BUCKET` | `:108` |
| `scripts/__tests__/tenant-domain-buckets.test.ts:44-57`, `:59-76` | the two table cases | `:45-63`, `:65-82` |
| `service-account-token.ts:44` | `parseSaTokenScopes` | unchanged, `:44` |
| `team-policy.ts:193-198` | the arm C1 makes delegate | `src/lib/team/team-policy.ts:197` |
| `mobile/authorize/route.ts:85` | the inline PKCE clauses | `:88`, now the shared schema |
| `mcp/authorize/route.ts:127` | the `code_challenge` read | `:128` |
| `audit.ts:106` | the `json.length` comparison | `src/lib/audit/audit.ts:145`, now `Buffer.byteLength` |
| `common.server.ts:54` | `BASE64URL_RE` | `:63` (the `import { z }` and the new constants sit above it) |
| `src/__tests__/audit.mocked.test.ts:186` | the `expect.any(Number)` | `:193`, now the exact byte count |
| `consent/route.ts:67` | where `action` is read | `:74`; the new gates sit immediately below |
| `consent/route.ts:117`/`:118` | `userTenantId` bound / guarded | `:149`/`:150-151` |
| `consent/route.ts:135` | end of the deny arm | `:155` opens it; the passkey gate now follows it |
| `consent/route.ts:152` | the DCR claim block | `:208` |
| `consent/route.ts:141`/`:145` | the redundant presence / S256 checks | **removed** — CFP2 |
| `consent/route.ts:257` | the `already_claimed` 403 | `:313` |
| `consent/route.ts:280` | the residual `invalid_scope` | `:342` |
| `consent/route.ts:288` | the passkey gate | relocated to `:181`, above the claim block |

Continued — the C3 and C1 registration sites, each re-read rather than inferred:

| Cited (at `1628b97fe`) | What it names | Now |
|---|---|---|
| `auth-failure.ts:34-40` | `AuthLoginFailureReason` | `src/lib/audit/auth-failure.ts:34-53` (the 7th member carries its own docblock) |
| `auth-failure-mapping.ts:48-51` | `ClaimRefusalKind` | `:64-69` |
| `auth-failure-mapping.ts:104-108` | the `satisfies` `Extract<>` | `:131-140` |
| `auth.ts:74` | `SignInTenantResult.reason`'s `Extract<>` | `src/auth.ts:71`, widened at `:75-78` |
| `auth.ts:171` | `lookupRefusalReason`'s `Extract<>` | `:173`, widened at `:175-178` |
| `auth.ts:326` | the membership `upsert` that raises | `:389` (and `:399`, `:559` — three upserts, the row-8b one is `:389`) |
| `auth.ts:409` | the migration arm's `user.update` | `:472` |
| `auth-adapter.ts:330` | `user.create` | `src/lib/auth/session/auth-adapter.ts:331` |
| `auth-adapter.ts:347` | `tenantMember.create` (fires second) | `:348` |
| `ip-access.ts:245`, `:283` | the two `parseIpv6(ip)` calls C1 normalizes | unchanged at `:245`, `:283`, now `parseIpv6(normalizedIp)` |
| `ip-access.ts:402` | the raw-`socketIp` fallback | `:413-414`, now routed through `validatedIp` |
| `mcp/token/route.ts:66-67` | the `if (ip)` fail-open | `:72`, guard removed |

Citations this branch did NOT move, verified by re-reading each:
`constants/app.ts:47` (`UUID_RE`), `prisma.ts:178-179`, `scim-token.ts:77`,
`scim/v2/Users/route.ts:38` and `:163`, `proxy/api-route.ts:127`,
`proxy/page-route.ts:118`, `security/rate-limit-audit.ts:126`,
`vault-auto-promote.ts:135`, `validate-token-dpop.ts:90`, `mobile-token.ts:371`,
`vault-lockout.test.ts:85`. `helpers.ts:414-421` is cited for `refuseSentinel`,
which is at `:435` — the file moved under an unrelated earlier change, not this
one, and the citation was already off at `1628b97fe`.

## Deferred CI-gate parity

`bash ~/.claude/hooks/extract-ci-checks.sh` yields 15 gate commands; eleven are
covered by `scripts/pre-pr.sh`. Four are not, and they are exactly the four the
plan's requirement N3 already names:

- `bash scripts/check-state-mutation-centralization.sh`
- `npm run licenses:check:strict`
- `npm run licenses:check:cli:strict`
- `npm run licenses:check:ext:strict`

**Deferred parity gap** — these are run manually at Step 2-4 rather than added to
`pre-pr.sh`. *Anti-Deferral: worst case — a future PR that does not read N3 skips
one of the four and finds out in CI; likelihood moderate. Cost to close — four
lines in `pre-pr.sh`, but that script dispatches its gates through a batching
harness, and R44's executed-member-set clause means restructuring what it
dispatches needs its own manifest assertion and red proof. That is a change to
shared release tooling, not to this branch's contract set, and bundling it here
would put an unreviewed gate-harness edit inside a six-contract security branch.
What would settle it: a separate PR adding the four with the manifest assertion.*

---

## Step 2-5 self-R-check — three findings, all fixed in Phase 2

Three sub-agents ran a focused pass over R1–R57 (+RS*/RT*). Security returned
**No findings**. Functionality and Testing returned one Major each, plus a second
Major from Testing. All three were fixed here rather than carried to Phase 3.

### F1 (Testing, RT10) — the `teams` CHECK had no boundary-adjacent allow arm

The `users` deny case paired with a near-miss tenant (`…0003`), proving the CHECK
is an equality rather than a blanket refusal on the column. The `teams` case
paired with a freshly-generated random tenant — a value a blanket refusal would
also accept, so it could not distinguish the two. The two CHECKs are textually
identical predicates added in one migration, so the failure mode is symmetric and
proving it on one half left the other unmeasured.

**Fixed**: the near-miss creation is now a shared `ensureNearMissTenant()` helper
and both cases use it, each reclaiming its own row in a `finally`.

### F2 (Testing, R29) — a docblock claimed a mechanism that did not exist

`src/lib/tenant/sentinel-tenant-constraint.ts` said the constraint-name set's tie
to the migrations "is checked by execution — the integration test reads
`pg_constraint`". No file read `pg_constraint` for these names. What existed was
two deny cases asserting a raised constraint name by value, which is a real
execution check but a different one, and which **cannot scale with the set**: a
fourth name added to `SENTINEL_TENANT_CONSTRAINTS` that names nothing would never
be raised by any case, so the classifier would silently never match it.

**Fixed by making the claim true rather than by softening it**: a case now reads
`pg_constraint` for the whole set and asserts the names round-trip. The docblock
names both mechanisms and says which one scales.

### F3 (Functionality, R29) — the READMEs' narration went stale against their own new row

The cause table gained a fifth row, so the paragraph under it — "Key the **last
two** cases on the field" and "`unmapped` reports the **four** causes under three
headings" — became wrong in both languages: the field-discriminated pair is no
longer positionally last, and the count is five. This is the runbook an operator
reads during the exact lockout C3 exists to make legible.

**Fixed**: the sentence now names the pair by its field (`claimRefusal`) rather
than by position, the count is five, and the sentinel row's heading is stated.

Re-verified after the three fixes: typecheck, lint, the affected unit trees
(234), and the two affected integration suites (16) all green.

### F4 (pre-PR gate, R36-adjacent) — direct `process.env` mutation in a touched test file

`scripts/checks/check-test-hygiene.sh` refused
`src/__tests__/lib/ip-access.test.ts` for six direct `process.env.X = …`
assignments where the repo requires `vi.stubEnv` (setup.ts wires
`vi.unstubAllEnvs()` into `afterEach`). All six are **pre-existing** — the diff
adds none — but the gate scans whole changed files, so C1 touching this one
surfaced them, and CLAUDE.md's rule is to fix them rather than dismiss them as
unrelated.

**Fixed**: converted to `vi.stubEnv`, matching what the co-located twin
`src/lib/auth/policy/ip-access.test.ts` already did. The hand-rolled
save-and-restore `afterEach` went with them — it was not only redundant but a
leak, since a case throwing between the save and the restore left the env
mutated for the rest of the file. 289 tests across both twins green after.

### A gate that was vacuous until the work was committed

Worth recording as process rather than as a defect. The first full
`scripts/pre-pr.sh` run reported **69 passed / 0 failed** while the Phase 2 work
was still uncommitted. The run after committing reported **76 passed / 1
failed** — and the failure above is what the extra steps found.

The cause: several pre-PR gates, `check-test-hygiene.sh` among them, scope
themselves to `git diff --name-only main...HEAD`. With the work uncommitted that
set is empty, so those gates report OK having examined nothing. The same applies
to the Step 2-5 mechanical hooks, which reported "Changed files: 2" on the same
tree. **A green pre-PR run on an uncommitted tree proves less than it appears
to**; the numbers to trust are the ones from after the commit.

### F5 (Step 2-5 mechanical, R2) — one column width spelled two ways

`src/lib/validations/scope-column-fit.test.ts` reads
`ServiceAccountToken.scope`'s `@db.VarChar(N)` out of `prisma/schema.prisma`;
`src/__tests__/db-integration/access-request-approve-scope-dedup.integration.test.ts`
spelled the same width as a literal `1024` at both of its bounds. Widening the
column would leave the integration case asserting the old bound — and its
"this value overflows the column" assertion would go on passing while claiming
an overflow that no longer happens.

**Fixed**: the reader moved to `src/__tests__/helpers/schema-column-width.ts` and
both files use it. It throws rather than returning null, so a renamed column
fails loudly instead of handing its caller a reason to skip.

Two other mechanical hits were dispositioned as coincidences and left alone: the
R3 "stale reference to `arrange`" hits are a common test-helper word, and the
`1024` matching `MAX_TOTAL_BYTES` in `check-compose-log-caps.mjs` is a compose
log cap, not a column width — the hook's own guidance is that small numbers
collide, and importing one concept's constant for the other is what R2 forbids.
The bare `#2` this hook found in this log is now backticked.

### F6 (Step 2-5 mechanical, RT3) — one route path spelled twice, and sixteen placeholders that are not

`check-hardcoded-reuse` reported 17 Major hits. Sixteen are the repo's ubiquitous
test placeholders — `"tenant-1"`, `"user-1"`, `"team-1"`, and four fixture UUIDs
— each matching a **non-exported, file-local `const`** in an unrelated suite
(`dcr-cleanup/route.test.ts`, `share-links/mine/route.test.ts`,
`team-empty-trash.test.ts`, `webhook-aad.test.ts`). Importing a placeholder
across two independent suites to share a coincidence is what R2's
value-equality-is-not-meaning-equality clause forbids; they are left alone.

The seventeenth is real and was fixed: `consent/route.test.ts` asserted
`url.pathname` against the literal `"/api/mcp/authorize"` at two sites while the
route builds that URL from `API_PATH.MCP_AUTHORIZE`. The hook pointed at
`cli/src/lib/oauth.ts`'s copy, which is a separate package and not importable
here — but the app's own `src/lib/constants/auth/api-path.ts` is, and using it
makes the assertion say what is under test (the stale step-up bounce lands on
the authorize endpoint) rather than pinning a second spelling of the path.
