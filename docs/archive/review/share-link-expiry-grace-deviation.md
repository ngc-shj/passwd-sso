# Coding Deviation Log: share-link-expiry-grace

- C6 helper `duplicateGrantWhere` made the `where` non-literal; `scripts/checks/bearer-passkey-gate-manifest.json` gained an `opaque-where` entry for `src/app/api/emergency-access/route.ts#handlePOST` (no digest; the established classification mechanism).
- Scope expanded mid-Phase 2 by an external review (user instruction: fix and sweep each finding's class). Contracts C7–C10 recorded in the plan addendum.
- `check:security-matrices` fails until `docs/security/deletion-retention-matrix.md` is committed (the check diffs against git); not a defect.
- Second external review: iOS fail-closed persist, extension synchronous disconnect on any server change, CLI chmod-before-rename (plan addendum round 2).
- Third external review: extension clears synchronously on every server change; CLI migrate tightens via O_NOFOLLOW fd and refuses symlinks (plan addendum round 3).
