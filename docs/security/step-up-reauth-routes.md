# Step-up reauth (recent-auth) — required API routes

Single source of truth for which API routes require a **recent auth ceremony**
(`requireRecentCurrentAuthMethod(req)`) on top of normal authorization. Keep this
in lockstep with the code: when you add a route that performs a mutation in one of
the **gated classes** below, add the gate AND a row here in the same PR.

## What step-up is, and when it applies

Step-up is a second gate, distinct from authorization. After `auth()` +
`requireTenantPermission` / `requireTeamPermission` confirm *who you are* and *what
you may do*, step-up confirms the session was **recently** re-authenticated — so a
hijacked-but-not-recently-verified session (stolen cookie, unattended device) cannot
perform a high-impact mutation.

Placement (the locked pattern): **after** the authorization check, **before** any
mutation. Prefer **before** the existence lookup too, so a non-recent caller cannot
use 404-vs-403 as an existence oracle (the `members/[*]` routes follow this; the
`webhooks/[webhookId]` DELETE keeps step-up after existence to match its tenant
counterpart — both are acceptable, existence-first only leaks within-team IDs to an
already-authorized admin).

```ts
const stepUpError = await requireRecentCurrentAuthMethod(req);
if (stepUpError) return stepUpError;
```

## Gated classes (require step-up)

A mutation is in scope when it touches one of these:

1. **Identity / access grant** — adding/removing a member, changing a member role,
   distributing a team key to a member (grants or revokes vault-key access).
2. **Key custody** — key rotation, key material lifecycle.
3. **External sink / integration config** — webhooks, audit delivery targets,
   directory-sync, MCP clients (an attacker-controlled sink exfiltrates data).
4. **Security policy** — tenant/team security policy (timeouts, CIDR allowlist,
   lockout thresholds, passkey requirements).
5. **Container lifecycle destruction** — deleting a team (destroys all team vault
   data + key material).
6. **Secret minting / high-privilege token issuance** — operator tokens, SCIM
   tokens, service-account tokens, JIT approval, vault admin-reset.

**NOT gated** (ordinary content CRUD — gating these hurts UX with no real benefit;
the threat is the *governance/identity/key* surface, not individual records):
passwords (create/update/delete/bulk/restore/favorite/attachments/history),
folders, tags, invitation *accept* (the invitee, not an admin).

## Tenant routes (gated)

| Route | Method(s) | Class |
|-------|-----------|-------|
| `/api/tenant/webhooks` | POST | external sink |
| `/api/tenant/webhooks/[webhookId]` | DELETE | external sink |
| `/api/tenant/policy` | PATCH | security policy |
| `/api/tenant/members/[userId]` | PUT | identity (role change, ownership transfer) |
| `/api/tenant/members/[userId]/reset-vault` | POST | key custody (vault reset) |
| `/api/tenant/audit-delivery-targets` | POST | external sink |
| `/api/tenant/audit-delivery-targets/[id]` | PATCH | external sink |
| `/api/tenant/breakglass` | POST | high-privilege grant |
| `/api/tenant/breakglass/[id]` | DELETE | high-privilege grant |
| `/api/tenant/mcp-clients` | POST | integration config / secret mint |
| `/api/tenant/mcp-clients/[id]` | PUT, DELETE | integration config |
| `/api/tenant/scim-tokens` | POST | secret mint |
| `/api/tenant/scim-tokens/[tokenId]` | DELETE | token lifecycle |
| `/api/tenant/service-accounts/[id]` | PUT, DELETE | identity |
| `/api/tenant/service-accounts/[id]/tokens` | POST | secret mint |
| `/api/tenant/service-accounts/[id]/tokens/[tokenId]` | DELETE | token lifecycle |
| `/api/tenant/operator-tokens` | POST | secret mint |
| `/api/tenant/access-requests/[id]/approve` | POST | high-privilege grant (JIT) |
| `/api/tenant/access-requests/[id]/deny` | POST | high-privilege grant (JIT) |
| `/api/vault/admin-reset` | POST | key custody |

## Team routes (gated)

| Route | Method(s) | Class |
|-------|-----------|-------|
| `/api/teams/[teamId]/webhooks` | POST | external sink |
| `/api/teams/[teamId]/webhooks/[webhookId]` | DELETE | external sink |
| `/api/teams/[teamId]/policy` | PUT | security policy |
| `/api/teams/[teamId]/members/[memberId]` | PUT, DELETE | identity (role change / removal) |
| `/api/teams/[teamId]/members` | POST | identity (add member → grants key access) |
| `/api/teams/[teamId]/members/[memberId]/confirm-key` | POST | key custody (key distribution) |
| `/api/teams/[teamId]/rotate-key` | POST | key custody (key rotation) |
| `/api/teams/[teamId]` | PUT, DELETE | security config (PUT) / lifecycle destruction (DELETE) |

## Deferred / not-yet-gated (tracked)

| Route | Method | Why deferred |
|-------|--------|--------------|
| `/api/teams/[teamId]/invitations` | POST | invite is a *precursor* to membership; no immediate key access (the grant happens at member-add / confirm-key, both gated). Re-evaluate if invites ever auto-grant access. |
| `/api/teams/[teamId]/invitations/[invId]` | DELETE | cancel invite — low impact (no access change). |

## Maintenance

- **Adding a route**: if its mutation is in a gated class above, add
  `requireRecentCurrentAuthMethod(req)` after authz/before mutation AND a row here.
- **R19 test obligation**: every gated route's test file (co-located AND any
  centralized `src/__tests__/` test importing the handler) must mock
  `@/lib/auth/session/recent-current-auth-method` with a pass-through default, plus a
  reject test asserting the mutation spy is not called. Missing the centralized mock
  silently 401s every existing test for that handler.
- This doc is the lightweight stand-in for a centralized operation-sensitivity guard
  (the structural SSoT — see PR #606 SC2). Until that guard exists, this table is the
  audit surface; a quick conformance check is
  `grep -rL requireRecentCurrentAuthMethod <each gated route file>`.
