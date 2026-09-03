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

### CFP3 — `/api/mcp/token`'s capacity property — **PARTIALLY closed, and the remainder is named**

The bucket-identity half is done: with a null IP the limiter **is** consulted, at
`rl:mcp:token:ip:unknown`, and a legitimate exchange still succeeds.

The `limit` / `limit+1` half is **not reachable in this harness and was not
faked**: `src/app/api/mcp/token/route.test.ts` mocks `@/lib/security/rate-limit`
at module scope with a recording factory returning canned `check` functions, so
there is no real counter to advance. *Anti-Deferral: worst case — C1 converts a
fail-open into a fleet-wide shared `unknown-ip` bucket and no test reds if that
bucket's configured limit is too low for the aggregate traffic that now lands in
it. Likelihood — moderate; this is a real capacity change, not a theoretical one.
Cost — an integration case that drives the real limiter against Redis, which this
route has no harness for; building one means unpicking a module-scope mock the
rest of the file depends on. What would settle it: that case, plus recording the
configured number as an operator judgement rather than a test assertion.*

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
otherwise-valid trusted address, which is precisely what forbidden pattern #2
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

## Citation drift caused by Phase 2 (R29, mechanical half)

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
| `tenant-rls.ts:47` | the nesting guard | `src/lib/tenant-rls.ts:129` |
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
| `src/__tests__/audit.mocked.test.ts:186` | the `expect.any(Number)` | `:192`, now the exact byte count |
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
