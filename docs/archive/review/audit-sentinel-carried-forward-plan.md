# Plan: audit-sentinel carried-forward findings CF11–CF17

Closes findings carried forward from #812
(`docs/archive/review/audit-sentinel-verification-gaps-plan.md`, lines 1162–1379).

Branch: `fix/audit-sentinel-carried-forward-cf11-cf17`
Base: `1628b97fe`
Revision: 5 — final. Rounds 1–4 in `audit-sentinel-carried-forward-review.md`.

**What revision 5 is.** Four rounds returned 43, 42, 34 and 32 findings. Round 4's Criticals were all inside mechanisms *revision 4 introduced*, and three of them were settled by a single execution taking under a minute. Two clauses (C5's cap, C3's reason registration) had their fix generate the next round's finding twice running. That is the recorded signal that the over-specified part is the wrong scope, and the remedy is to discard it rather than iterate.

So revision 5 keeps **decisions** — what must hold, which mechanism was chosen, what was measured — and drops **specifications**: exact assertion spellings, per-criterion harness assignments, fixture construction detail. Phase 2 builds and measures those; a mechanism that cannot be described without being run is one to run.

**Contract ID map** (revision 3 reused IDs while asserting it did not): C1→C1, C2→C2, C3→C3, C4 was C5, C5 was C6, C6 was C7; the original C4 (user-agent) is withdrawn — SC4.

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16), multi-tenant, E2E-encrypted vault
- **Test infrastructure**: unit + integration (real DB) + E2E + CI/CD, ~80 gates under `scripts/checks/`
- **Verification environment constraints**:
  - **VC1 — no reverse proxy in dev.** Trusted-proxy XFF paths are unit-verifiable, `blocked-deferred` as a full proxied request. *Anti-Deferral: worst case — a real proxy sends a header shape the fixtures do not model; likelihood low (C1 adds no parsing path); cost a staging deployment behind nginx, unavailable.*
  - **VC2 — integration tests and the compose workers cannot share a database.** With the outbox worker stopped, an emitted audit row sits `PENDING` in `audit_outbox` and never reaches `audit_logs` — so anything asserting on `audit_logs` in an integration run passes vacuously.
  - **VC3 — the dev database is shared and live.** Subject: the guard-removal proof (#812's `trackTenant` incident) and any fixture that can COMMIT sentinel-scoped rows. A *rejected* INSERT is out of scope — it raises and rolls back, and `audit-sentinel.integration.test.ts:174` already asserts one on dev.
  - **VC4 — `prisma migrate dev` times out on its post-apply prompt.** Verify via `_prisma_migrations` and `pg_constraint`.
  - **VC5 — no SAML IdP in dev.** C3 is unit- and integration-verifiable, `blocked-deferred` as a real SSO round trip. *Anti-Deferral: worst case — the 23514 surfaces through an Auth.js path no test models; likelihood low, the state is unreachable in-app (SC8); cost a hosted IdP, unavailable.*

## Objective

1. A request-derived IP is either a parseable address or absent — never an arbitrary string (CF11).
2. The sentinel cannot become `app.tenant_id` (CF12).
3. A sentinel-pointing claim — reachable only out-of-band — refuses sign-in and leaves a record `tenant-domain unmapped` will print (CF13).
4. Three adjacent pre-existing defects stop being reachable (CF15–CF17).

CF14 has no objective here — SC4.

## Requirements

- **F1** — No allow/deny verdict of tenant IP restriction, team IP restriction or Tailscale verification changes. **C1 restores this literally by normalizing inside `isIpInCidr`** — see C1.
- **F2** — No backfill (SC3).
- **F3** — Every refusal this branch adds is auditable and distinguishable, with **two stated exceptions**: C2's sink refusal (a deployment-integrity event at a position with no request context — structured log only) and C4's ingress 400s (the request never reached an authorization decision; the two decisions that are reached remain audited).
- **F4** — The legitimate full scope set for each bounded scope column continues to validate and to fit.
- **N1** — `Buffer.byteLength` allocates no copy. By inspection; this repo has no audit benchmark.
- **N2** — `check-sentinel-tenant-literal-parity.mjs` green across `SQL_SITES` and `DOC_SITES`.
- **N3** — `bash scripts/pre-pr.sh` green, plus `scripts/check-state-mutation-centralization.sh` and `licenses:check:{,cli:,ext:}strict`.

## Derived figures

Every number ships its command, run on `1628b97fe`. **The only place a number may be stated.**

| claim | command | value |
|---|---|---|
| external `extractClientIp*` call expressions | `grep -rnoE "extractClientIp(FromHeaders)?\(" src/ --include='*.ts' --include='*.tsx' \| grep -v "\.test\.\|__tests__" \| grep -v "policy/ip-access.ts" \| wc -l` | **31** expressions, **28** files |
| IP-keyed limiter sites | `grep -rn "rateLimitKeyFromIp(" src/ --include='*.ts' --include='*.tsx' \| grep -v "\.test\.\|__tests__"` | **8** − declaration − gated helper = **6** |
| `checkIpRateLimit` scopes | `node scripts/checks/check-bound-unknown-ip.mjs` | **13: 12 bound, 1 documented-exclusion** |
| request-IP slice sites, 45-wide | `grep -rnE "slice\(0, (AUDIT\|SESSION\|SHARE_ACCESS)_IP_MAX_LENGTH\)" src/ \| grep -v "\.test\.\|__tests__" \| wc -l` | **9** — `AUDIT` 4, `SESSION` 2, `SHARE_ACCESS` 3, across 3 columns and 3 constants |
| request-IP slice sites, 64-wide | same shape over `EXTENSION_BRIDGE_CODE\|MOBILE_BRIDGE_CODE\|EXTENSION_TOKEN_LAST_USED` | **6** — covered a fortiori by I1.2 |
| `set_config('app.tenant_id'` sites | `grep -rn "set_config('app.tenant_id'" src/ \| grep -v "\.test\.\|__tests__"` | **8**: 7 literal, 1 caller-supplied (`tenant-rls.ts:53`) |
| `AuthLoginFailureReason` anchors | `rg -n 'AuthLoginFailureReason' src/ scripts/ --glob '!**/__tests__/**'` | the registration set — see C3 |
| `MCP_SCOPES` cardinality | `node -e` over `src/lib/constants/auth/mcp.ts` | **9**, joining to ~140 characters |
| sentinel rows, dev, 2026-09-03 | C2 pre-flight | `teams`/`users`/`tenant_members` **0**; `audit_logs` **5**, `audit_outbox` **5**, `tenant_claims` **0** |

The last row is why C3's fixture cannot use absolute-zero preconditions: sentinel-scoped audit rows are the **normal steady state** of a live deployment — the sentinel is what unattributable emits FK to.

## Contracts

### C1 — the client IP boundary validates (CF11)

`extractClientIp` / `extractClientIpFromHeaders` return `null` or a value `isValidIpAddress` accepts **after** `normalizeIp`. The normalized value is returned.

- **I1.1** — a non-null return satisfies `isValidIpAddress`.
- **I1.2** — a non-null return is at most 45 characters. **Live dependents**: the nine 45-wide slice sites across three columns and three constants (`AUDIT_IP_MAX_LENGTH`, `SESSION_IP_MAX_LENGTH`, `SHARE_ACCESS_IP_MAX_LENGTH` — the per-column separation `common.server.ts:114-118` deliberately keeps), plus six 64-wide sites covered a fortiori. If I1.2 holds, all fifteen become provable no-ops for request-derived values. Witness: `2001:0db8:0000:0000:0000:0000:255.255.255.255` — **not** the IPv4-mapped form, which normalizes to length 15.
- **I1.3** — no verdict of `evaluateAccessPolicy`, `checkTeamAccessRestriction` or `wouldIpBeAllowed` changes.

**Control class**: `enforceable boundary` over the 31 call expressions. **Adjudication authority**: `parseIpv4`/`parseIpv6` via `isValidIpAddress`.

**`isIpInCidr` normalizes — a decision, not a note.** `isIpInCidr` passes the **raw** string to `parseIpv6` while normalizing for the v4 branch (`ip-access.ts:245`, `:283`), so `[::1]` is boundary-accepted and policy-rejected. Rounds 3 and 4 measured that this is not academic: the all-trusted XFF fallback returns a raw `socketIp` (`ip-access.ts:402`), so a v6 CIDR allowlist would see a **deny→allow flip** post-C1. Revisions 2–4 called this unreachable and then relied on the same path to justify a forbidden pattern. **C1 passes `normalizedIp` to `parseIpv6` in `isIpInCidr`/`isIpInParsedCidr`, as the v4 branch already does.** That removes the third direction rather than documenting it, restores F1 literally, and makes boundary and policy share one accept set on the raw domain too. The change is two call sites and is inside C1's own contract, not a separate one.

**Zone-id decision** (CF11 names it as owed). Rejected → `null`. One reason, because two others were falsified by execution: *a zone id names a local interface and cannot describe a peer reached through a proxy.* Mechanism: `parseGroups`' `^[0-9a-fA-F]{1,4}$` rejects `%`. **Standing note**: `net.isIP` *accepts* scoped forms, so swapping to it would be a widening.

**Port-suffixed forms** rejected, not stripped — SC1.

**Five value sources**: socket-not-trusted, `x-real-ip`, XFF walk, all-trusted-fallback via `leftmost`, all-trusted-fallback via the raw `socketIp` (`ip-access.ts:402`). The fifth is the one forbidden pattern #2 targets and is reachable — `TRUSTED_PROXIES=::1/128`, socket `[::1]`, XFF `","`.

**Rate-limit direction.** Twelve of thirteen `checkIpRateLimit` scopes bind IP-less traffic; `csp_report` is the manifested exclusion. Of the six directly IP-keyed sites: three use `?? "unknown"` and tighten; `s/[token]/page.tsx:36` is neutral; `security/rate-limit-audit.ts:126` **loosens observability** (it is the de-dup throttle for `rate-limit.fail_closed` emissions, consulted only when `userId == null`, so more `null` means fewer telemetry records); and `mcp/token/route.ts:66-67`'s `if (ip)` **fails open** — C1 closes it. That site is invisible to `check-bound-unknown-ip.mjs`, which matches `checkIpRateLimit` call expressions only, so the manifest adjudicates the twelve and not this one.

**Team path — a behaviour change C1 causes and repairs.** Pre-C1, an unparseable IP reaches `checkTeamAccessRestriction` and emits `ACCESS_DENIED` before throwing; post-C1 `clientIp === null` takes `team-policy.ts:193-198` and throws with no emit when `teamAllowedCidrs.length > 0`. Verdict unchanged, audit row lost. **C1 delegates at that branch** — `checkTeamAccessRestriction(teamId, "", userId, policy)`, the shape `:205` already uses — rather than inlining a second emit site with a second reason string. Two consequences to accept: the thrown message changes to the sibling's, and a team that is both explicitly-CIDR'd and inheriting performs the tenant lookup. Both are denials either way.

**Forbidden patterns**: `return normalizedSocket;`; `return leftmost || socketIp`; `if (ip) {` guarding a rate limiter.

**Acceptance**

1. **Allow arms, by value** — `192.168.100.228`, `::ffff:192.168.100.228 → "192.168.100.228"`, `2001:db8::1`, `[::1] → "::1"`, `100.64.1.2`, and the rightmost-untrusted walk unchanged. This is F1's over-rejection guard; over-rejection is the only direction F1 can break once `isIpInCidr` normalizes.
2. **Deny arms** — these thirteen → `null`, at each of the five value sources: `not-an-ip` · `'; DROP TABLE audit_logs;--` · `192.168.1.1:8080` · `fe80::1%eth0` · `192.168.001.1` · `1e2.64.0.1` · `::ffff:1e2.64.0.1` · `<script>alert(1)</script>` · `0000:0000:0000:0000:0000:ffff:255.255.255.255%25eth0` · `unknown` · `` · `1:2:3:4:5:6:7:8::` · `1:2:3:4:5:6:7:1.2.3.4`
3. **I1.2** against `AUDIT_IP_MAX_LENGTH`, with both witnesses.
4. **`isIpInCidr` parity** — for every input in 1 and 2, `isIpInCidr(raw, cidr) === isIpInCidr(normalizeIp(raw), cidr)` over a v4 and a v6 CIDR. This is what makes F1 literal, and it reds if the normalization is dropped.
5. **Rate limit** — an unparseable header on a bound scope lands in the `unknown-ip` bucket (asserted against the manifest); `/api/mcp/token` with a null IP is limited, with its bucket identity asserted, and a legitimate exchange still succeeds.
6. **Team path** — enumerated over `(teamAllowedCidrs, inheritTenantCidrs, tenantAllowedCidrs)`: `(non-empty, *, *) → 1` emit; `(empty, false, *) → 0`; `(empty, true, empty) → 0`; `(empty, true, non-empty) → 1`. Each zero-emit arm pairs with a positive control that the call resolved, so an early throw cannot pass for a zero.

**F1's evidence is a committed test, not a scratchpad probe.** `normalizeIp`, `isValidIpAddress`, `isIpAllowed` and `isTailscaleIp` are exported, pure, and unmodified by C1, so the measurement that settled F1 — no value the boundary nulls reaches any allow arm — holds identically before and after and belongs in `src/lib/auth/policy/ip-access.test.ts` as a permanent guard. Revisions 1–4 offered three unrunnable substitutes for this (a "before" column with no source, a worktree fixture that resolved to the wrong tree, and a property measured to carry zero information); the committed table is the first that a reader can execute.

**Consumers**: all 31 call sites have a `null` arm, and no consumer compares a stored IP for authorization. Two worth naming — `proxy/api-route.ts:127` and `proxy/page-route.ts:118`, both into `checkAccessRestrictionWithAudit`, which on denial also writes `metadata.clientIp`, a second widthless sink.

**Twins**: `src/lib/auth/policy/ip-access.test.ts` is the only tree that can reach the socket paths (it passes an explicit `socketIp`); `src/__tests__/lib/ip-access.test.ts` reaches `extractClientIp` through `NextRequest`, which exposes no socket peer. Both must red when the validation is reverted.

### C2 — the sentinel cannot become `app.tenant_id` (CF12)

**(a) Sink refusal** in `withTenantRls`, **after** the existing nesting guard (`tenant-rls.ts:47`), so a nested call stays a bare `INVALID_RLS_NESTING`.

**Case-folded comparison.** Postgres holds `'{…-002}'::uuid`, the unhyphenated form and the uppercase form all equal to the canonical sentinel; JS `===` holds none of them equal. `UUID_RE` (`constants/app.ts:47`) rejects the first two but carries `/i`, so case is the axis it leaves — and the guard is sound today only because the sentinel is digit-only. The guard therefore checks `UUID_RE` then compares `tenantId.toLowerCase() !== SYSTEM_TENANT_ID`, which is sound for any future value.

**The refusal throws and logs; it does not write an audit row.** Both audit spellings are unsafe from that position: with an explicit `tenantId`, `enqueueAudit`'s raw `$transaction` folds into the caller's transaction and turns RLS off for its remainder; without one, `resolveTenantId`'s `withBypassRls` is refused by the nesting guard and the row is swallowed. The position also has no `req`, `userId` or `ip` to attribute a row with. **Sink**: `getLogger()` with a fixed `event: "rls.sentinel_context_refused"` field — *not* `auditLogger`, which is `enabled: AUDIT_LOG_FORWARD === "true"` and ships `false`, and whose `audit.*` envelope is the one F3's own exception excludes this event from. Error: a named `RlsSentinelContextRefused`.

**(b) Migration**, in one transaction — two bare DDL statements red `check-migration-transaction.mjs`:

```sql
BEGIN;
ALTER TABLE "teams" ADD CONSTRAINT "teams_not_system_tenant"
  CHECK ("tenant_id" <> '00000000-0000-4000-8000-000000000002'::uuid);
ALTER TABLE "users" ADD CONSTRAINT "users_not_system_tenant"
  CHECK ("tenant_id" <> '00000000-0000-4000-8000-000000000002'::uuid);
COMMIT;
```

- **I2.1 (schema-enforced)** — no `teams`/`users` row names the sentinel, regardless of caller.
- **I2.2 (app-enforced)** — no `withTenantRls` call opens an RLS context on the sentinel, under any spelling Postgres accepts.

**Why the sink and not ~10 CHECKs** (user's decision). Roughly ten `tenant_id` columns reach `withTenantRls` across 126 call sites; a refusal at the one caller-supplied `set_config` site dominates all of them and covers columns added later. CHECKs stay on `users`/`teams` because those two are reachable from IdP-influenced claim resolution rather than from an admin's membership, and a CHECK survives an out-of-band write. **Evidence that no caller passes the sentinel today**: by provenance — `resolveTenantId` is the tree's only producer of `SYSTEM_TENANT_ID` as a `tenantId` value and it feeds `enqueueAudit`, never `withTenantRls`. Not by grep: 122 of 126 sites pass a variable.

**Control class**: both arms `enforceable boundary`; adjudication authority the case-folded equality and PostgreSQL respectively.

**Pre-flight (executed, dev, 2026-09-03)** — `teams_sentinel=0`, `users_sentinel=0`, `tenant_members_sentinel=0`. Non-zero is a data incident and stops this contract; a count that **errors** is a refusal, never a zero.

**Rollout**: pre-flight → `npm run db:migrate` with `MIGRATION_DATABASE_URL` → verify both names in `pg_constraint` (VC4) → integration. Rollback: `DROP CONSTRAINT` naming both, one transaction.

**Acceptance**

1. **Deny, executed** — per table, an INSERT naming the sentinel raises `23514` naming the constraint. Runs on dev; writes nothing.
2. **Allow** — ordinary rows insert and sweep. **Near-miss**: `…0003` inserts, proving the CHECK is an equality and not a blanket refusal.
3. **Sink guard** — the sentinel and its braced, unhyphenated **and uppercase** spellings all refuse (without all four a bare `===` passes); an ordinary tenant still opens the context; the anchor publisher's direct sentinel context is unaffected; a call nested inside `withBypassRls` still throws `INVALID_RLS_NESTING`, proving the order.
4. **Parity gate** — a new `SQL_SITES` entry at `occurrences: 2` with its drift and `omit` cases, and the OK-count moves `5` → `6`. `DOC_SITES` is **conditional**: the gate counts UUID literals, so updating `sentinel-tenant-membership.md` — which names only `tenant_members_not_system_tenant` — moves its pin only if the edit adds operator queries spelling the UUID. State which the edit is.
5. `check-destructive-migration.mjs` and `check-migration-transaction.mjs` green, the latter **without** a baseline entry.

**Red proofs**: drop each `ALTER TABLE` in turn on an **isolated** database; replace the case fold with a bare `===`; move the sentinel guard above the nesting guard.

### C3 — a sentinel-pointing claim refuses sign-in reportably (CF13)

**Scope** (SC8): `tenant-domain add` already refuses a sentinel target on the resolved id; the sign-in JIT path always targets a new tenant and the backfill filters on `external_id`, which the sentinel lacks. The state is reachable only out-of-band, so C3 is the observability half of SC9's accepted residual.

**Which constraint fires**: first-ever sign-in → `users_not_system_tenant` (`auth-adapter.ts:330` `user.create` precedes `:347`); returning user with no membership → `tenant_members_not_system_tenant` (`auth.ts:326`); tenant-migration arm → `users_not_system_tenant` (`auth.ts:409` `user.update`). `auth.ts:336` is unreachable — it needs an existing sentinel membership row, forbidden since `20260901090000`. `teams_not_system_tenant` is in the recognised set defensively; **no sign-in path writes a `teams` row**, so its clause is unfalsifiable by design and no red proof is claimed.

**The reason string is an eight-site change.** `AuthLoginFailureReason` (`auth-failure.ts:34-40`) is a closed six-member union and `ClaimRefusalKind` (`auth-failure-mapping.ts:48-51`) is a union of three named types, each with its own adjudicator. A sentinel-pointing claim is refused by a Postgres CHECK at write time and belongs to none of the three, so:

1. `claim_system_tenant` joins `ClaimRefusalKind` — **as a fourth constituent, and as a table key only**: it is never passed as a `claimRefusal` value, so `bucketOf`'s first branch (`claim_refusal !== null → REFUSED`) cannot fire for it. Without this the `REFUSAL_BUCKET` key does not compile; without the never-emitted property, `claimRefusal: null` and `REFUSAL_BUCKET.claim_system_tenant = UNREGISTERED` are jointly unsatisfiable. Record it in the map's docblock.
2. a seventh member of `AuthLoginFailureReason`;
3. the `Extract<>` at `auth-failure-mapping.ts:104-108`;
4. **`UNMAPPED_SELECTED_REASONS`** (`tenant-domain-buckets.ts:55-58`), bound as `$3` at `tenant-domain.ts:522` — **load-bearing**: it is the *first* adjudicator on the `unmapped` path, and without it the query never returns the row, `bucketOf` is never consulted, and Objective 3 is false while a unit assertion passes. That constant's docblock records the identical failure from round 4 of #812;
5. the `Extract<>` on `SignInTenantResult.reason` (`auth.ts:74`) — two of the three constraint-firing paths return through it;
6. the same `Extract<>` on `lookupRefusalReason` (`auth.ts:171`);
7. `scripts/__tests__/tenant-domain-buckets.test.ts:44-57` and `:59-76`;
8. the READMEs' cause table (`README.md:320`, `README.ja.md:319`).

**Reusing an existing reason is not an admissible response to the `auth.ts:74` type error** — it buckets the row `OTHER_TENANT` and reproduces the round-5 regression `tenant-domain-buckets.ts:9-32` records. The derivation is `rg -n 'AuthLoginFailureReason' src/ scripts/`, not a `satisfies Record<ClaimRefusalKind` grep: that spelling was introduced in Round 1 because a line grep missed one of two sites, and in Round 4 it missed two more.

**The `unmapped` chain is three adjudicators**, not two: `UNMAPPED_SELECTED_REASONS` → the `claim IS NOT NULL OR claim_refusal IS NOT NULL` predicate (`tenant-domain.ts:513`) → `bucketOf`. With `claimRefusal: null`, the row survives the middle gate **only if the emit carries `metadata.claim`** — so the emit must carry the sentinel-pointing claim domain. This has been under-counted twice; it is the thing to verify first in Phase 2.

**`bucketOf` widening**: the second branch becomes a membership test over a **reason→bucket map** — derived from `REFUSAL_BUCKET` and extended with the new arm's reason — not over `REFUSAL_BUCKET[kind] !== null`, which would pull in `tenant_mismatch` and flip the resolved-elsewhere population. Because the widening makes a many-to-one reason map load-bearing, the module gains a guard refusing when any reason resolves to two distinct buckets.

**Detection**: the three constraint names, derived from the migration files, matched by exact `Set.has`. **The constraint-name extractor does not exist** — `pgErrorCode` returns SQLSTATE only, and no constraint-name access exists anywhere in `src/`. C3 builds it beside `pgErrorCode`, following that function's precedent of enumerating the adapter's nestings against a real error rather than guessing.

**Invariant I3.1** — a sign-in refused by `users_not_system_tenant` or `tenant_members_not_system_tenant` produces exactly one `AUTH_LOGIN_FAILURE` carrying the new reason and `claim_refusal = null`.

**Control class**: `detection or audit only`. The denial is C2's.

**Forbidden patterns**: `\.code === "23514"` or any bare SQLSTATE literal outside `prisma-error.ts`; any substring match on a constraint name.

**Acceptance**

1. First-sign-in deny: one `AUTH_LOGIN_FAILURE` with the new reason, the caught constraint asserted **by value**, and the transaction rolled back. **Integration** — `auth-adapter.test.ts` mocks `@/lib/prisma` wholesale, so a unit case would assert a string the author chose and a write-order change could not red it.
2. Returning-user deny via `auth.ts:326`, asserting `tenant_members_not_system_tenant` by value — a different name, so criterion 1's proof does not generalize. **Integration.** The migration arm re-fires a proved name and may be unit.
3. A 23514 from a different constraint, and one with no extractable name, both surface as `provider_error`, the latter with a distinguishable log line.
4. The `unmapped` report end to end: a seeded row is **returned by the real query** and buckets `UNREGISTERED`, while an ordinary `tenant_mismatch` row is still returned and still buckets `OTHER_TENANT`. Asserting `bucketOf` alone is insufficient — that is what let the missing `UNMAPPED_SELECTED_REASONS` entry look satisfiable.
5. Allow arm: ordinary sign-ins produce **zero** `AUTH_LOGIN_FAILURE` rows, by count.

**Under VC2 the emit lands in `audit_outbox`, not `audit_logs`** — an assertion against `audit_logs` passes vacuously.

**Fixture lifecycle.** Sentinel-scoped audit rows are the normal steady state (5 and 5 on dev today), so **absolute-zero preconditions are wrong and would refuse every run**. The fixture: record baselines rather than requiring zero; give the emit under test a `targetId` the case generates; purge on that marker (with the sentinel tenant as a conjunct, never the sole predicate — `helpers.ts:414-421` forbids `tenant_id` alone and `refuseSentinel` makes `deleteTestData` throw); re-read the counts **in the teardown**, not only in `beforeEach`, because the database is shared between working copies; run the teardown in `try/finally`; assert both `audit_outbox` and `audit_logs` returned to baseline, naming `docs/operations/sentinel-tenant-membership.md` on either. Reuse `setup.ts`'s existing `application_name`/`pg_stat_activity` worker detection for the VC2 precondition rather than adding a second mechanism.

### C4 — the MCP consent form is validated (CF15)

`consent/route.ts` reads `code_challenge` with a presence check only and writes it to `VarChar(128)`, while `mobile/authorize/route.ts:85` validates it as `min(43).max(64).regex(BASE64URL_RE)`. There is no `22001`/`P2000` handler anywhere in `src/`.

**Contract**

- Extract `PKCE_CODE_CHALLENGE_SCHEMA` into `common.server.ts` and adopt it at **all three ingress points**: the consent POST, `mobile/authorize`, and `mcp/authorize/route.ts:127`, which validates presence and `S256` only. A **fourth reader** — `[locale]/mcp/authorize/page.tsx:29`, which casts and forwards to the consent route — is a named non-member; the consent POST is the authoritative sink. The two write destinations differ in width (`VarChar(128)` and `VarChar(64)`); the shared `max(64)` fits both and I4.1 is stated against the narrower.
- **Placement**: validate immediately after `action` is read (`:67`), gated on `action !== "deny"`. Consequences to accept: a malformed challenge now returns `invalid_request` rather than `invalid_client` (a reduction in client enumeration), and the deny arm still reaches the stale-session echo without validation — its only protection is the third ingress re-validating on the authorize GET, so that hand-off needs a case. Say whether the now-redundant presence and `S256` checks at `:141`/`:145` are removed (one adjudicator) or kept as defence in depth.
- **Scope**: cap the **raw** `requestedScopes.length` at a named constant covering the MCP set plus the standard OAuth extras (`openid`, `profile`, `offline_access`) — a **number**, not a list, so it cannot be spread into the `.includes()` allowlist one identifier away. No dedup: after the cap, `grantedScopes` is a subset of a 9-member set joining to ~140 characters against `VarChar(1024)`, so a dedup would have no criterion that could red on its removal — SC4's own withdrawal ground.
- **Pre-mint gates above the claim block.** Three exits currently sit after the claim commits: `invalid_scope` (`:280`), the passkey gate (`:288`), and the `already_claimed` tenant-mismatch 403 (`:257`). The passkey gate **relocates** — `derivePasskeyState` needs only `session` and `userTenantId` (bound at `:117`, guarded at `:118`), so its placement is the closed interval **after the deny arm at `:135` and before the claim at `:152`**; placing it above the deny arm would delete `MCP_CONSENT_DENY`, which is Round 1's F-F01 defect on a new gate. A **client-independent** scope gate — `requestedScopes.some(s => MCP_SCOPES.includes(s))` — is added at `:67` beside the cap, closing the `scope=openid`-only path that would otherwise commit a claim and exit at `:280` (a slot consumed per attempt against `MAX_MCP_CLIENTS_PER_TENANT`, by an ordinary MEMBER). The residual `invalid_scope` — all scopes valid but none in *this client's* allowlist — reads `effectiveClient`, the claim block's own output, so it **cannot** relocate: it is the invariant's one stated exception, with that reason. `:257` is likewise a consequence of the claim, not a gate.

**Invariant I4.1** — nothing reaches `createAuthorizationCode` that the shared schema would reject; `grantedScopes.join(",")` fits the narrower destination; and no request that a **client-independent** gate can refuse reaches the claim block.

**Control class**: `enforceable boundary`. **Adjudication authority**: the shared Zod schema and `MCP_SCOPES`.

**Acceptance**

1. Boundary cases on the extracted schema's own test: 42 reject, 43 accept, 64 accept, 65 reject, and a 64-character non-base64url reject — each asserting *which* clause rejected.
2. Route deny arm with a positive control: 400 with `invalid_request`, no code minted, no slot claimed, **and** an otherwise-identical valid request does mint one.
3. Deny arm preserved: `action=deny` redirects 302 and calls the audit emitter **exactly once** with `MCP_CONSENT_DENY` — arity, so a second site or a move to `enqueueAuditInTx` is caught.
4. Deny + stale step-up: bounces to the authorize GET, which refuses the malformed challenge, and writes **no** `MCP_CONSENT_DENY` row. (Scenario 4 previously claimed the opposite.)
5. Scope: the full `MCP_SCOPES` set succeeds; the full set **plus one standard OAuth scope** also succeeds; one over the cap is a 400 with no slot consumed; `scope=openid` alone is refused **before** the claim, asserted by client count; `grantedScopes.length === 0` on the residual arm still redirects `invalid_scope`, asserted to consume exactly one slot — which makes the exception falsifiable rather than a hole.
6. Pre-mint gates: a passkey-enforced user with no passkey is refused before any client is claimed, asserted by client count.
7. All three ingress points resolve to the same object, by reference identity.

### C5 — scope collections are deduped at ingress (CF16)

| # | site | field | destination |
|---|---|---|---|
| 1 | `api/tenant/mcp-clients/route.ts:40` | `allowedScopes` | `mcp_clients.allowed_scopes` `VarChar(1024)` |
| 2 | `api/tenant/mcp-clients/[id]/route.ts:32` | `allowedScopes` | same |
| 3 | `api/tenant/access-requests/route.ts:41` | `requestedScope` | **`service_account_tokens.scope` `VarChar(1024)`** |
| 4 | `api/tenant/access-requests/route.ts:48` | `requestedScope` | same |
| 5 | `lib/validations/service-account.ts:26` | `scope` | `service_account_tokens.scope` `VarChar(1024)` |
| 6 | `lib/validations/api-key.ts:9` | `scope` | `api_keys.scope` `VarChar(512)` |
| 7 | `lib/validations/share.ts:106` | `permissions` | `password_shares.permissions` `String[]` — no width |

Sites 3/4's bounding column is **not their own**: `access_requests.requested_scope` is `@db.Text`, and the width that produces CF16's failure is on `service_account_tokens.scope`, written by `approve/route.ts:180` inside the transaction that already flipped the row to `APPROVED` — so it rolls back on every retry and the request is permanently un-approvable.

**The mechanism is dedup, and only dedup — a decision, measured three times independently.** Revisions 3 and 4 specified a `.max()` at the enum's cardinality and argued about its order. Executed against this repo's `zod@4.5.4`, **dedup-then-cap and dedup-with-no-cap are indistinguishable on every fixture**: an array of `z.enum(X)` elements cannot exceed `|X|` after dedup, by pigeonhole, so the cap can never fire, and the red proof revision 4 stated for it ("remove the cap → criterion 2 reds") is false — criterion 2's fixture necessarily contains an out-of-enum value and rejects at the element schema. The cap is deleted. **I5.1's bound is a derivation, not a runtime check**: the accepted value is a subset of a closed enum whose full join is `M` characters against a `VarChar(W)` column with `M < W`, which criterion 1 asserts per member.

Member 7's destination has no width, so it takes the dedup and no bound; it is excluded from I5.1 rather than left ambiguous.

**`parseSaTokenScopes` (`service-account-token.ts:44`) also gains the dedup** — it is the approval-time adjudicator, and rows already stored keep the pathological value otherwise.

**Acceptance**

1. **Allow arm first (F4)**: per member, the complete legitimate set validates and its joined form fits its named column, widths read from `prisma/schema.prisma`. If the enum's cardinality cannot be read, fail loudly.
2. `N` distinct plus one duplicate → accepted, stored once.
3. An out-of-enum value → rejected by the element schema. (Stated as what it is, not as a cap case.)
4. **Approve path**: a maximum-size request created through the bounded ingress is approved successfully; a `PENDING` row seeded with 200 repetitions of one legal scope is approvable after the `parseSaTokenScopes` dedup — 500 before, 200 after. Ordinary integration work; VC3 does not apply and no isolated database is needed.

**Red proofs**: remove the ingress dedup → criterion 2 reds; remove `parseSaTokenScopes`' dedup → criterion 4's seeded case reds while the ingress cases stay green.

### C6 — `METADATA_MAX_BYTES` is compared in bytes (CF17)

`audit.ts:106` compares `json.length` — UTF-16 code units — against a constant named `_BYTES`, so non-ASCII metadata stores up to ~3× the intended budget into a tenant-readable `Json` column that rejects nothing. **Contract**: `Buffer.byteLength(json, "utf8")`.

**F3 interaction.** The marker replaces the metadata wholesale including `reason`, and C6 makes truncation fire on payloads that previously survived (default locale `ja`, ~3× denser). The marker **retains `reason`** under four constraints:

- **only when it is a string.** `reason` is caller-influenced at several of the 23 `metadata.reason` producers — including operator request bodies at `rotate-master-key`'s approve/revoke (`z.string().trim().max(500)`) and `tenant/breakglass`, which are the sharpest members and the right source for an adversarial fixture. A non-string whose coercion throws would be swallowed by `safeMetadata`'s catch and lose `_truncated`, `_originalSize` and `reason` at once.
- **capped in bytes at a named `TRUNCATED_REASON_MAX_BYTES`**, measured on the **serialized** marker rather than the raw value: `JSON.stringify` escapes, so a quote or control character expands up to sixfold, and a multi-byte Japanese witness has no expansion at all and therefore cannot exercise the bound. An escape-heavy witness is required alongside it.
- **cut on a character boundary**, not a byte offset. A byte cut through a multi-byte character yields U+FFFD, which *expands* the output. Note `isWellFormed()` **cannot detect this** — U+FFFD is well-formed; it returns false only for a lone surrogate, which a byte cut never produces. The assertions that can fail are that the retained reason introduces no U+FFFD the input did not contain, and that `reason.startsWith(retained)` — the property an operator's grep actually depends on.
- **without walking the original object.** The retention must not reintroduce the recursive walk #812's post-review pass removed.

**Invariant I6.1** — no `audit_logs.metadata` written by this path exceeds `METADATA_MAX_BYTES` bytes, marker included. `sanitizeMetadata` only removes keys and `reason` is not in `METADATA_BLOCKLIST`, so a pre-sanitize bound implies the post-sanitize one. **Entry point**: `truncateMetadata` and `safeMetadata` are module-private; `buildOutboxPayload(params).metadata` is the reachable handle and is the better harness anyway, since it also exercises the `?? null` collapse and the `ip`/`userAgent` slices.

**Acceptance**

1. Multi-byte metadata whose JSON is 10,240 **code units** but ~30,000 **bytes** is truncated. Red before the fix — the CF17 pin.
2. A 10,240-**byte** ASCII object is not truncated **and** a 10,241-byte one is.
3. `_originalSize` reports bytes, asserted on the multi-byte fixture and asserted **not** to equal the code-unit count.
4. The marker retains a string `reason`; a non-string one yields `{_truncated, _originalSize}` without it rather than `_unserializable`; the serialized marker fits `METADATA_MAX_BYTES` for **both** an escape-heavy and a multi-byte reason at the cap; and the retained reason is a prefix of the original with no introduced U+FFFD.
5. A small ASCII object round-trips with no marker. The `_unserializable` and safe-`toJSON`-cycle guards are exercised **under** the cap — the truncation branch returns before the `JSON.parse` round-trip, so on an over-cap payload the sanitize walk never runs.

**Twins**: `src/lib/audit/audit.test.ts` receives C6's criteria and gains the `_originalSize` byte assertion it lacks; `src/__tests__/audit.mocked.test.ts:186`'s `expect.any(Number)` is tightened to the exact byte count in the same change, so the two trees cannot disagree about the units.

**Red proofs**: revert to `json.length`; `>` → `>=`; bound + 60; drop the `reason` retention; measure the raw reason instead of the serialized marker (the escape-heavy case reds alone).

## Testing strategy

Contracts state properties. Two harness choices are fixed because measurement showed them load-bearing: C3's by-value constraint assertions are **integration** (the unit harness mocks `@/lib/prisma` wholesale), and C2's constraint-drop red proofs need an **isolated** database while its deny arms run on dev. Everything else is Phase 2's to choose — and Phase 2 runs each mechanism before writing the case that pins it, which is what four rounds of this plan establish as the cheaper order.

Red-prove one mutation per clause, by execution, on a throwaway copy. Read exit codes from a redirected file, never through a pipe.

## Considerations & constraints

### Scope contract

- **SC1** — port-suffixed IP forms rejected, not stripped; such a value already fails every allow arm.
- **SC2** — `scim/v2/Users/route.ts:163` and `directory-sync/engine.ts:447` are `tenant_members` writers but not claim-driven; after C2 a sentinel-pointing `tenant_id` at either raises an unhandled 23514. *Anti-Deferral: worst case a bare 500 from SCIM and a failed sync with no log entry naming the cause; likelihood low (requires an out-of-band write); cost a shared 23514-to-envelope mapping plus allow arms at two provisioning paths, which belong with those features.*
- **SC3** — no backfill. **Measured, dev, 2026-09-03**, with the honest disposition: the query's regex bounds the invalid population **from below**, not above (four of C1's own deny inputs are spelled within its character set), and covers 4 of 6 IP and 1 of 5 user-agent columns. Result: **no shape-invalid rows** — weaker than "nothing to migrate". *Anti-Deferral: worst case some stored `ip` values stay unparseable; they are display/forensics fields no authorization path compares; likelihood moderate; cost a measurement task, not a code change, and F2 holds either way.*
- **SC4 — CF14 carried forward, third time.** All eleven writers of the five `VarChar(512)` user-agent columns **already slice at the correct constant**, so the proposed boundary helper changed no behaviour and no criterion required its adoption. *Anti-Deferral: worst case a NEW write into one of the eleven bounded columns joins without a slice; likelihood moderate; cost — three mechanisms have failed: the write-shape AST gate (#812: three rounds, seventeen findings, six of seven clauses provably dead), the header-read gate (one read feeds four columns; 20 reads against 5 columns), and the boundary helper (a no-op). **New on record: the exposure is entirely future-tense**, and a fourth attempt should start from what detects a NEW write site, because bounding the existing ones is done.* Residuals: `mobile-token.ts:371` and `validate-token-dpop.ts:90` spell the 512 budget as a bare literal.
- **SC5** — `extension_tokens.last_used_user_agent` (`@db.Text`) is not a bounded column.
- **SC6** — residual `access_requests` rows: **measured, `oversized_requested_scope=0`**. The `parseSaTokenScopes` dedup is a guard rather than a repair on this deployment; C5 includes it regardless.
- **SC7 — a reachable GUC fold breaking `logAuditAsync`'s durability contract.** `enqueueAudit`/`enqueueAuditBulk` open a raw `prisma.$transaction` on the **proxied** client; under an active RLS context the Proxy folds it (`prisma.ts:178-179`) and the outbox row is written inside the caller's transaction. **The unguarded component is those two functions' raw `$transaction`**, which has no nesting guard in either direction. Reachable at one site: `emergency-access/[id]/vault/route.ts:52` → `autoPromoteIfElapsed` → `vault-auto-promote.ts:135`. Consequence bounded (only `app.bypass_purpose` is forged) but the `EMERGENCY_ACCESS_ACTIVATE` row becomes atomic with the promotion, against CLAUDE.md's stated contract. *Anti-Deferral: out of scope (different subsystem), tracked as a follow-up issue with SC9. Worst case a lost activation audit record on a rolled-back promotion; likelihood low; cost — routing them through `withBypassRls` converts the silent fold into a throw for every emit inside a tenant transaction, so the fix is a redesign of the emit path and wants allow arms across every emit in the deployment. R9; not a member of any CF11–CF17 class. User's decision.* No gate tracks it.
- **SC8** — C3 covers an out-of-band state only.
- **SC9 — the RLS nesting guard rejects two of four combinations** while its own comment claims all four. Live sites: one tenant-in-tenant (`api/teams/[teamId]/route.ts:157`, same `tenantId`, no leak) and two bypass-in-bypass, all benign. *Anti-Deferral: out of scope, tracked with SC7. Worst case cross-tenant read and write for the remainder of a transaction; likelihood presently zero, no differing-tenant nesting exists; cost — reject all four, which requires flattening three existing nesting sites, each with its own allow arm. User's decision.*

### Risks

- **R-a — C1's parser and C4's cap are denial surfaces.** No verdict changes once `isIpInCidr` normalizes, but a legitimate address the parser rejects moves a user into the shared `unknown-ip` bucket, and C1 also reduces the rate of the adjacent `rate-limit.fail_closed` telemetry — so that signal is a weaker operator canary than earlier revisions assumed. Both contracts' allow arms enumerate the accepted forms.
- **R-b — C2's migration on a shared database.** Pre-flight is blocking; rollout and rollback are stated.
- **R-c — C3's pre-production coverage is unit and integration only** (VC5), which is why criteria 1, 2 and 4 are integration.
- **R-d — this plan is finished.** Four rounds; 43/42/34/32 findings. Round 4's Criticals were in mechanisms revision 4 introduced and three were settled by one execution each. Revision 5 keeps decisions and drops specifications; further specification without measurement is what the last two rounds were spent undoing.

## User operation scenarios

1. **Misconfigured proxy**: every request already yields `null`. Unchanged.
2. **Correct proxy, tenant with a CIDR allowlist**: legitimate addresses still allowed, including bracketed IPv6 now that `isIpInCidr` normalizes; a spoofed garbage XFF is denied as before, stores NULL, and consumes the shared unknown-IP budget. A team with explicit CIDRs still gets its `ACCESS_DENIED` row.
3. **An out-of-band sentinel-pointing `tenant_claims` row** (no operator command can create one): sign-in is refused by `users_not_system_tenant`, recorded under `claim_system_tenant`'s own reason with the claim domain in `metadata.claim`, and `tenant-domain unmapped` lists it under `UNREGISTERED`, pointing at `add`.
4. **Deny on an MCP consent screen**: redirects with `error=access_denied` and writes its audit record. With a stale step-up session it bounces to the authorize GET first, and the record appears only after the re-run.
5. **A passkey-enforced user with no passkey reaching MCP consent**: refused before any client is claimed.
6. **A client requesting only `openid`**: refused at ingress, before any client is claimed.
7. **Service account requesting every scope it is entitled to**: validates and is approvable; a duplicated scope is stored once; a pre-branch request with 200 duplicates becomes approvable.
8. **Audit event whose metadata is Japanese prose near the budget**: truncated at 10,240 bytes with `_originalSize` in bytes and a character-boundary-cut `reason` retained.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | IP boundary validates; `isIpInCidr` normalizes; five value sources; `mcp/token` fail-open closed; team-path emit delegated (CF11) | **locked** |
| C2 | Case-folded sink refusal (named throw + `getLogger` event) + CHECK on `teams`/`users` (CF12) | **locked** |
| C3 | Sentinel claim refuses sign-in under its own reason across an eight-site registration, reportable by `unmapped` (CF13) | **locked** |
| C4 | PKCE validated at three ingress points; client-independent gates above the claim block (CF15) | **locked** |
| C5 | Scope collections deduped at seven ingress sites and at approval time; no cap (CF16) | **locked** |
| C6 | `METADATA_MAX_BYTES` in bytes; character-boundary-cut `reason` under a named byte cap (CF17) | **locked** |

CF14 has no contract — SC4. SC7 and SC9 are a follow-up issue.

## Carried-Forward Plan Findings

Phase 1 exited by decision rather than by saturation; these remain open and Phase 2 Step 2-1 reads them.

- **CFP1 — C3's `metadata.claim` requirement is verified last, not first.** The `unmapped` chain is three adjudicators and has been under-counted twice (Rounds 3 and 4). *Anti-Deferral: acceptable risk. Worst case — the row is filtered before `bucketOf` and Objective 3 is false while a unit assertion passes. Likelihood — moderate; it is the same shape that already recurred twice. Cost — one integration assertion. What would settle it: run the real `$3`-bound query against a seeded row **before** writing any other C3 test.*
- **CFP2 — C4's `:141`/`:145` redundancy is undecided.** Removing them gives one adjudicator; keeping them gives two spellings of one rule (R48). *Anti-Deferral: acceptable risk. Worst case — the two drift. Likelihood — low. Cost — one line either way. What would settle it: pick in Phase 2 and record which.*
- **CFP3 — `/api/mcp/token`'s allow arm names a capacity property no harness measures.** *Anti-Deferral: acceptable risk. Worst case — C1 converts a fail-open into a fleet-wide shared bucket and no test can red on the limit being too low. Likelihood — moderate. Cost — assert the bucket identity and drive a real limiter to `limit`/`limit+1`, with the number read from the limiter's configuration. What would settle it: that pair, plus recording the configured number as a judgement rather than a test.*
- **CFP4 — C1's `isIpInCidr` normalization is a change to a shipped policy primitive.** It is the right fix and it widens what the policy accepts on the raw domain. *Anti-Deferral: acceptable risk. Worst case — a tenant whose allowlist relied on the raw-form rejection sees a request allowed. Likelihood — very low; the rejected forms are bracketed and whitespace-padded spellings of addresses the tenant already listed. Cost — the parity criterion (C1 acceptance 4). What would settle it: that criterion executed over both a v4 and a v6 CIDR.*
