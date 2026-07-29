# Audit Log Schema: `AUTH_LOGIN_FAILURE` Metadata

This document covers the `metadata` shape written by `emitAuthLoginFailure`
(`src/lib/audit/auth-failure.ts`) for `AUDIT_ACTION.AUTH_LOGIN_FAILURE` rows,
introduced/extended by the SSO tenant claim registry work (C6/C8). It is the
one audit-metadata shape in the codebase whose fields are partly attacker
(IdP)-controlled, which is why its rendering and delivery rules are pinned
here rather than left to convention.

## Fields

| Field | Type | Set when | Notes |
|---|---|---|---|
| `provider` | `AuthProvider` | always | `"google" \| "nodemailer" \| "saml" \| "passkey" \| "credentials" \| "unknown"` |
| `reason` | `AuthLoginFailureReason` | always | `"unknown_email" \| "tenant_mismatch" \| "provider_error" \| "magic_link_expired" \| "credential_mismatch" \| "tenant_claim_unmapped"` |
| `identifierHash` | `string \| null` | see below | HMAC-SHA256(pepper, `email.toLowerCase() + ":" + tenantId`), first 16 hex chars (64 bits) |
| `identifierHashScope` | `"tenant" \| "global" \| "unkeyed" \| null` | see below | which binding produced `identifierHash`, or why none was produced |
| `claim` | `string` | only when the caller passed one | the raw tenant claim value extracted from the IdP response, truncated to `MAX_TENANT_CLAIM_LENGTH` |

## `identifierHash` / `identifierHashScope`

`emitAuthLoginFailure` only attempts a hash when the caller passes a non-null
`email`. The four reachable states, from `src/lib/audit/auth-failure.ts`:

| `email` | pepper available | `identifierHash` | `identifierHashScope` |
|---|---|---|---|
| `null` | — | `null` | `null` |
| present | yes, `tenantId` present | HMAC | `"tenant"` |
| present | yes, `tenantId` absent/null | HMAC (tenantId input `""`) | `"global"` |
| present | no | `null` | `"unkeyed"` |

`null` and `"unkeyed"` are **deliberately distinct** and must not be
conflated:

- `identifierHashScope: null` means no hash was ever attempted — there was no
  email to hash (e.g. an unauthenticated magic-link probe, or a denial before
  the IdP returned an email). The field does not claim a binding for a hash
  that does not exist.
- `identifierHashScope: "unkeyed"` means an email **was** available but no key
  material was — neither `AUDIT_IDENTIFIER_PEPPER` nor an `AUTH_SECRET` of at
  least 32 characters was configured (`getIdentifierPepper()`). This is the
  signal an operator watches for to detect a missing-pepper misconfiguration:
  a `"tenant"`/`"global"` deployment that starts emitting `"unkeyed"` rows has
  lost its pepper. A null-email denial reaching this state would silently
  degrade that signal's meaning, which is why the two are kept apart (see
  "Deviation" below).

Pepper resolution order (C8), memoised on first use per process:

1. `AUDIT_IDENTIFIER_PEPPER` — explicit operator-configured pepper.
2. `AUTH_SECRET` (≥ 32 chars) — `hkdfSync("sha256", secret, "", "audit-identifier-pepper-v1", 32)`, domain-separated so `AUTH_SECRET` is never used verbatim as the HMAC key.
3. Neither — no hash is computed (`"unkeyed"`); a warning is logged once per process.

**Deviation from the original design** (recorded because it changes what a
downstream consumer can assume): the original design allowed
`identifierHashScope: "unkeyed"` to also cover "no email at all". The shipped
behavior narrows `"unkeyed"` to "email known, pepper unavailable" and adds a
separate `null` state for "no email, nothing to hash" — see
`docs/archive/review/sso-tenant-domain-alias-deviation.md` D-6.

### The C8 hash-population change is a deliberate breaking change to the hash space

Before C8, an absent pepper fell back to an **empty-key HMAC** — hashing over
an email-address input space with a known, fixed (empty) key is a lookup
table, not a keyed protection: any consumer of the audit stream who suspects a
given email could confirm it by computing the same empty-key HMAC themselves.
C8 replaces that with the `null`/`"unkeyed"` states above, so no
`identifierHash` is ever computed without real key material. Consequently:

- **Every `identifierHash` value written after this upgrade differs from every
  `identifierHash` value written before it for the same email**, even on a
  deployment that had `AUTH_SECRET` configured all along, because the pepper
  itself is now derived (HKDF over `AUTH_SECRET`, or an explicit
  `AUDIT_IDENTIFIER_PEPPER`) rather than empty.
