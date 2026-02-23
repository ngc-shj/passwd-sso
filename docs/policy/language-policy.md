# Documentation Language Policy

This policy defines which documents must be bilingual (`en` + `ja`) and which must stay English-only.

## Goals

- Keep user-facing operational docs accessible in Japanese and English.
- Keep engineering-heavy docs as single-source English to reduce drift.
- Make translation scope explicit so maintenance cost stays predictable.

## Language Classes

### Class A: Bilingual Required (`en` + `ja`)

Use both languages for docs that directly affect end users or day-to-day operations.

- Root product overview:
  - `README.md`
  - `README.ja.md`
- Security overview for broad audience:
  - `docs/security/considerations/en.md`
  - `docs/security/considerations/ja.md`
- Operational recovery runbooks:
  - `docs/operations/backup-recovery/en.md`
  - `docs/operations/backup-recovery/ja.md`

### Class B: English Canonical (English-only)

Use English as the single source of truth for implementation-heavy or developer-centric docs.

- Setup/infrastructure guides:
  - `docs/setup/**` (`en.md` only)
- Architecture and implementation planning:
  - `docs/architecture/**`
- Deployment execution details:
  - `docs/operations/deployment.md`
- Security engineering policy/review details:
  - `docs/security/cors-policy.md`
  - `docs/security/license-policy.md`
  - `docs/security/security-review.md`
- Review artifacts and working notes:
  - `docs/review/**`
  - `docs/temp/**`

## Authoring Rules

1. For Class A docs, keep both `en` and `ja` updated in the same PR whenever semantics change.
2. For Class B docs, do not add `ja` variants unless policy is explicitly changed.
3. If a doc changes class (A <-> B), update this policy first and then restructure files.
4. If there is a conflict between language versions, treat `en` as source until sync is complete.

## Current Repository Expectations

- No `ja` files under `docs/setup/`.
- Exactly one `en.md` per setup provider directory.
- Bilingual pairs exist only for:
  - `README.md` / `README.ja.md`
  - `docs/security/considerations/en.md` / `docs/security/considerations/ja.md`
  - `docs/operations/backup-recovery/en.md` / `docs/operations/backup-recovery/ja.md`
