# Code Review: docs-restructure-readme-and-docs

Date: 2026-03-09
Review rounds: 2

## Round 1 — Initial Review

### Functionality Findings

#### [F1] Major — `docs/setup/README.md` broken link
- **Problem**: `../policy/language-policy.md` references a non-existent path
- **Impact**: Users clicking the language policy link get a 404
- **Resolution**: Fixed to `../operations/language-policy.md`

#### [F2] Minor — "Secure Notes" template/Markdown preview details lost
- **Problem**: Old README had a dedicated bullet for Secure Notes templates and Markdown preview; new version includes it only as part of "Multiple Entry Types"
- **Impact**: Minor detail loss, but the feature is still mentioned
- **Resolution**: Accepted — intentional simplification

#### [F3] Minor — "Self-Hosted" explicit mention removed
- **Problem**: Old README had "Self-Hosted — Docker Compose with PostgreSQL, SAML Jackson, and Redis" as a standalone bullet
- **Impact**: Covered by the opening sentence "A self-hosted password manager..."
- **Resolution**: Accepted — no information loss

### Security Findings

#### [S1] Minor — Auto-lock "5 min tab hidden" condition missing
- **Problem**: Security Model only mentioned "15 min idle" but old README also included "5 min tab hidden"
- **Impact**: Omits a more aggressive lock policy relevant to security evaluation
- **Resolution**: Fixed — added "or 5 min tab hidden" to both EN/JA

#### [S2] False positive — `docs/security/README.md` missing entries
- **Problem**: Agent reported `security-review.md` and `license-policy.md` missing
- **Actual**: Both entries exist on lines 18-19 of the file
- **Resolution**: No action needed

### QA / Testing Findings

#### [Q1] Major — `docs/setup/README.md` missing platform guide table
- **Problem**: Setup README only described the English-only policy with no links to actual setup guides
- **Impact**: Users navigating from `docs/README.md` → `setup/README.md` can't find individual guides
- **Resolution**: Fixed — added table with Docker/AWS/Azure/GCP/Vercel links

#### [Q2] Minor — `docs/README.md` Assets section missing import CSV details
- **Problem**: Assets section mentions `assets/*.csv` but doesn't enumerate bitwarden/1password/chrome CSVs
- **Impact**: Users may not discover import sample files
- **Resolution**: Accepted — minor, and README root already links to passwd-sso samples

## Round 2 — Verification

All three perspectives confirmed:
- Finding F1 (broken link): Resolved correctly
- Finding Q1 (missing table): Resolved correctly, all 5 `en.md` files verified to exist
- Finding S1 (auto-lock): Resolved correctly in both EN and JA
- No regressions or new issues introduced

## Resolution Summary

| Finding | Severity | Status |
| --- | --- | --- |
| F1: setup/README.md broken link | Major | Resolved |
| Q1: setup/README.md missing file table | Major | Resolved |
| S1: auto-lock missing tab hidden condition | Minor | Resolved |
| F2: Secure Notes detail lost | Minor | Accepted |
| F3: Self-Hosted explicit mention removed | Minor | Accepted |
| S2: security/README.md missing entries | Minor | False positive |
| Q2: Assets CSV enumeration | Minor | Accepted |
