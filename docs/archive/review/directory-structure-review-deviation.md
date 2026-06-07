# Coding Deviation Log: directory-structure-review

## Phase A (C1/C2/C3 + S3)

### D1 — C2 `notification.ts` pin reason: dropped the importer count
- **Plan said**: augment the reason with "19 importers via `@/lib/notification`" plus
  the `check-bypass-rls.mjs` citation.
- **Implemented**: reason is `RLS-bypass-allowlisted (scripts/checks/check-bypass-rls.mjs:67, CI-gated)` —
  the importer count was dropped.
- **Why**: Phase 3 review (F1) flagged "19" as a miscount. Verified precise count
  of files importing `notification.ts` itself is **10** (`@/lib/notification` exact +
  the self-test); "19" had conflated the whole `@/lib/notification*` tree (the 8
  `@/lib/notification/` subdir importers target a different module). The importer
  count is also drift-prone and is NOT the load-bearing pin reason — importers are
  auto-rewritten by the codemod on a move; the genuine mechanical pin is the
  CI-gated `check-bypass-rls.mjs:67` allowlist entry (moving the file breaks that
  gate unless the allowlist path is updated). Citing only the allowlist is more
  accurate and more stable. No contract weakened — the load-bearing reason is
  preserved and made precise.

No other deviations. C1, C3, and the S3 `pre-pr.sh` hardening were implemented as
specified in the locked plan.
