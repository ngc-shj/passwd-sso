# Plan: fix-container-vulnerabilities

## Objective

Fix container image vulnerabilities detected by Trivy in CI, and re-enable blocking mode (`exit-code: "1"`).

## Requirements

### Functional

- Resolve Alpine zlib CVE-2026-22184 (CRITICAL) — upgrade from 1.3.1-r2 to 1.3.2-r0+
- Resolve cross-spawn CVE-2024-21538 (HIGH x10) — ensure 7.0.5+ in container image
- Re-enable Trivy exit-code "1" so future vulnerabilities block CI

### Non-functional

- No application behavior changes — dependency/infra updates only
- All existing tests must continue to pass

## Technical Approach

### Alpine zlib fix

- Add explicit `RUN apk upgrade --no-cache zlib` in both builder and runner stages
- Place it immediately after `FROM ... AS [stage]` + `WORKDIR` (before any COPY/RUN)
- This ensures zlib is patched regardless of base image version, and builder/runner are consistent

### cross-spawn fix

- Add `overrides` in `package.json`: `"cross-spawn": "7.0.6"` (fixed version for consistency with existing overrides style)
- This forces all npm install operations (including `npm install prisma --no-save` in runner) to resolve cross-spawn 7.0.6
- Works for both top-level and nested dependencies

### Runner stage hardening

- Change `npm install prisma --no-save` to `npm install prisma --no-save --ignore-scripts`
- prisma generate runs in builder stage; runner only needs the CLI binary for `migrate deploy`

### Trivy exit-code

- Change `exit-code: "0"` back to `exit-code: "1"` in `.github/workflows/ci.yml`
- Add empty `.trivyignore` file at project root for future CVE exclusions

## Implementation Steps

1. Add `"overrides": { "cross-spawn": "7.0.6" }` to existing overrides in `package.json`
2. Run `npm install` to update `package-lock.json`
3. In Dockerfile builder stage, add `RUN apk upgrade --no-cache zlib` after WORKDIR, before COPY
4. In Dockerfile runner stage, add `RUN apk upgrade --no-cache zlib` after WORKDIR, before adduser
5. In Dockerfile runner stage, change `npm install prisma --no-save` to `npm install prisma --no-save --ignore-scripts`
6. Change Trivy `exit-code: "0"` to `exit-code: "1"` in `.github/workflows/ci.yml`
7. Add empty `.trivyignore` at project root (for future CVE exclusions if base image has uncontrollable fixed vulns)
8. Run `npm test` to verify no regressions
9. Build Docker image locally to verify build succeeds

## Testing Strategy

- Run `npm test` — all 3725+ tests must pass
- Local `docker build` succeeds
- CI validates: Trivy scan passes with exit-code 1 (no CRITICAL/HIGH)

## Considerations & Constraints

- Keep Node 20 base image — upgrading to Node 22 is a separate concern
- .nvmrc stays at 20 — no local dev impact
- `overrides` only affects npm; if switching to another package manager, this needs revisiting
- Out of scope: upgrading application dependencies unrelated to these CVEs
