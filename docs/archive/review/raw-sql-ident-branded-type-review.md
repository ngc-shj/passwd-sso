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

---

# Round 2
Date: 2026-10-06

## Changes from Previous Round
Redesign to runtime-verified opaque values (WeakMap) with `renderSql` at the Unsafe boundary; FR4 tagged-only raw API; Step 0 characterization tests.

## Functionality Findings
- F1 [Critical, design] genuine fragments composed through ordinary templates stringify to `[object Object]`. Resolved: FR2 throwing `toString`/`valueOf`/`Symbol.toPrimitive`; C2 composition invariant.
- F2 [Critical, feasibility] migrate script runs `main()` on import. Resolved: Step 0 adds the CLI guard used by tenant-domain.ts / audit-chain-verify-worker.ts.
- F3 [Major, scope] `assertIdentifier` → `sqlIdentifier` is a capture-and-thread rewrite (~14 sites, 5 functions). Resolved: stated in C2.
- Verified: 53 Unsafe calls, 7 non-literal; 74 `$queryRaw`/`$executeRaw`, all tagged; 0 `Prisma.raw`; type-position references are the three listed.

## Security Findings (Opus, escalated)
- N1 [Critical] `trustedSql` callable as a function mints a fragment from arbitrary text. Resolved: `RAW_SQL_MODULE_USE` (tag-only, unaliased, no namespace/re-export).
- N2 [Critical] `Prisma.join`/`sql`/`Sql` inject raw text into tagged `$queryRaw`; `PRISMA_RAW` spellings incomplete. Resolved: `PRISMA_SQL_TAG` over {raw, sql, join, Sql, empty, sqltag} and every access spelling; measured 0 uses.
- N3 [Critical] string-keyed `$queryRaw({sql})`, `$…RawInternal`, `$queryRawTyped`. Resolved: single `RAW_METHOD` rule over `/^\$(query|execute)Raw\w*$/` incl. literal contents.
- N4 [Critical] file-wide binding check. Resolved: scope-aware resolution; shadow fixtures.
- N5 [Major] negative integer renders `--`. Resolved: non-negative only.
- N6 [Major] `sqlIdentifier` accepts keywords; lexical guarantee. Resolved: reserved-keyword rejection (list pinned to `pg_get_keywords()`), stated precondition.
- N7 [Major] direct-call not pinned to callee. Resolved: `getExpression()` is the Identifier; deny fixtures.
- N8 [Minor] export surface. Resolved: C1 acceptance.
- N9 [Minor] residual incomplete. Resolved: listed.
- N10 [Minor, Adjacent] direct `pg` / non-.ts out of scope undeclared. Resolved: scan widened to .js/.mjs/.cjs/.mts/.cts and `prisma/`; SC3 names direct `pg`.
- Round-1 S1/S2 confirmed closed; S3 completed by N2/N3.

## Testing Findings
- T8 [Major] `predicate.test.ts` unaddressed. Resolved: pinned in Step 0, reject list re-expressed after.
- T9 [Major] `onWebhookDeliveryFailure` not exported. Resolved: Step 0 exports it.
- T10 [Major] Step 0 ordering unverifiable. Resolved: SHA in deviation log; reviewer check + standalone run.
- T11 [Major] aliased `raw` import fixture and allow neighbour. Resolved: C3 fixtures.

## Recurring Issue Check
### Functionality expert
R41 (F2), R49 (F1) flagged; R42/R47/R48 clear (re-derived).
### Security expert
R3 (N2/N3), R42 (N2/N3), R46 (N4), R47 (N1/N2/N3/N7), R48 (N2), R49 (N1/N6/N9/N10), R55 (N5) flagged; R29 clear; RS3 (N6); RS6 clear.
### Testing expert
RT2 (T9), RT10 (T11), R50 (T10), R19 adjacent (T8) flagged; RT7, RT8, R42 clear.

---

# Round 3
Date: 2026-10-06

## Changes from Previous Round
Round-2 dispositions applied (tag-only `trustedSql`, scope-aware resolution, raw-method name class, sql-template-tag ban, keyword rejection, non-negative integers, export surface, residual, widened scope, Step 0 details).

## Functionality Findings
- F1 [Major] `JSON.stringify` bypasses the throwing conversions (logs, audit metadata). Resolved: `toJSON` throws too; acceptance pins it; logs keep the plain string.
- F2 [Minor] CLI-guard pattern cited in audit-chain-verify-worker.ts, which uses a different one. Resolved: cite tenant-domain.ts only.
- F3 [Minor] "~14" → exactly 12 `assertIdentifier(` sites in sweep.ts. Resolved.
- F4 [Minor] precondition list omitted the migration script's column set. Resolved.
- Verified: widened scope introduces no violation in the current tree (type-position hits only); no C2 identifier is a reserved keyword.

## Security Findings (Opus)
- S1 [Critical] scope resolution misses var-in-block, function/class expression names, `import x =`; specifier variants, `import()`, `require()`, `export *` bypass module recognition. Resolved by mechanism change: `RAW_SQL_NAMES` positional allowlist with no binding resolution; specifier resolution to the file; every other loading form denies.
- S2 [Critical] Prisma producers reachable from top-level `@prisma/client`, `.prisma/client`, `/edge`, `/index-browser`, default/namespace/dynamic imports. Resolved: `PRISMA_IMPORT` allowlist (names and `Prisma.*` members).
- S3 [Minor] match decoded literal values. Resolved.
- S4 [Minor] SC3 omitted `scripts/audit-db-grants.mjs`; adapter `queryRaw` and `$extends` undeclared. Resolved: SC3 corrected; `PRISMA_EXTENDS` (0 uses); adapter in residual.
- S5 [Minor] reject catcode `T` too. Resolved.
- S6 [Minor] `sqlIdentifier` precondition unenforced. Resolved: declared residual, review-enforced.
- S7 [Minor] `scripts/checks/**` exclusion too broad. Resolved: literal-content clause only.
- N1–N10 status per this review: N3, N5, N7, N8 closed; N1/N4 superseded by S1; N2 by S2; N6, N9, N10 closed with S4–S6 refinements.

## Testing Findings
- T12 [Major] toString/valueOf only reached through Symbol.toPrimitive. Resolved: direct-call and JSON.stringify cases, each red-proven per override.
- T13 [Major] one generic shadow fixture. Resolved: one per declaration kind (now under `RAW_SQL_NAMES`).
- T14 [Major] "mechanical adaptation" after C2 unverifiable. Resolved: diff check against the Step 0 SHA; expected strings byte-identical.
- T15 [Major] widened scope unproven per extension/root. Resolved: one fixture per extension and `prisma/`.

## Recurring Issue Check
### Functionality expert
R29 (F2, F3), R42 (F4), R49 (F1) triggered; R1, R3, R41, R46–R48 clear.
### Security expert
R1, R29, R42, R46, R47, R48, R49 flagged (S1–S6); RS3 (S6); R3, R55, RS1, RS2, RS4–RS6 clear.
### Testing expert
R42 (T13, T15), R50 (T14), RT7 (T12) triggered; T8–T11 verified.
