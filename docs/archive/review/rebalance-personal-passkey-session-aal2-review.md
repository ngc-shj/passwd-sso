# Plan Review: rebalance-personal-passkey-session-aal2
Date: 2026-05-07T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review performed inline from three perspectives because no delegated sub-agent review was requested for this turn.

## Functionality Findings
No findings.

Resolved during drafting:
- `F1 Major`: bootstrap-only scope for timeout reclassification was implicit. Fixed by adding an explicit assurance-context contract under `C1`.
- `F2 Major`: migrated sensitive routes were broader than the available passkey-capable caller set. Fixed by narrowing `C4` so only callers with a real retry path can adopt recent-passkey-verification in this change.
- `F3 Major`: Phase 1 did not enumerate the actual recent-session protected routes, so `bridge-code`, `extension/token`, `api-keys`, `service-account tokens`, `SCIM`, `MCP`, and `mobile authorize` were not classified by caller type. Fixed by adding a concrete route/caller matrix under `C4`.
- `F4 Major`: Phase 1 still lacked a caller-type-specific recovery UX contract, so `SESSION_STEP_UP_REQUIRED` could be interpreted differently across inline UI, redirect flows, and non-passkey-capable clients. Fixed by adding an explicit recovery UX contract under `C4`.

## Security Findings
No findings.

Resolved during drafting:
- `S1 Major`: recent-passkey-verification rollout could have created an impossible step-up for non-bootstrap or non-passkey-capable callers. Fixed by requiring a concrete passkey reauth path before migrating any route in `C4`.
- `S2 Major`: extension connect currently turns `SESSION_STEP_UP_REQUIRED` from `POST /api/extension/bridge-code` into a generic connect failure, which would make a stronger step-up rollout operationally unsafe. Fixed at the planning level by keeping bridge-style callers on `requireRecentSession` for now and requiring explicit recovery UX before any migration.
- `S3 Major`: without a shared UX contract, stale-session errors could be misreported as bad passphrase, bad transport, or full sign-out across redirect-style callers. Fixed by explicitly forbidding those interpretations in the recovery UX contract.

## Testing Findings
No findings.

Resolved during drafting:
- `T1 Major`: end-to-end WebAuthn coverage was assumed but not grounded in the current harness. Fixed by requiring integration coverage plus a manual-test fallback when browser automation cannot execute real passkey ceremonies.
- `T2 Major`: the previous plan lacked an explicit acceptance test for extension-side `SESSION_STEP_UP_REQUIRED` handling, so regressions could look like generic transport failures rather than policy failures. Fixed by adding an extension connect UX acceptance requirement to the test strategy.
- `T3 Major`: the previous plan did not require proof that inline and redirect-style callers preserve user context during reauthentication recovery. Fixed by adding caller-type-specific E2E acceptance requirements.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
This inline Phase 1 review focused on the auth/session-planning rules relevant to the proposed change.

### Functionality expert
- `R3`: Checked. Session-timeout, session-schema, and step-up helper propagation are all represented in the contracts and expected file list.
- `R4`: Checked. Shared session helpers are reused; the plan does not introduce a duplicate timeout authority.
- `R9`: Checked. No transaction-scoped fire-and-forget work is introduced by the plan contract.
- `R10`: Checked. No new circular dependency is implied by the route/helper split in the current plan.
- `R12`: Checked. Existing audit and error-code surfaces are preserved rather than renamed.
- `R29`: Checked. External AAL framing is described at a high level only; no unverified section-number citation is embedded in the plan.

### Security expert
- `R3`: Checked. Sensitive-flow impact is traced across sign-in, reauth, and protected-route enforcement.
- `RS2`: Checked. New reauth endpoints are planned with rate limiting.
- `RS3`: Checked. New request bodies are planned with explicit schema validation at route boundaries.
- `RS4`: Checked. No personal-identifying data appears in the plan artifact.

### Testing expert
- `R35`: Checked. No deployment-artifact change is proposed in this phase; manual test fallback is still required for real WebAuthn browser ceremony coverage.
- `RT2`: Checked. The plan now distinguishes unit/integration coverage from potentially unautomatable browser-passkey flows.
- `RT5`: Checked. Planned tests target the real route/helper enforcement path rather than helper-only surrogates.