- This is intentional, not a regression: the pre-upgrade hash was a control
  that had already degraded to zero, and preserving continuity with it would
  have meant preserving the degraded control. Do not attempt to reconcile
  pre- and post-upgrade `identifierHash` values across this boundary — treat
  the upgrade as a hard cutover for any tooling that correlates failures by
  hash.
- If continuity across the upgrade matters for a specific investigation, set
  `AUDIT_IDENTIFIER_PEPPER` explicitly to a value you control and can hold
  constant, rather than relying on `AUTH_SECRET` (which may itself be rotated
  independently).

## `claim`: IdP-controlled provenance and rendering requirement

`claim` is the tenant-claim value the IdP asserted for this sign-in attempt
(`extractTenantClaimValue` in `src/lib/tenant/tenant-claim.ts`), passed
through unchanged except for `sanitizeTenantClaimValue`'s strip of C0/C1
control characters and Unicode bidi/zero-width formatting characters
(`U+200B`–`U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`, `U+FEFF`) — a rider
aimed specifically at visual spoofing of the claim string when displayed to
an operator (a bidi override could make a claim read differently than it is
stored). **That strip does not remove HTML metacharacters.** `claim` is
IdP-controlled input in the same sense any OAuth/SAML profile field is: an IdP
(or, per the `AUTH_TENANT_CLAIM_KEYS` guidance in the main `README.md`, in
some configurations a customer's IdP administrator) chooses what it contains.

**Any future renderer of this field — a dashboard audit-log viewer, a CLI, an
export — MUST treat it as inert text** (React's default text-node escaping,
`textContent`, or equivalent), never as HTML/markup. There is no current
first-party renderer for `AUTH_LOGIN_FAILURE.metadata.claim` — the existing
tenant audit-log viewer renders no failure reason for any
`AuthLoginFailureReason` at all (a pre-existing gap, tracked as SC6 in
`docs/archive/review/sso-tenant-domain-alias-plan.md`) — so this requirement
has no violation to fix today; it is a constraint on whatever implements SC6
or an equivalent viewer next. `scripts/tenant-domain.ts`'s `unmapped` command
prints `claim` to a terminal (`console.log`), which is not an HTML sink and is
out of scope for this requirement.

## `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`

Two blocklists apply to audit metadata, at two different boundaries:

- `METADATA_BLOCKLIST` (`src/lib/audit/audit-logger.ts`) strips a small set of
  crypto-key-shaped keys from metadata **before it is ever written to
  `audit_logs`**. `claim` and `identifierHashScope` are not in this list —
  both are stored as written.
- `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` (`src/lib/http/external-http.ts`) is
  a superset of `METADATA_BLOCKLIST` plus business-PII keys (`email`,
  `reason`, `displayName`, `ip`, `userAgent`, …) applied only at the **egress
  boundary** — when metadata is forwarded to an external sink (tenant
  webhooks, external audit delivery). It does not affect what is stored in
  `audit_logs`, only what leaves the deployment.

`claim` **is** in `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` — stripped before
delivery to any external endpoint. The comment at the call site states the
reasoning directly: `claim` is "the same sensitivity class as `reason`, which
this list already strips; withholding one and forwarding the other would be
an asymmetry decided by omission." `reason` already carries the operator
signal (`tenant_claim_unmapped` etc.); `claim` additionally carries
IdP-controlled content with no defined output-encoding contract at whatever
external system receives the webhook, which the inert-text-rendering
requirement above exists to bound for in-house renderers but cannot bound for
third-party ones.

`identifierHashScope` **is not** in either blocklist — it is delivered
unchanged both to `audit_logs` and to external sinks. This is deliberate, not
an oversight: it is a fixed-vocabulary label (`"tenant" | "global" |
"unkeyed" | null`), not PII and not IdP-controlled free text, and it is the
signal an external SIEM would need to detect the same missing-pepper
misconfiguration described above without needing access to the raw
`identifierHash`.

## References

- `src/lib/audit/auth-failure.ts` — `emitAuthLoginFailure`, `getIdentifierPepper`.
- `src/lib/tenant/tenant-claim.ts` — `extractTenantClaimValue`, `sanitizeTenantClaimValue`.
- `src/lib/http/external-http.ts` — `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`, `sanitizeForExternalDelivery`.
- `src/lib/audit/audit-logger.ts` — `METADATA_BLOCKLIST`.
- `docs/archive/review/sso-tenant-domain-alias-deviation.md` — D-6 (`identifierHashScope` `null` vs `"unkeyed"`).
- `docs/archive/review/sso-tenant-domain-alias-plan.md` — C6, C8, SC6, SC7.
