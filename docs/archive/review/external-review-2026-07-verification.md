# External Review Verification: 2026-07 A− assessment

Date: 2026-07-22
Method: triangulate Phase 3 (verification mode) — external review findings used as
seeds; two verification sub-agents (security scope, functionality/ops scope) checked
each claim against current main (post PR #713 / commit 649dd6308).

## Summary

| # | External claim | Sev | Disposition | Evidence anchor |
|---|----------------|-----|-------------|-----------------|
| 1 | null-tenant gate accepts any `return` as fail-closed | Medium | **RESOLVED** (PR #713) | check-null-tenant-fail-closed.mjs:271-273; negative self-tests test.mjs:186-204; `\|\|` fallback clause mjs:283-286 red-proven test.mjs:223-235 |
| 2 | Browser/session path skips tenant-tailnet verification (CGNAT-only) | Medium | **PARTIALLY RESOLVED** | Boundary is intentional + documented (access-restriction.ts:162-178, docs/security/policy-enforcement.md:49-51, PR #651). Residual: UI help text `tailscaleTailnetHelp` (messages/en/TenantAdmin.json:84) overstates enforcement for browser flows |
| 3 | proxy session JSON missing fields fail open (`requirePasskey ?? false`) | Low | **CONFIRMED** | auth-gate.ts:124-132 — no schema validation; risk acknowledged in comment :118-123; no test/CI pins the 4-field src/auth.ts contract (success :470-478, catch :449-452) |
| 4 | retention worker RLS classification is manual registry, no DB cross-check | Low | **CONFIRMED** | retention-gc-worker/index.ts:57-59 TODO present; no pg_policies/relrowsecurity comparison in db-integration tests or CI |
| 5 | Node/npm toolchain not pinned (engines/packageManager absent) | Low | **CONFIRMED (+1)** | .nvmrc = `20`; root package.json lacks both fields; bonus finding: ci.yml:86 `env-drift-check` job floats on Node **22**, whole-major divergence from .nvmrc |
| 6 | Strict lockout fallback availability risk (cache/metrics/unlock) | Low | **PARTIALLY RESOLVED** | Fallback never cached (account-lockout.ts:86-118); #713 regression test :670-710; structured warn logs fire on fallback. Residual: no metric counter/alerting hook; no standalone admin lockout-unlock (only bundled in destructive vault reset, vault-reset.ts:115-117) |
| 残1 | gate self-test debt 24 entries incl. 6 security-relevant inline gates | Info | **CONFIRMED** | gate-selftest-debt.txt: 24 entries; all 6 named security gates present (:40,:43,:46-49), "extraction deferred (SC7)" |
| 残2 | Team history old-key decryption incomplete post-rotation | (review: design) | **CONFIRMED — effectively Medium functional** | Server side complete (versioned TeamMemberKey, `?keyVersion=N` endpoint member-key/route.ts:40-59); client never uses it — entry-history-section.tsx:190-193 TODO says pre-rotation history "will fail to decrypt". Safety conditions: active-member ✓, revoked-member key deletion ✓, version-mismatch handling ✗ (delegated to client, unimplemented), old-key fetch audit ✗ (member-key GET has zero logAudit calls) |
| 残3 | AccessRequest PENDING→EXPIRED transition has no system caller | Info | **CONFIRMED (mitigated)** | access-request-state.ts:33 first-party TODO; security path safe — approve CAS `expiresAt > now()` (approve/route.ts:152,169) prevents token mint; expired rows display as PENDING until retention GC hard-delete (registry.ts:344-357) |

## Verification notes

- CLAIM 1: the recommended `return { requirePasskey: false }` negative fixture is not
  literally present, but the acceptance clause is throw-only by construction (direct-kind
  or descendant ThrowStatement), so all return-shaped bodies fail; three return shapes
  are red-proven.
- CLAIM 2 severity bound: reaching the CGNAT branch requires a genuine CGNAT source IP
  (fail-closed XFF posture); the exposure matches the review's characterization —
  authenticated member of ANY tailnet passes the browser path.
- CLAIM 6 (lockout): recovery-after-DB-restore path is proven by test (findUnique called
  twice, no cache pin).

## Residual actionable items (ranked)

1. **残2 (team history old-key client path)** — the only item with real user-facing data
   loss today: post-rotation history view fails AES-GCM auth; restore writes an entry the
   current key cannot decrypt. Server infra exists; client wiring + old-key-fetch audit
   missing.
2. **#2 residual** — fix `tailscaleTailnetHelp` (en+ja) to disclose the browser-path
   boundary (docs already do), or implement browser-path WhoIs.
3. **#3** — pin the 4-field session-callback contract with a fail-closed drift test
   (drop-field → blocked) or Zod-validate in auth-gate.
4. **#6 residual** — standalone admin lockout-clear endpoint; metric/alert on fallback.
5. **#4** — db-integration check: retention registry vs pg_policies/relrowsecurity.
6. **#5** — add `engines` + `packageManager` to root package.json; align env-drift-check
   job (Node 22 → .nvmrc).
7. **残3** — PENDING→EXPIRED sweep in retention-gc worker (cosmetic/UX; token mint
   already blocked).
8. **残1** — SC7 extraction of the 6 security-relevant inline gates (tracked debt).

No new Critical/High. External review's two Mediums: #1 fully closed by PR #713;
#2 boundary intentional and documented, UI wording residual only. The highest-impact
open item was under-weighted by the external review: 残2 (team history old-key) is a
confirmed functional defect with an in-code TODO, not just a design question.
