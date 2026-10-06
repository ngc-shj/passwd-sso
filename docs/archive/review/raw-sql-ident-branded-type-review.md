# Plan Review: raw-sql-ident-branded-type
Date: 2026-10-06
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening: no issues.

## Functionality Findings
- F1 [Major, design] C2 cited a derivation command in a nonexistent section. Resolved: C2 states the derivation; script recorded at Phase 2.
- F2 [Major, design] `UNSAFE_METHOD_ESCAPES` unscoped — false positive on `scripts/lib/assert-bypass-rls-active.ts`'s `TxProbe` method signature. Resolved: expression position only; type-position allow fixtures.
- F3 [Minor, prose] C4 pointed at `docs/security/`, which has no marker text. Resolved.
- F4 [Minor, prose] `raw-sql-usage.txt` header narrative not scheduled. Resolved: C4 narrative rewrite.
- F5 [Minor, design] empty `trustedSql` template untested. Resolved: C1 acceptance.

## Security Findings
- S1 [Critical, design, escalate] `any` (e.g. `JSON.parse`) forges a type-only brand; no runtime check. Resolved by redesign: opaque objects in a module-private WeakMap; `renderSql` / `trustedSql` verify at runtime.
- S2 [Critical, design, escalate] `@ts-expect-error` (lint-permitted with description) silences the only authority. Resolved by the same redesign — the control is no longer tsc.
- S3 [Critical, design, escalate] `$queryRaw(Prisma.raw(x))` / `` $queryRaw`${Prisma.raw(x)}` `` embed raw text; SC2's premise was false. Resolved: FR4 + `RAW_NOT_TAGGED` + `PRISMA_RAW`; SC2 corrected. Measured: all 74 `$queryRaw`/`$executeRaw` uses are tagged; 0 non-tagged; 0 `Prisma.raw`.
- S4 [Major, design] escape spellings illustrative; parenthesized callee, computed keys, BRAND_CAST scan root. Resolved: parenthesized/template-key/string-name fixtures; scan root unconditional; non-literal computed key declared residual (tripwire). BRAND_CAST dropped — no longer meaningful with runtime values.
- Escalation: Round 2 security review runs on Opus over the revised plan (the escalate:true findings drove a redesign, so a re-review of the old text would assess superseded contracts).

## Testing Findings
- T1 [Critical] migrate-account-tokens script has no test; T2 [Critical] outbox UPDATE text unpinned — a post-change test would be tautological. Resolved: Step 0 characterization tests committed before migration.
- T3 [Major] no test that the brand blocks a plain string. Resolved by redesign: runtime rejection tests (string, JSON object, look-alike, frozen copy) replace a type-level test.
- T4 [Major] BRAND_CAST allow side untested. Moot: rule dropped.
- T5 [Major] 0-files / parse-error fail-closed untested. Resolved: C3 fixtures.
- T6 [Major] existing sweep tests use whitespace-tolerant regexes. Resolved: Step 0 tightens them to exact strings.
- T7 [Major, Adjacent] same as Func F1.

## Recurring Issue Check
### Functionality expert
R29 Flagged (F3), R42 Flagged (F1); all others Clear.
### Security expert
R42/R47 (S4), R48 (S3), R49 (S1, S2, S3) flagged; RS1–RS6 Clear.
### Testing expert
RT7 triggered (T2, T3, T5), RT10 triggered (T4), R19 clean.
