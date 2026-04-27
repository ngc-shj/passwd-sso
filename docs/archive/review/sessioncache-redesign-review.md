# Plan Review: sessioncache-redesign

Date: 2026-04-27
Review rounds: 1, 2 (consolidated below)

## Round 1: Initial review

(Findings F-1..F-8, S-1..S-11, T-1..T-11-A — all dispositions recorded in plan §"Round 1 expert review responses")

## Round 2: Incremental re-review

The Round 2 sweep verified Round 1 fixes and surfaced new findings introduced by the fixes themselves OR previously-overlooked issues. Plan dispositions in §"Round 2 expert review responses".

**Verification summary**:
- Functionality: F-1 Partial (tombstone TTL bound — see F-9), F-2..F-8 Resolved.
- Security: S-1..S-11 Resolved (HKDF V1 pinning verified by Opus; Round 1 escalation closed).
- Testing: T-1..T-4, T-6..T-8, T-10, T-11-A Resolved; T-5 description bug → T-12; T-9 assertion semantics → T-13.

**New Round 2 Major findings** (all addressed in plan):
- F-9: tombstone TTL vs slow auth-fetch — resolved by `TOMBSTONE_TTL_MS = 5_000` + documenting auth-fetch p99 budget.
- F-10: `hkdfSync` returns `ArrayBuffer` not `Buffer` — resolved by `Buffer.from(...)` wrap.
- F-11: tenant policy route is PATCH not PUT — resolved by global rename.
- S-12: schema-fail eviction defeats tombstone guard — resolved by tombstone-shape-first read pipeline ordering.
- S-13: tenant policy bulk invalidation timing for large tenants — resolved by mandating synchronous + Redis-pipelined invalidation before 200 response.
- S-14: tombstone keyspace amplification — resolved by 5-s TTL + `volatile-lru` operational guidance.
- S-15: removing `valid:false` cache opens DoS amplifier on `/api/auth/session` — resolved by 5-s asymmetric negative cache.
- T-12: subkey identity test mocks wrong function — resolved by mocking `getMasterKeyByVersion` with literal-arg + memoization assertions.
- T-14: Scenario A asymmetric tombstone coverage — resolved by typed-literal `toStrictEqual<TombstoneShape>`.
- T-15: Scenario I implementation contract gap — resolved by 6-step explicit recipe + `Promise.race` timeout.

