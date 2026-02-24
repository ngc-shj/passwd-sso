# Dependency License Policy

## License Categories

### Allowed (no review required)

These licenses are freely compatible with proprietary SaaS distribution:

- MIT
- ISC
- BSD-2-Clause / BSD-3-Clause
- Apache-2.0
- 0BSD
- CC0-1.0
- Unlicense
- BlueOak-1.0.0

### Forbidden

These licenses impose copyleft obligations incompatible with proprietary distribution:

- **AGPL-\*** — Network copyleft; triggers on server-side use
- **GPL-\*** — Strong copyleft; requires source distribution of derivative works

CI will **fail immediately** if a forbidden license is detected (`exit 1`).

### Review Required

These licenses require case-by-case evaluation before use:

- **LGPL-\*** — Weak copyleft; obligations depend on linking method and distribution form
- **MPL-\*** — File-level copyleft; modifications to MPL files must be shared
- **EPL-\*** — Weak copyleft similar to LGPL
- **CDDL-\*** — File-level copyleft
- **EUPL-\*** — European copyleft license
- **CC-BY-\*** — Attribution required; typically data-only (not code)

Packages with **missing license metadata** in the lockfile also require review.

## Exception Process

When a new dependency triggers the "review required" category in CI, follow these steps:

### 1. Technical Assessment

The developer adding the dependency evaluates:

- **Distribution form**: Is this SaaS-only, distributed as OSS, or internal-only?
- **Linking method**: Dynamic linking, static linking, or data-only usage?
- **License obligations**: What does the specific license require given the distribution form?

### 2. Create Allowlist Entry

Add an entry to `scripts/license-allowlist.json` with all required fields:

| Field | Description |
|-------|-------------|
| `package` | Exact npm package name |
| `license` | Detected license string from lockfile |
| `category` | `review-required` or `missing-metadata` |
| `reason` | Technical/legal justification for approval |
| `scope` | Distribution form: `saas-only`, `oss-distribution`, or `internal-only` |
| `packageVersion` | Exact version at time of review (e.g., `1.2.4`). CI strict mode fails on mismatch |
| `approvedBy` | Approver's GitHub handle |
| `reviewedAt` | Approval date (ISO 8601) |
| `expiresAt` | Re-review deadline (typically 1 year from approval) |
| `ticket` | Related issue or PR number |
| `evidenceUrl` | License text URL or legal review record |

### 3. PR Review

The PR reviewer verifies:

- All required fields are present and accurate
- The `reason` field provides sufficient technical justification
- The `scope` field correctly reflects the current distribution model
- The `evidenceUrl` links to the actual license text

### 4. Re-review Conditions

An allowlist entry must be re-reviewed when:

- The `expiresAt` date is reached (CI will fail in strict mode)
- The installed version differs from `packageVersion` (CI strict mode will fail; update the allowlist entry after re-review)
- The project's distribution form (`scope`) changes (e.g., from `saas-only` to `oss-distribution`)

## Missing Metadata

Some packages lack license metadata in the lockfile despite having a valid license. For these:

1. Verify the license on the npm registry page
2. Set `category` to `missing-metadata`
3. Set `evidenceUrl` to the npm package page URL
4. Record the confirmed license in the `license` field

## CI Enforcement

The license audit runs in CI with `--strict` mode:

```bash
npm run licenses:check:strict        # App dependencies
npm run licenses:check:ext:strict    # Extension dependencies
```

In strict mode, CI fails (`exit 1`) when:

- **Forbidden licenses** are detected (always fails, regardless of strict mode)
- **Unreviewed** review-required or missing-metadata packages exist
- **Expired** allowlist entries exist (`expiresAt < today`)
- **Allowlist schema issues** exist (missing required fields)

Non-strict mode (`npm run licenses:check`) is available for local development and maintains backward compatibility — it warns but does not fail on review-required packages.

## Scope Definitions

| Scope | Description | LGPL Impact |
|-------|-------------|-------------|
| `saas-only` | Deployed as a hosted service; no binary distribution to users | LGPL obligations typically not triggered (no distribution) |
| `oss-distribution` | Distributed as open-source software | LGPL obligations apply; must allow relinking |
| `internal-only` | Used only within the organization; not distributed | LGPL obligations typically not triggered |

If the project's distribution model changes, all entries with the affected `scope` must be re-evaluated.
