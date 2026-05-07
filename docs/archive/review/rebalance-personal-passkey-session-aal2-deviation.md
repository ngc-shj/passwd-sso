# Coding Deviation Log: rebalance-personal-passkey-session-aal2

## 2026-05-07

### Deferred rollout: `requireRecentPasskeyVerification` is implemented but not yet attached to existing sensitive routes
- Plan contract affected: `C4`
- Reason:
  - During Phase 2 impact analysis, the current protected-route callers were found to mix bootstrap-personal, SSO, and non-passkey-capable flows.
  - Attaching `requireRecentPasskeyVerification` immediately would create dead-end `SESSION_STEP_UP_REQUIRED` paths for callers that do not yet have an in-product passkey reauth retry UX.
  - The lower-risk stopping point for this round is:
    - remove the blanket passkey-session AAL3 timeout clamp,
    - persist session-scoped `passkeyVerifiedAt`,
    - add authenticated passkey reauth endpoints and shared guard/helper,
    - leave existing route gating on `requireRecentSession` until a caller-by-caller rollout lands.
- Follow-up:
  - Migrate one caller at a time only after confirming a concrete passkey-capable retry path.
  - Likely first candidate remains a bootstrap-personal-only caller rather than a mixed tenant-admin surface.
