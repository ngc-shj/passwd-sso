# Coding Deviation Log: share-link-expiry-grace

- C6 helper `duplicateGrantWhere` made the `where` non-literal; `scripts/checks/bearer-passkey-gate-manifest.json` gained an `opaque-where` entry for `src/app/api/emergency-access/route.ts#handlePOST` (no digest; the established classification mechanism).
- Scope expanded mid-Phase 2 by an external review (user instruction: fix and sweep each finding's class). Contracts C7–C10 recorded in the plan addendum.
- `check:security-matrices` fails until `docs/security/deletion-retention-matrix.md` is committed (the check diffs against git); not a defect.
- Second external review: iOS fail-closed persist, extension synchronous disconnect on any server change, CLI chmod-before-rename (plan addendum round 2).
- Third external review: extension clears synchronously on every server change; CLI migrate tightens via O_NOFOLLOW fd and refuses symlinks (plan addendum round 3).
- Phase 2 self R-check (R48): C5/C6 expiry boundary aligned with the accept routes (`expiresAt < now` = expired); `expiresAt === now` is now live in both. RT3: tests use `MS_PER_HOUR` / `MS_PER_DAY` from `@/lib/constants/time`.
- Phase 3 Round 1: extension token bound to its issuer (session format gains `issuerUrl`; pre-binding sessions reconnect); refresh responses guarded by connection generation (pre-existing race); `redirect: "error"` on CLI/extension credential-bearing requests; ESLint ILIKE rule covers quoted keys and has a test.
- Phase 3 Round 2: extension tokens are fail-closed on an unknown issuer (no configured-URL fallback for requests, refresh, revoke, or server-change revoke); options-page key reset sends only to the issuer; pre-send generation recheck; CLI bearer fetches pin `redirect: "error"`. New CI guard `scripts/checks/check-client-credential-fetch.mjs` closes class C7 (not in the plan; added under R42 after the third expansion).
