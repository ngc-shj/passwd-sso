# Handoff: implement passkey enforcement on token-issuance + refresh paths

Copy the block below into a fresh session to resume. The Phase-1 plan is done and
committed; this session does the implementation (triangulate Phase 2 + 3).

---

## Handoff prompt

I'm resuming a security fix that already has a reviewed, contract-locked plan.
Branch `fix/passkey-enforcement-token-paths` is checked out (or check it out from
origin) — it contains ONLY docs so far (plan + review), no code yet.

**Read first (in this order):**
- `docs/archive/review/passkey-enforcement-token-paths-plan.md` — the contract-based
  plan (C1–C8, all `locked`). This is the spec; implement to it.
- `docs/archive/review/passkey-enforcement-token-paths-review.md` — the two triangulate
  rounds that hardened it (why C6/C8 exist, the nesting trap, etc.).

**The vulnerability (one line):** tenant `requirePasskey` is enforced ONLY at the web
page-route (redirect to passkey setup); the token-issuance paths (extension bridge-code,
iOS mobile authorize, MCP OAuth consent) AND the refresh grants on all three clients skip
it — so a non-passkey user signed in before enforcement can mint and indefinitely refresh
extension / iOS / MCP tokens after the grace period (MCP has no absolute cap, so it's
permanent).

**Scope = 8 contracts (all locked):**
- C1 — shared `src/lib/auth/policy/passkey-enforcement.ts`: relocate
  `isPasskeyGracePeriodExpired` + the audit-dedup map/`recordPasskeyAuditEmit`/`_*ForTests`
  out of `page-route.ts`; add `passkeyEnforcementBlocks(p)`. **CRITICAL nesting (round-2
  T8):** `auth()`-driven routes expose the 4 passkey fields at `session.user.*`, the
  page-route at flattened top level — call `passkeyEnforcementBlocks(session.user)` in
  the token routes. Get this wrong and every block test passes vacuously.
- C2 — gate `extension/bridge-code/route.ts` (after step-up, before mint) → 403 `PASSKEY_REQUIRED`.
- C3 — gate `mobile/authorize/route.ts` → 302 to fixed `passwd-sso://auth/callback?error=passkey_required`, before `mobileBridgeCode.create`.
- C4 — audit `PASSKEY_ENFORCEMENT_BLOCKED` (reuse the action; route through the shared
  `recordPasskeyAuditEmit` dedup; emit ONLY this action, not `*_ISSUE_FAILURE`).
- C5 — surface `PASSKEY_REQUIRED` to the extension UI: add it to `EXTENSION_CONNECT_ERROR_CODE`,
  add the `coerceErrorCode` branch AND **`export` `coerceErrorCode`** (round-2 T9, it's
  module-private today), propagate in `token-handler.extractErrorCode`, show a card in
  `auto-extension-connect.tsx` (en+ja i18n).
- C6 — gate MCP: `mcp/authorize` GET (JSON early-reject, its own convention) + `mcp/authorize/consent`
  POST (authoritative; mirror the `deny` action's `error=access_denied`+`error_description=passkey_required`
  to the validated `redirect_uri`, before `createAuthorizationCode`).
- C7 — CI guard (mirror `scripts/checks/check-permanent-delete-stepup.sh` + its allowlist +
  **mandatory** `scripts/__tests__/check-*.test.mjs` self-test): grep the FULL primitive set
  — initial (`createAuthorizationCode|extensionBridgeCode.create|mobileBridgeCode.create`)
  AND refresh (`exchangeRefreshToken|refreshIosToken|createRefreshToken|extensionToken.create`).
  Do NOT trigger on `await auth()` (cookieless refresh routes would be excluded).
- C8 — gate the REFRESH grant (round-2 S8, the big one): `extension/token/refresh`,
  `mobile/token/refresh`, MCP refresh (`mcp/token` → `exchangeRefreshToken` in
  `oauth-server.ts`). Extension refresh has a session → read `session.user`; iOS/MCP are
  cookieless → re-derive `requirePasskey`/`hasPasskey`/grace from the token's `tenantId`+`userId`
  (tenant policy row + passkey-credential count). SA-bound MCP (`userId===null`) skips.
  **Also add an MCP absolute family cap** (it has none today).

**Process:** run triangulate Phase 2 (implement per contract) then Phase 3 (3-expert code
review). Strongly consider a quick Phase-1 round 3 first — round 2 expanded scope materially
(C8), so the plan deserves one more review pass before coding. Honor the testing strategy's
**mock-nesting prerequisite** (session.user.*, and note only `bridge-code/route.test.ts` uses
the shared `MockSession`; mobile/authorize + mcp/consent tests use inline `{user:{id}}`
literals that must each be extended). Add a non-vacuity assertion per route.

**Verify before PR:** `npx vitest run`, `npx next build`, `bash scripts/pre-pr.sh`
(per CLAUDE.md mandatory checks + the repo's CI gates). This touches auth — do the R3
propagation sweep and don't rush the security-adjacent edits.

**PR cadence:** the plan is one coherent fix; aim for ONE PR after the final phase (per
`feedback_pr_cadence_aggregate`), unless the diff gets unwieldy — if you split, do
initial-mint (C1–C7) vs refresh (C8) and say so explicitly. PR body in English; wrap bare
`#N`/SHA in backticks except one `Closes #N` if an issue tracks it.

**Context — what's already merged/open (do not redo):**
- `#620` (merged): ext_connect no longer forces the vault passphrase prompt.
- `#622` (open): follow-up fixes to #620 (setup-wizard bypass + disconnect-reason race).
- `#623` (open): `docs/architecture/client-reauth-timing.md` + the PRF auto-unlock No-Go
  record. (PRF vault auto-unlock was reviewed No-Go on trust-boundary grounds — do NOT
  revive it as part of this work.)

Start by reading the plan + review, then propose the implementation order and confirm
whether to run a Phase-1 round 3 first.
```
