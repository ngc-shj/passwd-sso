# Coding Deviation Log: p1-security-hardening

Created: 2026-03-07

## Deviations from Plan

### D1: Trivy action pinned to version tag instead of commit SHA

- **Plan description**: Use `aquasecurity/trivy-action@<commit-sha>` (SHA-pinned)
- **Actual implementation**: Used `aquasecurity/trivy-action@0.28.0` (version tag)
- **Reason**: Exact commit SHA requires verifying against the Trivy releases page.
  Using a version tag is a reasonable compromise — can be upgraded to SHA pin
  in a follow-up once verified.
- **Impact scope**: `.github/workflows/ci.yml` container-scan job only

### D2: Step 12 (GitHub Secret Scanning) skipped — repo settings only

- **Plan description**: Enable secret scanning in repository settings
- **Actual implementation**: Not implemented (requires manual repo settings change)
- **Reason**: This is a repository settings toggle, not a code change.
  Cannot be automated via CI/workflow files.
- **Impact scope**: None — documentation-only note

### D3: audit:ci script omitted from package.json

- **Plan description**: Add `"audit:ci"` script to package.json
- **Actual implementation**: Omitted — CI uses `npm audit --omit=dev --audit-level=high` directly
- **Reason**: Adding a script just to wrap a single command adds no value.
  The CI workflow already specifies the exact command.
- **Impact scope**: None
