# Coding Deviation Log: admin-ia-redesign

Phase 2 deviations from `admin-ia-redesign-plan.md`. None affect the planned IA outcome; all are minor reorderings, dead-key cleanup, or hardening adjustments discovered during implementation.

## Batch 1 — i18n key cleanup applied here (plan said Batch 7)

The plan deferred deprecated-key removal to Batch 7. In practice the new `messages/{ja,en}/AdminConsole.json` was written wholesale in Batch 1, which already drops the deprecated keys. Functionally identical to the plan; just earlier. The Batch 7 sentinel test still verifies the absence.

## Batch 6 — TeamRotateKeyButton typed-confirm added (plan said "verify or add as needed")

Round-1 finding S4 required verification that `TeamRotateKeyButton` has a multi-step confirm flow. Verification found only a single-button AlertDialog (no typed confirm). Per S4's fallback ("If it does NOT, the plan should require adding it"), a typed-confirmation input gating the destructive Rotate Key button was added in this PR. Two new i18n keys (`rotateKeyTypePrompt`, `rotateKeyTypePlaceholder`) added to `messages/{ja,en}/Teams.json` (NOT AdminConsole.json — they're team-feature labels, not admin-nav labels).

## Batch 7 — Dead `sectionIntegrations` keys removed (plan didn't anticipate)

The forward-direction sentinel test (`admin-i18n-key-coverage.test.ts`) caught two dead keys:
- `sectionIntegrations` / `sectionIntegrationsDesc`

The integrations group landing page (`/admin/tenant/integrations/page.tsx`) is a redirect-only Server Component with no SectionLayout consumer, so these section-header keys had no readers. Plan listed them as new keys. Removed from `messages/{ja,en}/AdminConsole.json` to keep the sentinel green; correct fix per round-1 T2 design intent.

## Post-Batch-7 — pre-pr.sh e2e-selectors marker support (script enhancement beyond plan)

The new `e2e/tests/admin-ia.spec.ts` intentionally lists deleted admin URLs in `OLD_URLS_404` to assert 404 behavior (regression guard against accidental redirect re-introduction). The existing `scripts/checks/check-e2e-selectors.sh` flagged these as warnings.

Two-file fix:
- `scripts/checks/check-e2e-selectors.sh`: added per-file exemption marker `// e2e-selectors:expected-deleted-routes`. Files with this marker are skipped for the deleted-route warning.
- `e2e/tests/admin-ia.spec.ts`: added the marker comment with rationale.

This is a meta-tooling improvement that makes intentional 404-regression tests possible going forward; not strictly part of the IA refactor but blocked Phase 2 closure.