**New Round 2 Minor findings** (all addressed):
- F-12 (#9 diff scope clarification), F-13 (architecture diagram updated), F-14 (cascade fix from F-11).
- S-16 (HKDF salt/info NIST idiom swap), S-17 (heap-dump exposure documented), S-18 (sustained Redis-WRITE poison loop documented).
- T-13 (throttled logger test specifics + TypeScript assertion), T-16 (per-site test helper extraction), T-17 (typed-literal fixture mandate), T-18 (acceptance criterion verbose-reporter mandate).

## Changes from Previous Round

Round 2 fixes recorded in §"Round 2 expert review responses" of the plan; key code-level changes:
- Tombstone TTL constant introduced (`TOMBSTONE_TTL_MS = 5_000`) and negative-cache TTL constant (`NEGATIVE_CACHE_TTL_MS = 5_000`).
- Read pipeline ordering: tombstone-shape pre-check → NegativeCache match → SessionInfo schema → poison-evict.
- Tenant policy site (#9) wired to PATCH with synchronous Redis-pipelined invalidation.
- HKDF: salt empty, info as context (RFC 5869 idiom); `Buffer.from` wraps `hkdfSync` output.
- Test descriptions corrected for subkey identity invariant; throttled logger test specifics; typed-literal fixtures mandated.

## Round 3: Final sanity check (single triangulated reviewer)

All Round 2 fixes verified Resolved; cross-checks confirmed:
- Empirically verified: `crypto.hkdfSync("sha256", ikm, "", "context", 32)` accepts empty salt (RFC 5869 §2.2 zero-fill) and produces deterministic output.
- Empirically verified: `Buffer.from(arrayBuffer)` wraps `hkdfSync` output as a 32-byte Buffer (zero-copy).
- Cross-checked: tombstone-shape pre-check structurally precludes ambiguity with NegativeCache shape (no overlapping keys).
- Re-auth-after-tombstone race: cannot occur because Auth.js generates fresh tokens on every new session (verified in `src/auth.ts`); new token → different HMAC → different cache key → no NX collision.
- R3 perspective inversion grep found no missed deletion sites — all 9 inventoried.

**Verdict: PASS. No blocking findings. Plan ready for Phase 2.**

Three non-blocking polish items applied: line-number drift fix (C3 row #6: 399 → 401), brief "Rolling-idle session.update interaction" note added to Considerations (clarifies cache-PX vs updated-expires race is correctness-preserving).

## Functionality Findings

```
[F-1] Major: Stale-cache write race after revocation (TOCTOU populate-after-invalidate)
- File / Plan section: "Considerations & constraints" → Scenario 6; C3 "Sequencing"
- Evidence: T0: Request B getSessionInfo → cache miss → fetch /api/auth/session in flight; T1: /api/auth/session resolves valid; T2: DELETE /api/sessions/[id] commits prisma.session.deleteMany; T3: handler invalidateCachedSession (cache empty, no-op); T4: Request B's setCachedSession writes valid entry (TTL 30s); T5: every worker reads valid: true for 30s.
- Problem: Today's cache is per-worker; under shared Redis the repopulated entry is global. F-Req-1 (≤1s propagation) violated for any straddling request. The plan dismisses as "same as today's DB pattern" — incorrect.
- Impact: Defeats core objective. Bound becomes 30s for the straddling cohort, visible to every worker.
- Fix: (a) generation-stamped writes (per-user counter, bound into cache value, validated on read); (b) tombstone on revoke (`{revoked:true}` PX=30s) + setCachedSession uses SET NX so populate cannot overwrite tombstone; (c) acknowledge gap explicitly with documented Δ. Plan must address, not dismiss.

[F-2] Major: Plan inventory site #5 (concurrent-session-limit eviction) misses cross-tx type propagation
- File / Plan section: C3 row #5 (auth-adapter.ts:277); "Sequencing"
- Evidence: At src/lib/auth/session/auth-adapter.ts:277 tx.session.deleteMany executes inside prisma.$transaction (Serializable). The escaping list `evicted` is shaped {id, ipAddress, userAgent}. Adding sessionToken means widening the type at line 326-330 AND the destructuring at line 281/326.
- Problem: Step 8 says "use the token already at hand" — at site 5 it is NOT at hand outside the tx unless type-widening ripples through evictionInfo and the consumer.
- Impact: Naive plan-following silently drops sessionToken at the tx boundary → no-op invalidation for site 5.
- Fix: Add explicit step: extend evictionInfo.evicted element type to include sessionToken: string; widen the cast at line 326-330; pass tokens to invalidateCachedSessions after the audit/notification block.

[F-3] Major: Master key choice violates domain separation; the named key does not exist (consolidated with S-2 / S-11 — see Opus escalation)
- File / Plan section: S-Req-3; Implementation step 5; "Why HMAC and not plain SHA-256"
- Evidence: src/lib/key-provider/types.ts:8 KeyName enum is "share-master" | "verifier-pepper" | "directory-sync" | "webauthn-prf" — no general-purpose MASTER_KEY. crypto-server.ts only exports SHARE_MASTER_KEY family (lines 8, 50). Plan step 5 calls getMasterKeyByVersion(getCurrentMasterKeyVersion()) — that returns share-master.
- Problem: (a) ambiguous reference — "MASTER_KEY" doesn't exist; implementation will pick share-master ad-hoc. (b) reusing share-master entangles share-link domain with session-cache domain. (c) cross-version entries are unstable — V1 vs V2 produce different hashes; plan stores no keyVersion in cache value.
- Impact: Implementation ambiguity; share-master rotation becomes a session-cache stampede event; plan offers no mitigation.
- Fix: Resolved jointly with S-2 / S-11. Adopt Opus consolidated approach: derive a non-rotating subkey via HKDF(getMasterKeyByVersion(1), salt="session-cache-hmac-v1") cached at module load. Pin to V1; document rotation requires Redis flush.

[F-A-4] Major: Plan ignores user/account deletion cascade — overlaps with Security
- File / Plan section: C3 inventory completeness
- Evidence: prisma/schema.prisma:48 `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`. src/lib/auth/session/auth-adapter.ts:382 deleteUser → prisma.user.delete cascades to Session rows. Plan's C3 (rows 1-7) does NOT include this site.
- Problem: Auth.js's deleteUser path cascades-delete sessions WITHOUT invoking the per-row deleteSession adapter. Cache entries become orphaned for up to 30s.
- Impact: Deleted user's sessions remain accepted on cache hit. Low frequency but real.
- Fix: Add row #8 to C3: auth-adapter.ts:382 deleteUser → SELECT sessionToken WHERE userId BEFORE prisma.user.delete; invalidate after commit. Or document explicitly as out-of-scope residual.

[F-5] Minor: Negative-cache pin globalized
- File / Plan section: Implementation step 6 (ttlMs derivation)
- Evidence: For valid:false response data.expires is absent → fall back to 30s, so an INVALID-session result is cached for 30s (current behavior). Today this pins per-worker; under Redis the pin is global.
- Problem: Transient /api/auth/session blip on one worker writes valid:false → every worker pinned for 30s.
- Impact: UX regression on transient auth-route faults.
- Fix: Skip caching of valid:false results entirely — see also S-8.

[F-6] Minor: Step 7 vs Testing strategy phrasing drift
- File / Plan section: Implementation step 7 vs "Existing test migration"
- Evidence: Step 7 says "Move equivalent behavioral assertions" but the Unit-test list contains no equivalent for the FIFO/expired-then-oldest two-pass eviction (which is gone).
- Problem: Reviewer may search for nonexistent "eviction equivalent" in session-cache.test.ts.
- Impact: Minor clarity issue.
- Fix: Reword step 7: "Delete in-process eviction tests entirely. Replace 557-633 with a single sanity test that getSessionInfo no longer mutates an in-process Map."

[F-7] Minor: ttlMs floor [1s] contradicts S-Req-5 ("don't outlive DB row")
- File / Plan section: C2 step 6.4; S-Req-5
- Evidence: 1s upper-bound clamp means a session at 1ms past expiry has cache alive ~1s.
- Problem: Plan's two requirements (S-Req-5 strict + clamp-to-1s minimum) are contradictory; plan defers resolution.
- Impact: 1s window where session valid at fetch but expired at next request still serves valid:true.
- Fix: Skip cache when expires-now < 1000ms. Explicit decision, not deferral.

[F-8] Minor: getRedis() null in dev → no caching at all
- File / Plan section: NF-Req-1; Failure semantics
- Evidence: src/lib/redis.ts:7-9 returns null when REDIS_URL unset; validateRedisConfig only requires it in production.
- Problem: Dev without REDIS_URL goes from "cache hit" today (in-memory Map) to "DB lookup every request". NF-Req-1 claims unchanged miss-path latency — true, but every request becomes a miss.
- Impact: Dev experience degrades.
- Fix: Add note to NF-Req-1: "When REDIS_URL unset, every getSessionInfo round-trips to /api/auth/session — acceptable for dev." OR keep a tiny in-process L1 (1s TTL, 100-entry cap) as no-Redis fallback.
```

## Security Findings

```
[S-1] Major: JSON.parse of Redis cache value with no schema validation → cache poisoning → privilege escalation
- File / Plan section: C1 Implementation notes; Architecture step 2
- Evidence: Plan returns JSON.parse(raw) as SessionInfo (typed cast, no runtime guard). Cache value contains userId, tenantId, valid, requirePasskey — all auth gate fields.
- Problem: An attacker with Redis WRITE (leaked ACL, sidecar compromise, misconfigured shared Redis) can overwrite a legitimate user's cache entry by reading the existing key from Redis (HMAC outputs are visible) and SETting a poisoned value with valid:true, userId=admin-uuid, requirePasskey:false. Next proxy hit on victim's real session reads poisoned value → elevated privileges.
- Impact: Auth bypass / privilege escalation / cross-tenant access on any session whose key is in Redis.
- Fix: Validate parsed value with Zod schema (SessionInfoSchema.safeParse) in getCachedSession. On failure return null AND redis.del(key) to evict poisoned entry. Add schema to session-cache.ts; reuse in tests for RT1 guard. Document in S-Req-1 that HMAC-keying defends key forgery, not value tampering.
- escalate: false

[S-2] Major (VERIFIED by Opus): Master key rotation silently invalidates ALL cache entries → revocation invariant temporarily violated
- File / Plan section: "Known unknowns" item 3; S-Req-3
- Evidence: getCurrentMasterKeyVersion() (crypto-server.ts:37-45) reads process.env on every call. After rolling restart with V1→V2: per-worker observation, not atomic. scripts/rotate-master-key.sh does NOT flush Redis or notify workers. BaseCloudKeyProvider.getKeySync (base-cloud-provider.ts:64-83) requires warmed cache — amplifies S-5.
- Problem: V1 entries are ACTIVE FALSE-POSITIVES for V1 workers throughout rollout, not just orphans. A session revoked while some workers still on V1 keeps being accepted on V1 workers (their V1-keyed entry was never deleted because the revoke handler ran on a V2 worker and DELed the V2 key).
- Impact: Up to 30s revocation gap during master-key-rotation × restart-rollout window — exactly the failure mode the plan was designed to fix.
- Fix: Pin to V1 forever via HKDF subkey. See "Opus escalation: consolidated S-1/S-2/S-5/S-11 fix" below.
- escalate: true (re-run with Opus completed; see below)

[S-3] Major: Cached SessionInfo can outlive a tenant policy change (passkey enforcement)
- File / Plan section: S-Req-5
- Evidence: SessionInfo cached fields include requirePasskey, requirePasskeyEnabledAt, passkeyGracePeriodDays — these are TENANT-policy values, not session values. requirePasskey flips when admin updates /api/tenant/policy. Plan's C3 enumerates 7 session-deletion sites but no tenant-policy-change sites.
- Problem: Tenant admin enables requirePasskey to enforce passkey for non-passkey users. After plan: every worker reads cached requirePasskey:false for ≤30s. Users without passkey access data the policy was meant to gate.
- Impact: Tenant policy enforcement gap (≤30s) for all sessions of a tenant whose policy just flipped. For a password manager this is material.
- Fix: Either (a) add invalidation site for PUT /api/tenant/policy: SELECT sessionToken WHERE tenantId then bulk invalidateCachedSessions; OR (b) drop requirePasskey* and passkeyGracePeriodDays from cached value, re-resolve per-request (cheap; already in user row loaded by auth session lookup). Latter is simpler — recommended.
- escalate: false

[S-4] Minor: HMAC vs plain SHA-256 (hashToken) inconsistency with codebase
- File / Plan section: S-Req-1, S-Req-3, "Why HMAC"
- Evidence: src/lib/crypto/crypto-server.ts:165 exports hashToken(token) = SHA256(token).hex used by SCIM, SA, API key, extension-token storage.
- Problem: Two non-aligned primitives for the same conceptual purpose (deriving non-reversible storage key from high-entropy token). Need explicit threat-model justification or codebase consistency.
- Impact: Cognitive load + drift; no direct vulnerability (HMAC is stronger).
- Fix: Keep HMAC (preserves Redis-poisoning defense); rewrite "Why HMAC" rationale: drop "shared Redis across envs" claim (not how this product is deployed); keep ONLY "Redis-writer-without-master-key cannot pre-compute keys for arbitrary unknown tokens" as the rationale.
- escalate: false

[S-5] Minor: Master key resolved per-call → throws if KeyProvider not warmed → fail-CLOSED on revoke (subsumed by S-11 from Opus)
- File / Plan section: Implementation step 5
- Evidence: BaseCloudKeyProvider.getKeySync throws when key not yet warmed.
- Problem: setCachedSession + invalidateCachedSession also call hashSessionToken; if invalidate throws synchronously and wrapper doesn't catch, revoke endpoint returns 500.
- Impact: Revoke flakiness during cold start.
- Fix: Subsumed by Opus consolidated fix (S-11) — resolve subkey once at module load.
- escalate: false

[S-6] Minor: Sequencing note for sites 5/6/7 — invalidation must run after DB resolves
- File / Plan section: C3 inventory
- Evidence: auth-adapter.ts:471-487 idle/absolute timeout deletion in updateSession.
- Problem: Implementer firing invalidate in parallel with delete reopens TOCTOU.
- Impact: Implementation regression risk.
- Fix: Add to C3: "All invalidation calls run in await sequence AFTER the corresponding withBypassRls / $transaction resolves successfully — NEVER in parallel via Promise.all. The DB write must be observable before cache eviction."
- escalate: false

[S-7] Minor: "Strictly an improvement" framing for Redis-down case is incorrect
- File / Plan section: Failure semantics summary
- Evidence: Today's revocation works regardless of Redis state. After plan, revocation correctness depends on Redis. Outage + revocation = up to 30s window.
- Problem: Worst-case framing wrong; an attacker who can DoS Redis can extend revocation by 30s per cycle.
- Impact: Operational coupling; revocation SLO depends on Redis SLO.
- Fix: Remove "strictly an improvement" wording. Add: "Cache lifetime now couples revocation latency to Redis availability. During outage, revocation reverts to today's TTL-expiry behavior (≤30s). Operational dependency to monitor."
- escalate: false

[S-8] Minor: valid:false caching policy unspecified — DoS amplification + UX regression
- File / Plan section: Implementation step 6
- Evidence: Today's auth-gate.ts caches valid:false (when /api/auth/session returns !user). Plan does not specify.
- Problem: Combined with S-1 — an attacker poisons valid:false for victim's HMAC key, denying auth until TTL.
- Impact: DoS amplification + UX regression.
- Fix: Specify in C2 step 3: do NOT cache valid:false in Redis. Only cache positive (valid:true && userId) entries. Add unit test asserting setCachedSession({valid:false}) is a no-op.
- escalate: false

[S-9] Minor: Cross-tenant safety relies on token-uniqueness invariant — undocumented
- File / Plan section: "Why HMAC"; Considerations
- Evidence: Auth.js generates session tokens via crypto.randomBytes(32) — globally unique.
- Problem: Documentation gap — if token-generation ever changes (e.g., per-tenant scoping), cache becomes cross-tenant data path.
- Impact: None today; protective documentation for future.
- Fix: Add sentence: "Cache safety relies on Auth.js's invariant that session tokens are globally unique (256-bit random). If token-generation changes, this cache must be re-keyed to include tenantId in HMAC input."
- escalate: false

[S-10] Minor: Throttled-error logger over-redacts → operational blindness
- File / Plan section: C1 "Throttled error logger"
- Evidence: rate-limit.ts:14 precedent: getLogger().error("rate-limit.redis.fallback") with no err detail.
- Problem: Real Redis error codes (ECONNREFUSED, NOAUTH, MOVED, OOM) carry no secrets but are diagnostically valuable.
- Impact: Slows incident response.
- Fix: Log error code via allowlist: getLogger().error("session-cache.redis.fallback", { code: err?.code ?? "unknown" }). Same upgrade in rate-limit.ts.
- escalate: false

[S-11] (new from Opus escalation) Major: KeyProvider warmup race fails CLOSED on every authenticated request
- File / Plan section: Implementation step 5 (extends S-5)
- Evidence: BaseCloudKeyProvider.getKeySync throws when key not yet warmed. Cloud providers (AWS/GCP/Azure) require async warm-up before sync use.
- Problem: On a freshly started worker before validateKeys() resolves, getKeySync throws → hashSessionToken throws → getSessionInfo throws → 500 on EVERY authenticated request, not just revoke.
- Impact: Cold-start outage of all authenticated routes on every worker until KeyProvider is warm.
- Fix: Resolve HMAC subkey ONCE at module load (memoized lazy-init on first call). Subsumed by Opus consolidated fix.
- escalate: false
```

### Opus escalation: consolidated S-1 / S-2 / S-5 / S-11 fix

The Opus security review verified S-2 and surfaced S-11. Recommended consolidated path:

1. **Plan §S-Req-3 + §C1 step 5 + §Considerations point 3**: Replace per-call `getCurrentMasterKeyVersion()` + `getMasterKeyByVersion()` with a non-rotating subkey:
   ```
   sessionCacheHmacKey = HKDF-SHA256(getMasterKeyByVersion(1), salt="session-cache-hmac-v1", info="", length=32)
   ```
   Pin to V1. Rotating V1 itself becomes an out-of-band operation requiring Redis flush — document.
2. **Plan §C1**: resolve subkey ONCE at module load (memoized lazy-init). Eliminates S-2 + S-5 + S-11.
3. **Plan §"Why HMAC"**: keep HMAC (Redis-poisoning + cross-env defenses survive). Plain SHA-256 (S-4 alternative) would also evaporate S-2 but loses Redis-poisoning defense — do NOT regress to plain hash.
4. **S-1 cross-cutting**: Zod validation does NOT mitigate S-2 or S-3 (orphan entries / stale tenant policies are schema-clean, semantically wrong). S-1 fix and S-2 fix are independent — both required.
5. **Plan §Out of scope**: add note "Master key rotation does not flush session cache; pinning to V1 + HKDF-derived subkey makes rotation cache-safe."

## Testing Findings

```
[T-1] Major: Integration test path/suffix does not match runner config
- File / Plan section: Implementation step 9; Testing strategy → Integration tests
- Evidence: vitest.integration.config.ts: include: ["src/**/*.integration.test.ts"]. All 33 existing integration tests live in src/__tests__/db-integration/ with .integration.test.ts suffix. Plan path is wrong directory + wrong suffix.
- Problem: npm run test:integration will not pick up the file. Acceptance criterion #2 (`npm run test:integration -- session-revocation-cache`) matches nothing.
- Impact: The single test that proves the bug fix silently NOT runs in CI.
- Fix: Rename to src/__tests__/db-integration/session-revocation-cache.integration.test.ts. Update step 9 + acceptance criteria.

[T-2] Critical: "Multi-worker simulation" via two getSessionInfo calls in one process is a false-positive test
- File / Plan section: Implementation step 9; Testing strategy → Scenario B
- Evidence: src/lib/redis.ts:3-5 — global singleton client. Two callers in the same process share the client and module instance. They CANNOT diverge.
- Problem: Does not exercise multi-worker semantics. Demonstrates only "same Redis returns same value to two callers" — true by definition. Headline bug class (30s revocation gap per worker) has zero test coverage.
- Impact: A regression where in-process state shadows Redis would still pass.
- Fix: (a) rename Scenario B to "shared-Redis read-after-invalidate" — honest framing; OR (b) child_process.fork() with two workers + one Redis container; OR (c) vi.resetModules() between two import calls to instantiate two isolated module graphs sharing one Redis. State explicitly in plan.

[T-3] Major: In-process eviction tests deleted but behavioral intent (memory bound) not preserved
- File / Plan section: Implementation step 7
- Evidence: src/__tests__/proxy.test.ts:557-633 covers (1) expired-first eviction, (2) FIFO oldest, (3) "does NOT clear all". Plan replaces only with "redis.set with PX TTL is called" — covers (1)'s TTL surface only, not cap-eviction.
- Problem: No test proves Redis-side eviction is engaged. Misconfigured Redis (no maxmemory-policy) regresses NF-Req-2 to unbounded growth.
- Impact: Memory blowup on Redis if ops misconfigure.
- Fix: Add test asserting redis.set ALWAYS passes a PX TTL (per-key TTL guarantees expiry independent of server eviction policy). AND keep one assertion that SESSION_CACHE_TTL_MS is the upper bound passed. OR document explicitly in Considerations as "memory bound delegated to Redis ops".

[T-4] Major: "Mock-reality divergence" guard does not actually test divergence
- File / Plan section: Testing strategy → "Mock-reality divergence guard (RT1)"
- Evidence: toStrictEqual on mocked round-trip proves only "what we put in, we get out" — both sides are the test's own data.
- Problem: Classic RT1 failure mode (unit test passes against hand-rolled fake; production breaks because real Redis returns string not parsed object) is exactly what this guard does NOT test.
- Impact: A bug like "forgot to JSON.parse the result of redis.get()" passes unit, fails only in prod.
- Fix: (1) Round-trip assertion: toStrictEqual<SessionInfo>(fixture) with typed fixture, AND assert redis.set called with JSON.stringify(fixture) exactly (string-level); (2) integration test must include a real-Redis round-trip pulling value via redis.get() directly (not via getCachedSession), assert JSON.parse equality against fresh SessionInfo literal.

[T-5] Major: No test for master-key-rotation path
- File / Plan section: Implementation step 5
- Evidence: hashSessionToken under v1 vs v2 produces different hashes for same token; existing entries become unreachable.
- Problem: Silent. invalidateCachedSession after rotation does NOT delete v1 entries (it computes v2 key for DEL). No test catches this.
- Impact: After master-key rotation, revocation correctness regresses to 30s gap.
- Fix: Add unit test in session-cache.test.ts: with mocked getCurrentMasterKeyVersion returning v1 then v2, verify (a) getCachedSession after rotation returns null for v1-written entry; (b) invalidateCachedSession after rotation does NOT delete the v1 entry. Then resolve via Opus consolidated fix (HKDF subkey from V1 — no rotation dependence). Test obsoleted by fix; replace with test that subkey is identical regardless of getCurrentMasterKeyVersion.

[T-6] Major: No test asserts revocation invalidation runs AFTER DB delete commits
- File / Plan section: C3 "Sequencing"; Implementation step 8
- Evidence: Plan states ordering invariant; no test exercises it.
- Problem: A regression in any of the 7 sites that swaps order (cache-DEL-then-DB or cache-DEL-inside-tx) re-opens the bug. Site 3 (passkey verify, inside $transaction) is highest-risk.
- Impact: Plan's stated correctness invariant has zero test.
- Fix: For each of the 7 sites, add a unit test that mocks the DB delete to throw/rollback, asserts invalidateCachedSessions was NOT called.

[T-7] Major: Existing route tests for the 7 deletion sites not slated for update
- File / Plan section: Implementation step 8
- Evidence: Existing tests at sessions/[id]/route.test.ts, sessions/route.test.ts, passkey/verify/route.test.ts, scim/v2/Users/[id]/route.test.ts, teams/[teamId]/members/[memberId]/route.test.ts, auth-adapter.test.ts, user-session-invalidation.test.ts.
- Problem: Plan says to add invalidation calls but does NOT say to update tests to assert invalidateCachedSessions is called. SCIM/team paths use vi.mock("@/lib/auth/session/user-session-invalidation", ...) — mocks the function whose new behavior is the bug fix.
- Impact: Future refactor dropping the new invalidation call passes all unit tests. R3 propagation guarantee has zero unit-test coverage.
- Fix: For each of the 7 sites, add assertion to the existing route/adapter test: invalidateCachedSessions was called with expected token list AFTER the DB delete mock resolved. Update step 8.

[T-8] Minor: SESSION_CACHE_TTL_MS test uses fake timers no-op against Redis
- File / Plan section: Implementation step 7 ("Keep TTL-expiry test")
- Evidence: vi.advanceTimersByTime does not affect Redis's PX TTL (Redis runs in real time).
- Problem: Test name "re-fetches session after SESSION_CACHE_TTL_MS expires" no longer matches behavior.
- Impact: False-promise test name.
- Fix: Rename to "re-fetches session on Redis cache miss"; remove fake-timer scaffolding. Move actual TTL math (clamp logic) verification into session-cache.test.ts asserting redis.set(..., "PX", expectedTtl) against frozen Date.now().

[T-9] Minor: Throttled-error-logger refactor adds 2 callers but ships zero new unit tests
- File / Plan section: Implementation step 2
- Evidence: Plan says "Verify rate-limit unit tests still pass" but does not require unit tests for createThrottledErrorLogger itself.
- Problem: Throttling invariant becomes shared infrastructure used by two security-sensitive paths; deserves its own tests.
- Impact: Regression in throttle leaks ≥1 log per request; potential token-fragment leakage if message ever changes.
- Fix: Add src/lib/logger/throttled.test.ts: (1) calling repeatedly fires once, (2) after vi.advanceTimersByTime(intervalMs+1) fires again, (3) message string is fixed.

[T-10] Minor: Hardcoded test values vs centralized constants
- File / Plan section: Testing strategy → "Existing test migration"
- Evidence: Plan mentions "within 1 s" in integration test loosely. Other places use 30_000 for unrelated TTLs.
- Problem (RT3): Future tuning of SESSION_CACHE_TTL_MS orphans test expected behavior with no compile error.
- Impact: Low.
- Fix: Mandate import of SESSION_CACHE_TTL_MS and SESSION_CACHE_KEY_PREFIX from @/lib/validations/common.server in BOTH unit and integration tests; explicitly forbid hardcoded 30_000 or "sess:cache:" literals in either.

[T-11-A] Minor: Existing vi.mock("user-session-invalidation") shadows the new behavior — overlaps Functionality
- Evidence: scim/v2/Users/[id]/route.test.ts:49 and teams/[teamId]/members/[memberId]/route.test.ts:55 mock invalidateUserSessions.
- Fix: Use importOriginal()-style partial mocks, OR add a separate non-mocked unit test for user-session-invalidation that asserts the new pre-delete SELECT.
```

## Adjacent Findings

- **F-A-4** (Functionality → Security/Testing): Auth.js `deleteUser` cascade-deletes Session rows without invoking the per-row deleteSession adapter. Cache entries orphan for ≤30s. Add row #8 to C3 inventory or document residual.
- **T-11-A** (Testing → Functionality): Existing route tests mock `invalidateUserSessions`; the mock now shadows the new SELECT-then-DEL behavior. Migrate to importOriginal partial mocks or add unit test that exercises the real function.

## Quality Warnings

(None — Ollama merge-findings emitted no `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]` flags.)

## Recurring Issue Check

### Functionality expert

- R1 (off-by-one / boundary): Checked — no issue.
- R2 (null/undefined narrowing): Checked — no issue.
- R3 (pattern propagation + flagged-instance enumeration): Findings F-A-4, F-2.
- R4 (lock ordering / deadlock): N/A.
- R5 (resource leak): Checked — no issue.
- R6 (silent fallback masking failure): Finding F-5.
- R7 (idempotency of retry): Checked.
- R8 (event ordering): Finding F-1.
- R9 (transaction boundary for fire-and-forget): Checked — plan correct.
- R10 (circular module dependency): Checked — no issue.
- R11 (timezone / clock skew): Checked.
- R12 (precision / rounding): Checked.
- R13 (encoding / charset): Checked.
- R14 (path traversal / canonicalization): N/A.
- R15 (overflow / underflow): Checked.
- R16 (compatibility / API stability): Checked.
- R17 (helper adoption coverage): Findings F-2, F-A-4.
- R18 (test fixture / mock realism): Adjacent — Testing scope.
- R19 (config / env validation): Finding F-3.
- R20 (dependency version pinning): N/A.
- R21 (subagent completion vs verification): N/A.
- R22 (inverted perspective): Finding F-1.
- R23 (dead code / unused exports): Checked — flagged for follow-up.
- R24 (error swallowing): Checked.
- R25 (persist/hydrate symmetry): N/A.
- R26 (default value drift): Checked.
- R27 (race within single process): Finding F-1.
- R28 (cache invalidation completeness): Finding F-A-4.
- R29 (security boundary preservation): Adjacent — Security scope; F-3 partly here.
- R30 (documentation drift): Finding F-6.

### Security expert

- R1 (Hardcoded secrets): PASS.
- R2 (Missing input validation): FAIL — see [S-1].
- R3 (Pattern propagation): PASS overall but FAIL for tenant-policy change sites — see [S-3].
- R4 (Error swallowing): WARN — see [S-10].
- R5 (Race conditions / TOCTOU): PARTIAL — see [S-6].
- R6 (Authorization at every layer): PASS.
- R7 (Hardcoded paths/URLs): PASS.
- R8 (Magic numbers): PASS.
- R9 (Duplicate code): PASS.
- R10 (Dead code): NOTED — flagged.
- R11 (Inconsistent naming): WARN — see [S-4].
- R12 (Type-safety violations): FAIL — see [S-1].
- R13 (Missing cleanup): PASS — Redis TTL.
- R14 (Logging sensitive data): PASS.
- R15 (Time/timezone bugs): PASS.
- R16 (SQL/NoSQL injection): PASS.
- R17 (Missing tests for new code): PASS.
- R18 (Negative-path tests missing): PASS.
- R19 (Non-deterministic tests): WARN — "within 1s" timing-sensitive.
- R20 (Hardcoded test values leaking to prod): PASS.
- R21 (Missing migration / rollback path): PASS.
- R22 (Backward-compat break): PASS.
- R23 (Documentation drift): WARN — auth-gate.ts module-doc comment needs rewrite.
- R24 (Missing observability): WARN — no metrics for cache hit/miss rate.
- R25 (Concurrency / locking): PASS.
- R26 (Resource limits): PASS.
- R27 (Feature flag missing): PASS.
- R28 (Schema downstream effects): PASS.
- R29 (Configuration drift): PASS.
- R30 (Cross-cutting impact): WARN — see [S-2], [S-3].
- RS1 (Timing-safe comparison): N/A.
- RS2 (Rate limit on new routes): N/A.
- RS3 (Input validation at boundaries): FAIL — see [S-1].

### Testing expert

- R1 (Spec mismatch): N/A.
- R2 (Type/contract drift): clean.
- R3 (Pattern propagation): see [T-7].
- R4 (Path vs filename): see [T-1] — Critical structural mismatch.
- R5 (Constant duplication): see [T-10].
- R6 (Magic numbers): clean in plan; flagged in test follow-through ([T-10]).
- R7 (Off-by-one): clean.
- R8 (Error swallow): clean.
- R9 (Race / TOCTOU): partially addressed; see [T-6].
- R10 (Cleanup / leak): clean.
- R11 (Auth bypass): N/A.
- R12 (Logging hygiene): clean in plan.
- R13 (Tx boundary): clean — invalidation explicitly outside $transaction. Test gap flagged in [T-6].
- R14 (Backward compat): re-export documented; tests need to follow [T-7] / [T-8].
- R15 (Rollback safety): clean.
- R16 (Observability): test gap [T-9].
- R17 (Fail-open default): clean.
- R18 (Idempotency): clean.
- R19 (Test mock alignment with new exports): see [T-7], [T-11-A].
- R20 (Permissions / RLS): N/A.
- R21 (Crypto correctness): see [T-5].
- R22 (Rate limit): clean.
- R23 (Migration scripts): N/A.
- R24 (Worker / concurrent path): see [T-2] — claim of multi-worker test is false.
- R25 (CSP / security headers): N/A.
- R26 (Build/test command): see [T-1].
- R27 (Out-of-scope creep): clean.
- R28 (Deprecation): clean.
- R29 (Documentation drift): plan acknowledges deletion-candidate SESSION_CACHE_MAX; minor stale comment risk in auth-gate.ts:6-12.
- R30 (Acceptance criteria): see [T-1].
- RT1 (Mock-reality divergence): see [T-4].
- RT2 (Testability — multi-worker claim): see [T-2] — Critical false-positive.
- RT3 (Hardcoded test values): see [T-10].
