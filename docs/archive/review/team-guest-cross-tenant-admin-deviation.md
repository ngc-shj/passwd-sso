# Coding Deviation Log: team-guest-cross-tenant-admin

## D1: TeamMemberDisplayItem omits `keyDistributed` / `deactivatedAt`
- Plan reference: C1 output fields list `userId, name, email, image, tenantName, role, keyDistributed, deactivatedAt`.
- Actual output: `id, userId, role, name, email, image, joinedAt, tenantName`.
- Reason: No consumer reads `keyDistributed` (which lives on `teamMemberKey`, not `teamMember`) or `deactivatedAt` (the API list query already filters `deactivatedAt: null`). Including them in the helper output would require an additional join or manual hydration with no functional benefit.

## D2: TeamMemberDisplayRow input is narrower than C1 implies
- Plan reference: C1 inputs list "team-member rows with userId, role, keyDistributed, deactivatedAt, and team-scoped metadata".
- Actual input: `id, userId, role, createdAt`.
- Reason: Same as D1 — the helper does not consume `keyDistributed` / `deactivatedAt`. Caller routes already filter on these conditions before invoking the helper. JSDoc on `TeamMemberDisplayRow` documents the actual contract.

## D3: Transfer-ownership viewerTenantName derivation untested (T6 Minor — Deferred)
- Anti-Deferral check: 30-minute rule + essence filter.
- Justification:
  - Worst case: silent miswiring of the cross-tenant badge on the transfer-ownership page if a future PR relaxes the `if (!isOwner)` gate (`page.tsx:136-144`) without updating the `viewerTenantName` derivation (`page.tsx:61`).
  - Likelihood: Low. The `isOwner` gate is the page's primary access control; removing it would itself be a larger semantic change requiring its own review.
  - Cost to fix: Extracting the 1-line `members.find(...)?.tenantName ?? null` into a separate helper module purely to test it adds an indirection layer (extra file, extra import, extra test boilerplate) for a derivation that already lives inline next to its sole consumer. A full client-component test for the page (with mocked `fetchApi`, `next-intl`, and routing) is ~30 min.
  - Decision: Carry to a follow-up PR if the page gains additional access modes; do not introduce a single-purpose helper for a tested-by-construction one-liner today.

## TODO: Sidebar admin link 404 for cross-team viewer (Round 2 N1 Minor — out of PR scope)
- File: `src/components/layout/sidebar-content.tsx:80-82` (team-vault branch of `resolveAdminConsoleHref`)
- Issue: When a user is admin of team-B but only a viewer in team-A, selecting team-A's vault still renders the "Admin Console" link pointing to `/admin/teams/team-A/general`, which they cannot manage. Server-side layout gate at `src/app/[locale]/admin/teams/[teamId]/layout.tsx` correctly returns `notFound()`, so this is a UX bug (dead link) not a security issue. Pre-existing — the team-vault branch's behavior matches the pre-PR code; only the personal-vault branch was refined in this PR (F1).
- TODO: in a follow-up, gate the team-vault branch on `isTeamAdminRole(vaultContext.teamRole)`; if not admin in that team, fall through to the personal-vault logic. Add a regression test pinning the expected fallback.

## TODO: Pino redact list missing User-row crypto fields (Adjacent S-A — out of PR scope)
- File: `src/lib/logger.ts:22-40`
- Issue: redact `paths` list does not cover `encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag`, `masterPasswordServerHash`, `masterPasswordServerSalt`, `passphraseVerifierHmac`, `recoveryEncryptedSecretKey`, `recoveryHkdfSalt`, `recoveryVerifierHmac`, `accountSalt`, `secretKeyIv`, `secretKeyAuthTag`. Pre-existing; not introduced by this PR. Mitigated within this PR by minimizing the bypass user lookup in `invitations/route.ts` to `select: { id: true }`, but the underlying redact gap still applies elsewhere.
- TODO: extend redact paths in a defense-in-depth follow-up PR; consider pino's `*.<field>` wildcard form.
