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
### D1: Provider‑based AAL3 clamp removal

- **Plan description**: Stop using `Session.provider === "webauthn"` as the sole signal for global AAL3‑style session clamping in personal‑use sessions, and keep the clamp only for bootstrap‑personal passkey sessions while preserving normal policy‑driven timeouts for other flows.  
- **Actual implementation**: The AAL3 clamping logic was removed entirely from `src/lib/auth/session/session-timeout.ts`. The resolver now returns tenant/team idle and absolute timeout values for *any* session, regardless of the `Session.provider` value, and the constant `PASSKEY_SESSION_MAX_AGE_SECONDS` was eliminated.  
- **Reason**: The change was applied globally to simplify the timeout resolver and avoid special‑casing, but this goes beyond the plan’s intent to limit the removal to personal bootstrap sessions only.  
- **Impact scope**: All WebAuthn (passkey) sessions—including admin, SSO‑backed, or other non‑personal flows—now inherit tenant/team timeout policies instead of being capped at the AAL3 ceilings (15 min idle / 12 h absolute). This may lengthen session lifetimes for those flows and could affect security expectations for high‑assurance sessions.
