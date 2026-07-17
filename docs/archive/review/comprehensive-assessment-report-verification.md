# Report Verification: Comprehensive Assessment (A / 9.2) — Triangulated Review
Date: 2026-07-17
Review round: 1 (terminal — no Critical/Major findings)
Target: externally produced comprehensive evaluation report (A / 9.2) vs repo state at main @ 00ed72362
Mode adaptation: triangulate Phase 3 applied to report-claims-vs-repo verification (no branch diff; Ollama seed step N/A)

## Functionality Findings (quantitative claims)

No findings. All scale/structure claims reproduced exactly against `git ls-files` at HEAD:

- Total tracked files 4,275; src TS/TSX 2,020; production (non-test) 996; API routes 212 — all exact.
- Strict test files 1,177; broad 1,249 — exact (broad = strict + 69 iOS `*Tests*` Swift + 3 e2e infra files).
- Workflows 7; scripts/checks files 49; runnable .sh/.mjs checks 34; Prisma models 58; migrations 176; npm scripts 51 — all exact.
- LOC by area: ios 36,022 / extension 35,873 / cli 15,811 / prisma 10,578 / e2e 8,552 exact; src 374,844 vs 374,857 (+13 lines, 0.003%); scripts within 1.5%.
- route-policy-manifest.json: bijective with the 212 route.ts files; all classification counts (161/41/5/2/1/1/1), all 15 auth-method counts, and HTTP method distribution (119/101/34/20/7) exact. Report omits (but does not miscount) `none-410-stub: 1` (deprecated dcr-cleanup route).
- destructive 9, operator-gated 10 (truthy) exact; step-up "49" is 48 route entries + 1 `$schema-note` metadata key (off-by-one in counting method, immaterial).

## Security Findings (control claims)

Key-version guard (A1–A6), lock ordering (users FOR SHARE→entry FOR UPDATE; rotation users FOR UPDATE), 409 semantics, metadata-only handling, blob-without-version rejection, restore/bulk-import coverage: **all VERIFIED** with file:line evidence (`src/lib/vault/key-version-guard.ts:45-61`, `src/app/api/passwords/[id]/route.ts:162-269`, `src/lib/vault/rotate-key-server.ts:190-214`).

Rotation CAS: **VERIFIED** — compares all three of `key_version`, `vault_setup_at` (null-aware), `account_salt` under FOR UPDATE (`rotate-key-server.ts:196-214`). Note: the project memory phrasing "CAS must key on accountSalt not keyVersion/vaultSetupAt" describes only why accountSalt is necessary; the code compares the full tuple.

### S1 [Minor] Overview-only PUT bypasses the key-version guard
- File: `src/app/api/passwords/[id]/route.ts:157-265` (mirrored in `src/app/api/v1/passwords/[id]/route.ts`)
- `updateE2EPasswordSchema` allows `encryptedOverview` without `encryptedBlob`; both keyVersion guards condition on `encryptedBlob` only, so an overview-only PUT takes the plain-update branch with no transaction and no `assertCurrentKeyVersion`. A stale pre-rotation client can overwrite `encryptedOverview` with old-key ciphertext while `keyVersion` stays at N+1 → undecryptable overview.
- Mitigations: blob intact → overview re-derivable by re-saving (recoverable, unlike the blob case); narrow window. Severity Minor, but inside the exact threat model the guard addresses.
- Recommended fix: require `keyVersion` with `encryptedOverview` and run the same guard, or reject overview-without-blob.
- Status: **reported, not fixed** (report-verification session; awaiting user instruction).

### S2 [Minor] Report claim wording: non-grep-matchable wrapper forms
- The report says non-stable forms are "禁止 unless deleteSignal または AST 解決で許可". Actually (`check-destructive-wrapper-derivation.mjs:46-48,638-647`): instance methods and any default export are hard-failed as `NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER`; AST resolvability does NOT admit them — the only escape is explicit exemption in `destructive-wrapper-exempt.txt` or refactor. Report's conclusion (A−) unaffected.

### S3 [Minor][Adjacent] Re-export chains are a documented-open residual
- `check-destructive-wrapper-derivation.mjs:68-79`: the route pass resolves imports one hop and does not follow barrel re-export chains; compensated by review + barrel-free convention, zero current occurrences. Relevant only if the report's "namespace経由" was read as covering re-export chains.

## Testing Findings (debt/hygiene claims)

No findings. All 15 claims verified:
- Gate self-test: 34 checks, 23 with sibling `scripts/__tests__/<base>.test.*`, 11 without — the 11 are exactly the path entries in `gate-selftest-debt.txt` (24 entries total = 11 paths + 13 `pre-pr:Static:` inline gates, all with enforced reasons). 23/34 = 67.65%.
- fail-closed-test-debt.txt: 42 routes exact; 3/3 spot-checked routes DO set `failClosedOnRedisError: true` (debt is test-only, runtime is fail-closed). Context: 62 routes total set the flag; 20 have dedicated tests.
- Hygiene (production src): explicit any 25 (per-construct sum), ts-ignore 3/5, TODO 8/19 (all-src figure case-insensitive), eslint-disable 48/124, console.* 11 — all exact.
- Raw SQL: exactly 25 of 996 production files; all claimed categories present in the actual file list.

## Adjacent Findings
- S3 (above).

## Quality Warnings
None — all findings carry file:line evidence.

## Recurring Issue Check
Adapted scope (report verification, no code diff authored this session). Rules exercised where applicable:
- R21 (subagent completion vs verification): sub-agent outputs cross-checked against each other (34-check count independently reproduced by two agents) — pass.
- R29 (citation accuracy): report's numeric claims treated as citations and 100% recomputed — pass with S2 wording note.
- R42 (class-membership derivation): fail-closed debt member-set re-derived from primitive (62 flag-setters vs 42 debt entries) — consistent.
- Remaining R/RS/RT rules: N/A (no code authored).

## Environment Verification Report
N/A — no environment constraints declared; no code changed, no build/test run required this session.

## Resolution Status
- S1: reported to user; fix not applied (no instruction to modify code in a report-verification session). Cheap fix identified.
- S2, S3: informational corrections to the report text; no repo action.

## Verdict on the report
**Accurate.** Every quantitative claim reproduced exactly or within counting-method tolerance (largest deviation 1.5%). All security-control claims verified against implementation with evidence. The A / 9.2 grade is supported by the evidence; the only substantive addition from this verification is S1 (Minor, recoverable) — consistent with the report's own "明確なMedium脆弱性: 確認なし" statement.
