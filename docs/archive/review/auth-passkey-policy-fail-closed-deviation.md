# Coding Deviation Log: auth-passkey-policy-fail-closed

## Implementation deviations
None. C1 was implemented exactly as locked in the plan (fail-closed bundle in the session-callback catch + preserved warn log). Tests T1/T2/T2b/T3 implemented per the review-refined Testing strategy, including the RT1 logger-mock fix and the `webAuthnCredential.count` mock addition.

## Out-of-scope follow-ups (from Phase 3 code review)
- **SC-followup-1** — Happy-path null-tenant fail-open (`auth.ts:417,421`). Pre-existing; a successful fetch with a null tenant defaults `requirePasskey=false`. Deferred with full Anti-Deferral cost-justification recorded in the code-review Resolution Status. Owner: separate follow-up issue.
- **SC-followup-2** — Consumer `?? false` coupling (`auth-gate.ts:103-106`). Documented-only optional hardening; deferred (would touch a file outside C1 scope). Anti-Deferral recorded in the code-review Resolution Status.
