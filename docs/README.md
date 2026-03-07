# Docs Index

This folder contains active documentation grouped by domain.
Historical review records, working notes, and completed plans are in `archive/`.

## Directory Structure

```text
docs/
  architecture/   # Design specs, guidelines, feature comparison
  assets/         # Images, import/export samples
  operations/     # Deployment, backup, incident runbook, language policy
  security/       # Crypto whitepaper, threat model, policies
  setup/          # Cloud provider & Docker setup guides
  archive/        # Historical: reviews, temp notes, old plans
```

## Architecture

- `architecture/production-readiness.md` - production readiness checklist
- `architecture/feature-comparison.md` - comparison with 1Password / Bitwarden
- `architecture/feature-gap-analysis.md` - gap analysis and priority
- `architecture/e2e-guidelines.md` - E2E test guidelines
- `architecture/form-architecture-mapping.md` - form implementation mapping
- `architecture/webauthn-registration-flow.md` - WebAuthn registration sequence
- `architecture/tenant-team-scim-spec.md` - SCIM provisioning spec
- `architecture/entry-field-checklist.md` - entry field addition checklist

## Security

- `security/cryptography-whitepaper.md` - key hierarchy and crypto design
- `security/crypto-domain-ledger.md` - cryptographic domain separation ledger
- `security/threat-model.md` - STRIDE-based threat model
- `security/key-retention-policy.md` - key lifecycle and retention
- `security/considerations/en.md` / `security/considerations/ja.md` - security considerations
- `security/cors-policy.md` - CORS policy
- `security/license-policy.md` - dependency license policy
- `security/security-review.md` - security review checklist

## Operations

- `operations/deployment.md` - deployment procedures
- `operations/incident-runbook.md` - incident response runbook
- `operations/audit-log-reference.md` - audit log schema reference
- `operations/scim-smoke-test.md` - SCIM smoke test procedure
- `operations/backup-recovery/en.md` / `operations/backup-recovery/ja.md` - backup & recovery
- `operations/language-policy.md` - documentation language policy

## Setup

- `setup/README.md` - setup doc policy (English-only)
- `setup/aws/en.md` / `setup/azure/en.md` / `setup/gcp/en.md` / `setup/vercel/en.md` / `setup/docker/en.md`

## Assets

- `assets/passwd-sso-*.png` - screenshots
- `assets/passwd-sso.json` / `assets/*.csv` - import/export samples

## Archive

- `archive/review/` - past code review records
- `archive/temp/` - completed working notes
- `archive/plans/` - completed implementation plans
- `archive/` (root) - old feature drafts
